import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { describeSave, discoverSkillPaths, formatStatus, runDoctor } from "../../src/commands.ts";
import type { RuntimeStatus } from "../../src/runtime.ts";
import type { CapabilityReport } from "../../src/types.ts";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
	return {
		disposition: "ready", root: "/fake/remember", version: "0.30.0", issues: [], paths: {}, tools: {},
		...overrides,
	};
}

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
	return {
		phase: "active", disposition: "ready", dirty: false, dirtyGeneration: 3, publishedGeneration: 3,
		queued: false, forcePending: false, markerPending: false, ...overrides,
	};
}

function fakeRoot(doctor: string): string {
	const root = mkdtempSync(join(tmpdir(), "pi-remember-commands-"));
	temporary.push(root);
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts", "doctor.sh"), doctor);
	chmodSync(join(root, "scripts", "doctor.sh"), 0o755);
	return root;
}

test("skill discovery exposes the installed skill directory only for an accepted runtime", () => {
	const skill = "/fake/remember/skills/remember/SKILL.md";
	assert.deepEqual(discoverSkillPaths(report({ paths: { skill } })), ["/fake/remember/skills/remember"]);
	assert.deepEqual(discoverSkillPaths(report({ disposition: "read-only", paths: { skill } })), []);
	assert.deepEqual(discoverSkillPaths(report()), []);
});

test("doctor output is relayed verbatim with plugin root and project dir", async () => {
	const root = fakeRoot('#!/bin/bash\necho "OK root=$CLAUDE_PLUGIN_ROOT"\necho "OK project=$CLAUDE_PROJECT_DIR"\necho "VERDICT: healthy"\n');
	const cwd = mkdtempSync(join(tmpdir(), "pi-remember-cwd-"));
	temporary.push(cwd);
	const output = await runDoctor(report({ root, disposition: "read-only", tools: { bash: "/bin/bash" } }), cwd);
	assert.equal(output, `OK root=${root}\nOK project=${cwd}\nVERDICT: healthy`);
});

test("doctor reports probe issues when no runtime root exists", async () => {
	const output = await runDoctor(report({
		root: undefined, disposition: "read-only",
		issues: [{ level: "error", code: "installed-record-missing", message: "No valid installed Remember record was found." }],
	}), "/tmp");
	assert.match(output, /unavailable/);
	assert.match(output, /error: No valid installed Remember record was found\./);
});

test("doctor failure is reported without inventing a verdict", async () => {
	const root = fakeRoot("#!/bin/bash\necho broken >&2\nexit 3\n");
	const output = await runDoctor(report({ root, tools: { bash: "/bin/bash" } }), root);
	assert.match(output, /^Remember doctor failed \(nonzero\)\./);
	assert.doesNotMatch(output, /VERDICT/);
});

test("status lists versions, issues, and coordinator state", () => {
	const text = formatStatus(
		report({ disposition: "read-only", version: "0.33.0", issues: [{ level: "error", code: "unsupported-version", message: "Remember 0.33.0 is unsupported; expected 0.30.0." }] }),
		status({ dirty: true, dirtyGeneration: 5, epoch: 2, hostSessionId: "a".repeat(64), lastHook: "post-tool", lastOutcome: "ok" }),
		"/adapter",
	);
	assert.match(text, /Supported Remember: 0\.30\.0/);
	assert.match(text, /Installed Remember: 0\.33\.0/);
	assert.match(text, /Hook execution: read-only/);
	assert.match(text, /error unsupported-version/);
	assert.match(text, /dirty yes \(generation 5, published 3\)/);
	assert.match(text, /epoch 2/);
	assert.match(text, /Adapter root: \/adapter/);
	assert.match(formatStatus(report(), undefined, "/adapter"), /no active coordinator/);
});

test("save disposition reflects the actual outcome", () => {
	assert.deepEqual(describeSave(status({ lastHook: "post-tool", lastOutcome: "ok" })), { text: "Remember save completed.", level: "info" });
	assert.equal(describeSave(status({ disposition: "read-only", lastOutcome: "read-only" })).level, "warning");
	assert.match(describeSave(status({ lastOutcome: "error", lastError: "timeout" })).text, /did not complete \(timeout\)/);
});
