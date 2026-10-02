/**
 * Purpose: Validate command-reference drift verification behavior for the local agent-browser documentation guard.
 * Responsibilities: Ensure metadata-driven token drift detection reports actionable failures for doc omissions and upstream/version mismatches without spawning real binaries in tests.
 * Scope: Unit tests for scripts/verify-command-reference.mjs boundary behavior.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: Tests inject fake help/version/doc inputs and do not depend on local agent-browser runtime availability.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";
import {
  DOC_REQUIRED_TOKENS,
  stripGeneratedCapabilityBaselineBlocks,
  verifyCommandReference,
} from "../scripts/verify-command-reference.mjs";

test("maintainer CLIs reject invalid options through encoded and symlink entrypoints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "piab-cli-"));
  try {
    for (const name of ["agent-browser-capability-baseline.mjs", "agent-browser-target.mjs", "startup-measurement.mjs"]) {
      await copyFile(join("scripts", name), join(directory, name));
    }
    for (const [name, exitCode, diagnostic] of [
      ["verify-command-reference.mjs", 2, /Unknown option/],
      ["check-command-reference-baseline.mjs", 1, /Invalid arguments/],
      ["profile-startup.mjs", 2, /Unknown option/],
    ] as const) {
      const script = join(directory, name);
      const encodedScript = join(directory, `encoded % ${name}`);
      const alias = join(directory, `alias-${name}`);
      await copyFile(join("scripts", name), script);
      await copyFile(script, encodedScript);
      await symlink(script, alias);
      for (const [kind, entrypoint] of [["encoded path", encodedScript], ["symlink", alias]] as const) {
        await t.test(`${name}: ${kind}`, () => {
          const result = spawnSync(process.execPath, [entrypoint, "--invalid-option"], {
            encoding: "utf8",
            timeout: 10_000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, exitCode, `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
          assert.equal(result.stdout, "");
          assert.match(result.stderr, diagnostic);
        });
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function fakeHelpFor(label: string): string {
  return CAPABILITY_BASELINE.upstreamExpectations
    .filter((expectation) => expectation.help === label)
    .map((expectation) => expectation.token)
    .join("\n");
}

function completeDoc(): string {
  return CAPABILITY_BASELINE.docRequiredTokens.join("\n");
}

function fakeRunWithVersion(version: string): (args: readonly string[]) => Promise<string> {
  const helpByCommand = new Map(CAPABILITY_BASELINE.helpCommands.map((command) => [command.args.join(" "), fakeHelpFor(command.label)]));

  return async (args: readonly string[]) => {
    const key = args.join(" ");
    if (key === "--version") return `agent-browser ${version}`;
    const output = helpByCommand.get(key);
    if (output !== undefined) return output;
    throw new Error(`Unexpected command in fake run: ${key}`);
  };
}

test("stripGeneratedCapabilityBaselineBlocks removes generated content before human-token checks", () => {
  const generatedOnlyToken = CAPABILITY_BASELINE.docRequiredTokens[0];
  const content = [
    "human content",
    "<!-- agent-browser-capability-baseline:start capability-token-baseline -->",
    generatedOnlyToken,
    "<!-- agent-browser-capability-baseline:end capability-token-baseline -->",
  ].join("\n");

  assert.equal(stripGeneratedCapabilityBaselineBlocks(content).includes(generatedOnlyToken), false);
});

test("command reference clarifies get selector requirements", () => {
  const doc = stripGeneratedCapabilityBaselineBlocks(readFileSync("docs/COMMAND_REFERENCE.md", "utf8"));

  assert.match(doc, /selector is not optional for DOM getters/);
  assert.match(doc, /`get text\/html\/value\/count <selector>`/);
  assert.match(doc, /`get attr <selector> <name>`/);
  assert.doesNotMatch(doc, /`get <what> \[selector\]` \| `text`, `html`, `value`/);
});

test("verifyCommandReference passes for matching fake upstream and doc content", async () => {
  assert.equal(DOC_REQUIRED_TOKENS.length, CAPABILITY_BASELINE.docRequiredTokens.length, "the verifier must require every baseline doc token");
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion(CAPABILITY_BASELINE.targetVersion),
    readDoc: async () => completeDoc(),
  });

  assert.deepEqual(failures, []);
});

test("verifyCommandReference reports version drift", async () => {
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion("0.25.0"),
    readDoc: async () => completeDoc(),
  });

  assert.ok(failures.some((entry) => entry.includes("agent-browser version drift")));
});

test("verifyCommandReference reports missing upstream token", async () => {
  const run = async (args: readonly string[]) => {
    const key = args.join(" ");
    if (key === "--version") return `agent-browser ${CAPABILITY_BASELINE.targetVersion}`;
    const command = CAPABILITY_BASELINE.helpCommands.find((entry) => entry.args.join(" ") === key);
    if (command) {
      const text = fakeHelpFor(command.label);
      return command.label === "root help" ? text.replace("skills get core --full", "") : text;
    }
    throw new Error(`Unexpected command in fake run: ${key}`);
  };

  const failures = await verifyCommandReference({ cwd: "/repo", run, readDoc: async () => completeDoc() });

  assert.ok(failures.some((entry) => entry.includes("Upstream root help no longer includes expected token")));
});

test("verifyCommandReference reports missing doc token", async () => {
  const docMissingToken = completeDoc().replace("skills list", "");
  const failures = await verifyCommandReference({
    cwd: "/repo",
    run: fakeRunWithVersion(CAPABILITY_BASELINE.targetVersion),
    readDoc: async () => docMissingToken,
  });

  assert.ok(failures.some((entry) => entry.includes("docs/COMMAND_REFERENCE.md is missing human-authored token: skills list")));
});
