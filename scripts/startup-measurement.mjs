import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const DIRECT_IMPORT_BUDGET_MS = 250;

/**
 * One fresh Node import plus synchronous extension-factory registration.
 * @typedef {{ events: number, importMs: number, tools: string[], totalMs: number }} StartupMeasurement
 */

/**
 * @param {string} entrypoint
 * @param {string} [cwd]
 * @returns {Promise<StartupMeasurement>}
 */
export async function measureColdStartup(entrypoint, cwd = process.cwd()) {
	const script = `
const start = performance.now();
const extension = await import(${JSON.stringify(entrypoint)});
const imported = performance.now();
const registeredEvents = [];
const pi = {
  events: { on(...args) { registeredEvents.push(args); } },
  tools: [],
  on(...args) { registeredEvents.push(args); },
  registerTool(tool) { this.tools.push(tool.name); }
};
extension.default(pi);
const registered = performance.now();
console.log(JSON.stringify({
  events: registeredEvents.length,
  importMs: imported - start,
  tools: pi.tools,
  totalMs: registered - start
}));
`;
	const result = await execFile(process.execPath, ["--input-type=module", "-e", script], {
		cwd,
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	});
	return JSON.parse(result.stdout.trim());
}
