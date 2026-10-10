import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { probeRememberRuntime } from "../../src/plugin.ts";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const required = [
	"scripts/session-start-hook.sh",
	"scripts/user-prompt-hook.sh",
	"scripts/post-tool-hook.sh",
	"scripts/session-end-hook.sh",
	"scripts/save-session.sh",
];

function temp(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-remember-plugin-"));
	temporary.push(path);
	return path;
}

function file(path: string, content = ""): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function runtime(root: string, version = "0.33.0", includeSkill = true): void {
	file(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "remember", version }));
	// Upstream ships some scripts without the execute bit; hooks run as `bash <script>`.
	for (const relative of required) file(join(root, relative), "#!/bin/bash\nexit 0\n");
	if (includeSkill) file(join(root, "skills", "remember", "SKILL.md"), "");
}

function tools(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of ["bash", "python3", "jq"]) {
		const path = join(root, "bin", name);
		file(path, "#!/bin/sh\nexit 0\n");
		chmodSync(path, 0o700);
		result[name] = path;
	}
	return result;
}

function records(path: string, plugins: Record<string, unknown>): void {
	file(path, JSON.stringify({ version: 2, plugins }));
}

test("selects the most recently updated install of any version, like Claude Code", () => {
	const root = temp();
	const older = join(root, "cache", "remember", "0.30.0");
	const newer = join(root, "cache", "remember", "0.33.0");
	runtime(older, "0.30.0");
	runtime(newer, "0.33.0");
	const installed = join(root, "installed_plugins.json");
	records(installed, {
		"remember@a-market": [{ installPath: older, version: "0.30.0", installedAt: "2026-01-01", lastUpdated: "2026-02-01" }],
		"remember@z-market": [{ installPath: newer, version: "0.33.0", gitCommitSha: "a5cc87c", installedAt: "2025-01-01", lastUpdated: "2026-09-23" }],
	});
	const report = probeRememberRuntime({ installedPluginsPath: installed, env: {}, toolPaths: tools(root) });
	assert.equal(report.disposition, "ready");
	assert.equal(report.root, newer);
	assert.equal(report.version, "0.33.0");
	assert.equal(report.gitCommitSha, "a5cc87c");
	assert.equal(report.source, "installed-record");
	assert.deepEqual(report.issues, []);
});

test("record selection has a stable total order when metadata ties", () => {
	const root = temp();
	const alpha = join(root, "alpha");
	const zeta = join(root, "zeta");
	runtime(alpha);
	runtime(zeta);
	const installed = join(root, "installed-tie.json");
	records(installed, {
		"remember@market": [
			{ installPath: zeta, version: "0.33.0" },
			{ installPath: alpha, version: "0.33.0" },
		],
	});
	const report = probeRememberRuntime({ installedPluginsPath: installed, env: {}, toolPaths: tools(root) });
	assert.equal(report.root, alpha);
});

test("override bypasses records but still validates manifest and capabilities", () => {
	const root = temp();
	const plugin = join(root, "explicit");
	runtime(plugin);
	const report = probeRememberRuntime({
		env: { PI_REMEMBER_PLUGIN_ROOT: plugin },
		installedPluginsPath: join(root, "missing.json"),
		toolPaths: tools(root),
	});
	assert.equal(report.disposition, "ready");
	assert.equal(report.source, "override");
});

test("missing runtime files and tools are reported without throwing", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	file(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "remember", version: "0.33.0" }));
	const report = probeRememberRuntime({
		env: { PI_REMEMBER_PLUGIN_ROOT: plugin },
		toolPaths: { bash: "", python3: "", jq: "" },
	});
	assert.equal(report.disposition, "read-only");
	assert.ok(report.issues.some(({ code }) => code === "required-script-invalid"));
	assert.equal(report.issues.filter(({ code }) => code === "required-tool-missing").length, 3);
});

test("malformed manifest and malformed installation records are safe read-only results", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	file(join(plugin, ".claude-plugin", "plugin.json"), "{");
	const malformedManifest = probeRememberRuntime({
		env: { PI_REMEMBER_PLUGIN_ROOT: plugin },
		toolPaths: tools(root),
	});
	assert.equal(malformedManifest.disposition, "read-only");
	assert.ok(malformedManifest.issues.some(({ code }) => code === "manifest-invalid"));

	const installed = join(root, "installed.json");
	records(installed, {
		"remember@market": [
			null,
			"bad",
			4,
			{ installPath: plugin, version: "0.33.0", installedAt: 1 },
		],
	});
	const malformedRecord = probeRememberRuntime({ installedPluginsPath: installed, env: {}, toolPaths: tools(root) });
	assert.equal(malformedRecord.disposition, "read-only");
	assert.ok(malformedRecord.issues.some(({ code }) => code === "installed-record-missing"));
});

test("required scripts must be contained regular files but need no execute bit", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	runtime(plugin);
	chmodSync(join(plugin, "scripts", "post-tool-hook.sh"), 0o644);
	assert.equal(probeRememberRuntime({ env: { PI_REMEMBER_PLUGIN_ROOT: plugin }, toolPaths: tools(root) }).disposition, "ready");

	const directoryScript = join(plugin, "scripts", "save-session.sh");
	rmSync(directoryScript);
	mkdirSync(directoryScript);
	const outside = join(root, "outside.sh");
	file(outside, "#!/bin/bash\n");
	rmSync(join(plugin, "scripts", "session-end-hook.sh"));
	symlinkSync(outside, join(plugin, "scripts", "session-end-hook.sh"));

	const report = probeRememberRuntime({ env: { PI_REMEMBER_PLUGIN_ROOT: plugin }, toolPaths: tools(root) });
	assert.equal(report.disposition, "read-only");
	assert.equal(report.issues.filter(({ code }) => code === "required-script-invalid").length, 2);

	const toolDirectory = join(root, "tool-directory");
	mkdirSync(toolDirectory);
	chmodSync(toolDirectory, 0o700);
	const badTool = probeRememberRuntime({
		env: { PI_REMEMBER_PLUGIN_ROOT: plugin },
		toolPaths: { ...tools(root), jq: toolDirectory },
	});
	assert.ok(badTool.issues.some(({ code, message }) => code === "required-tool-missing" && message.endsWith("jq")));
});

test("a missing skill only disables /skill:remember", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	runtime(plugin, "0.33.0", false);
	const report = probeRememberRuntime({ env: { PI_REMEMBER_PLUGIN_ROOT: plugin }, toolPaths: tools(root) });
	assert.equal(report.disposition, "ready");
	assert.equal(report.paths.skill, undefined);
	assert.ok(report.issues.some(({ code, level }) => code === "skill-missing" && level === "warning"));
});
