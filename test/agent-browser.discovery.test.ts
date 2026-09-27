import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import agentBrowserExtension from "../extensions/agent-browser/index.js";
import { PROJECT_RULE_PROMPT } from "../extensions/agent-browser/lib/playbook.js";
import { AGENT_BROWSER_TOOL_INVENTORY } from "../extensions/agent-browser/lib/tool-surface.js";
import { createExtensionHarness, runExtensionEventResults, runExtensionEvent, withPatchedEnv } from "./helpers/agent-browser-harness.js";

test("generic prompts prepare browser instructions only for their own deferred section", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	for (const [sectionTools, expected] of [
		[undefined, false], [{}, false], [{ another_extension: ["another_tool"] }, false],
		[Object.create({ agent_browser: ["agent_browser"] }), false],
		[{ agent_browser: [] }, true], [{ agent_browser: ["agent_browser"] }, true],
	] as const) {
		const event = { prompt: "Please continue.", systemPrompt: "Opaque host prompt", systemPromptOptions: { sections: {} as Record<string, string>, sectionTools } };
		assert.deepEqual(await runExtensionEventResults(harness.handlers, "before_agent_start", event, harness.ctx), []);
		assert.equal(event.systemPrompt, "Opaque host prompt");
		assert.equal(event.systemPromptOptions.sections.agent_browser, expected ? PROJECT_RULE_PROMPT : undefined);
	}
	const event = { prompt: "Open https://example.com and take a snapshot.", systemPromptOptions: { sections: {} as Record<string, string> } };
	await runExtensionEvent(harness.handlers, "before_agent_start", event, harness.ctx);
	assert.equal(event.systemPromptOptions.sections.agent_browser, PROJECT_RULE_PROMPT, "official hosts retain keyword-triggered guidance");
});

test("registration owns entry and advanced discovery metadata including late trusted web search", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-discovery-"));
	try {
		await withPatchedEnv({ HOME: join(root, "home"), PI_AGENT_BROWSER_CONFIG: undefined, EXA_API_KEY: undefined, BRAVE_API_KEY: undefined }, async () => {
			const loader = new DefaultResourceLoader({ agentDir: root, cwd: root, noContextFiles: true, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [agentBrowserExtension] });
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, credentials: new InMemoryCredentialStore(), modelsPath: null });
			const { session } = await createAgentSession({ cwd: root, modelRuntime, resourceLoader: loader, noTools: "builtin", settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(root) });
			try {
				const discovery = (name: string) => (session.getToolDefinition(name) as unknown as { discovery: { group: { name: string; description: string; sections: readonly string[] }; role: string } })?.discovery;
				const group = discovery("agent_browser")?.group;
				assert.equal(group?.name, "browser");
				assert.deepEqual(group?.sections, ["agent_browser"]);
				assert.match(group?.description ?? "", /browser|browse/i);
				for (const name of ["agent_browser", "agent_browser_code", "agent_browser_tools"]) {
					assert.equal(discovery(name)?.role, "entry", name);
					assert.equal(discovery(name)?.group, group);
				}
				for (const { name } of Object.values(AGENT_BROWSER_TOOL_INVENTORY)) {
					assert.equal(discovery(name)?.role, "advanced", name);
					assert.equal(discovery(name)?.group, group);
				}
				assert.equal(session.getToolDefinition("agent_browser_web_search"), undefined);
				const configPath = join(root, ".pi/config/pi-agent-browser-native/config.json");
				await mkdir(dirname(configPath), { recursive: true });
				await writeFile(configPath, JSON.stringify({ version: 1, webSearch: { braveApiKey: "test-only-key" }, browser: { executablePath: "/tmp/project-browser" } }));
				await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
				assert.equal(discovery("agent_browser_web_search")?.role, "entry");
				assert.equal(discovery("agent_browser_web_search")?.group, group);
				const harness = createExtensionHarness({ cwd: root });
				const event = { prompt: "Please continue.", systemPromptOptions: { sections: {} as Record<string, string>, sectionTools: { agent_browser: [] } } };
				await runExtensionEvent(harness.handlers, "before_agent_start", event, harness.ctx);
				assert.ok(event.systemPromptOptions.sections.agent_browser?.startsWith(PROJECT_RULE_PROMPT));
				assert.match(event.systemPromptOptions.sections.agent_browser, /\/tmp\/project-browser/);
				await withPatchedEnv({ BRAVE_API_KEY: "startup-test-key" }, async () => {
					await session.reload();
					assert.deepEqual(discovery("agent_browser_web_search"), { group, role: "entry" });
				});
			} finally { session.dispose(); }
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});
