import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import pathKey from "path-key";
import which from "which";

/** Bypass only upstream's optimized npm CMD shim: cmd.exe loses literal CR/LF.
 * Keep which/path-key aligned with cross-spawn's public dependency versions.
 * Unknown/custom launchers (including other npm layouts) stay on cross-spawn.
 */
export function resolveWindowsStockLauncher(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	if (process.platform !== "win32" || !isMainThread) return undefined;
	// which reads parent PATHEXT; cmd.exe reads the child's. Node also handles
	// duplicate case-insensitive environment keys differently from path-key.
	// In those ambiguous cases, keep the original transport and its selection.
	const values = (name: string) => Object.entries(env)
		.filter(([key, value]) => key.toUpperCase() === name && value !== undefined).map(([, value]) => value);
	const paths = values("PATH"), extensions = values("PATHEXT");
	if (paths.length !== 1 || !paths[0] || extensions.length !== 1 || extensions[0] !== process.env.PATHEXT
		|| values("NODEFAULTCURRENTDIRECTORYINEXEPATH").length) return undefined;
	// A custom COMSPEC can implement different command selection/semantics.
	// Compare filesystem identity, not short/long Windows path spellings.
	try {
		if (!process.env.comspec || !isAbsolute(process.env.comspec) || !process.env.SystemRoot) return undefined;
		const shell = statSync(process.env.comspec, { bigint: true });
		const native = statSync(join(process.env.SystemRoot, "System32", "cmd.exe"), { bigint: true });
		if (shell.dev !== native.dev || shell.ino !== native.ino) return undefined;
	} catch { return undefined; }
	const previousCwd = process.cwd();
	let selected: string | null;
	try {
		// which 2 has no cwd option. Like cross-spawn, change cwd only during
		// synchronous resolution, restoring it before any caller can await.
		process.chdir(cwd);
		selected = which.sync("agent-browser", { path: env[pathKey({ env })], nothrow: true });
	} catch {
		return undefined;
	} finally {
		process.chdir(previousCwd);
	}
	// cross-spawn's second (extensionless) lookup cannot select this CMD shim.
	if (!selected || !selected.toLowerCase().endsWith(".cmd")) return undefined;
	try {
		// which can return a relative PATH result; interpret it in the child cwd.
		const absoluteShim = resolve(cwd, selected);
		if (statSync(absoluteShim).size > 512) return undefined;
		const text = readFileSync(absoluteShim, "utf8");
		if (!/^@ECHO off\r?\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64\.exe" %\*(?:\r?\n)?(?![\s\S])/.test(text)) return undefined;
		const packageRoot = join(dirname(absoluteShim), "node_modules", "agent-browser");
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		if (manifest.name !== "agent-browser" || !["bin/agent-browser.js", "./bin/agent-browser.js"].includes(manifest.bin?.["agent-browser"])) return undefined;
		const binary = join(packageRoot, "bin", "agent-browser-win32-x64.exe");
		return statSync(binary).isFile() ? binary : undefined;
	} catch {
		return undefined;
	}
}
