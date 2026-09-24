import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { probeRememberRuntime, SUPPORTED_REMEMBER_COMMIT } from "../../src/plugin.ts";

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
	"scripts/doctor.sh",
	"scripts/run-consolidation.sh",
	"pipeline/__init__.py",
	"pipeline/extract.py",
	"pipeline/haiku.py",
	"pipeline/consolidate.py",
	"skills/remember/SKILL.md",
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

function runtime(root: string, version = "0.30.0", includeConfig = true): void {
	file(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "remember", version }));
	for (const relative of required) {
		file(join(root, relative), relative.startsWith("scripts/") ? "#!/bin/sh\nexit 0\n" : "");
		if (relative.startsWith("scripts/")) chmodSync(join(root, relative), 0o700);
	}
	if (includeConfig) file(join(root, "config.json"), "{}");
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

test("selects the record matching both supported version and commit with deterministic tie breaks", () => {
	const root = temp();
	const supported = join(root, "cache", "remember", "0.30.0-qualified");
	const wrongCommit = join(root, "cache", "remember", "0.30.0-wrong");
	const newer = join(root, "cache", "remember", "9.9.9");
	runtime(supported);
	runtime(wrongCommit);
	runtime(newer, "9.9.9");
	const installed = join(root, "installed_plugins.json");
	records(installed, {
		"remember@z-market": [
			{ installPath: newer, version: "9.9.9", installedAt: "2030-01-01" },
			{ installPath: wrongCommit, version: "0.30.0", gitCommitSha: "wrong", installedAt: "2031-01-01" },
		],
		"remember@a-market": [
			{ installPath: supported, version: "0.30.0", gitCommitSha: SUPPORTED_REMEMBER_COMMIT, installedAt: "2026-01-01" },
		],
	});
	const report = probeRememberRuntime({ installedPluginsPath: installed, env: {}, toolPaths: tools(root) });
	assert.equal(report.disposition, "ready");
	assert.equal(report.root, supported);
	assert.equal(report.source, "installed-record");
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
			{ installPath: zeta, version: "0.30.0", gitCommitSha: SUPPORTED_REMEMBER_COMMIT },
			{ installPath: alpha, version: "0.30.0", gitCommitSha: SUPPORTED_REMEMBER_COMMIT },
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
	assert.ok(report.issues.some(({ code }) => code === "commit-unverified"));
});

test("unsupported version and commit enter read-only mode", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	runtime(plugin, "0.31.0");
	const installed = join(root, "installed.json");
	records(installed, { "remember@market": [{ installPath: plugin, version: "0.31.0", gitCommitSha: "other" }] });
	const report = probeRememberRuntime({ installedPluginsPath: installed, env: {}, toolPaths: tools(root) });
	assert.equal(report.disposition, "read-only");
	assert.ok(report.issues.some(({ code }) => code === "unsupported-version"));
	assert.ok(report.issues.some(({ code }) => code === "unsupported-commit"));
});

test("missing runtime files and tools are reported without throwing", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	file(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "remember", version: "0.30.0" }));
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
			{ installPath: plugin, version: "0.30.0", installedAt: 1 },
		],
	});
	const malformedRecord = probeRememberRuntime({ installedPluginsPath: installed, env: {}, toolPaths: tools(root) });
	assert.equal(malformedRecord.disposition, "read-only");
	assert.ok(malformedRecord.issues.some(({ code }) => code === "installed-record-missing"));
});

test("required paths must be contained regular files with correct modes", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	runtime(plugin);
	chmodSync(join(plugin, "scripts", "doctor.sh"), 0o600);
	const directoryModule = join(plugin, "pipeline", "extract.py");
	rmSync(directoryModule);
	mkdirSync(directoryModule);
	const outside = join(root, "outside.py");
	file(outside, "# outside\n");
	rmSync(join(plugin, "pipeline", "haiku.py"));
	symlinkSync(outside, join(plugin, "pipeline", "haiku.py"));

	const report = probeRememberRuntime({ env: { PI_REMEMBER_PLUGIN_ROOT: plugin }, toolPaths: tools(root) });
	assert.equal(report.disposition, "read-only");
	assert.equal(report.issues.filter(({ code }) => code === "required-script-invalid").length, 1);
	assert.equal(report.issues.filter(({ code }) => code === "required-module-invalid").length, 2);

	const toolDirectory = join(root, "tool-directory");
	mkdirSync(toolDirectory);
	chmodSync(toolDirectory, 0o700);
	const badTool = probeRememberRuntime({
		env: { PI_REMEMBER_PLUGIN_ROOT: plugin },
		toolPaths: { ...tools(root), jq: toolDirectory },
	});
	assert.ok(badTool.issues.some(({ code, message }) => code === "required-tool-missing" && message.endsWith("jq")));
});

test("missing bundled config is a non-fatal explicit warning", () => {
	const root = temp();
	const plugin = join(root, "plugin");
	runtime(plugin, "0.30.0", false);
	const report = probeRememberRuntime({ env: { PI_REMEMBER_PLUGIN_ROOT: plugin }, toolPaths: tools(root) });
	assert.equal(report.disposition, "ready");
	assert.equal(report.verification, "static");
	assert.ok(report.issues.some(({ code }) => code === "static-probe-only"));
	assert.ok(report.issues.some(({ code, level }) => code === "bundled-config-missing" && level === "warning"));
});
