import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SUPPORTED_REMEMBER_COMMIT } from "../../../src/plugin.ts";
import { QUALIFICATION_FILE, qualificationReady, readQualificationReport, type QualificationReport } from "../../../src/qualification.ts";
import type { CapabilityReport } from "../../../src/types.ts";
import { storeManifest } from "../../helpers/store-manifest.ts";
import { qualifyInstalledRuntime } from "../harness.ts";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string { const path = mkdtempSync(join(tmpdir(), "pi-remember-parity-test-")); temporary.push(path); return path; }

function capability(root: string): CapabilityReport {
	return {
		disposition: "ready", root: "/runtime", version: "0.30.0", gitCommitSha: SUPPORTED_REMEMBER_COMMIT,
		issues: [], paths: {}, tools: {},
	};
}

function completeReport(): QualificationReport {
	return {
		schemaVersion: 1, version: "0.30.0", commit: SUPPORTED_REMEMBER_COMMIT, providerCalls: 0, activationReady: false,
		scenarios: ["extract-equivalence", "physical-lines-50-51", "response-gates", "cursor-manifest", "hermetic-isolation", "manifest-security", "full-save-alternate-writer", "hook-lifecycle", "forced-session-end", "concurrent-save-locks", "read-only-malformed-config"]
			.map((id) => ({ id, status: "passed" as const, detail: "test" })),
	};
}

test("qualification requires every activation scenario and exact runtime identity", () => {
	const report = completeReport();
	assert.equal(qualificationReady(report), true);
	report.scenarios.at(-1)!.status = "blocked";
	assert.equal(qualificationReady(report), false);
	report.scenarios.at(-1)!.status = "passed";
	report.commit = "wrong";
	assert.equal(qualificationReady(report), false);
});

test("cached reports are private, exact, malformed-safe, and cannot enable incomplete qualification", () => {
	const root = temp();
	const report = completeReport();
	report.scenarios.at(-1)!.status = "blocked";
	writeFileSync(join(root, QUALIFICATION_FILE), JSON.stringify(report), { mode: 0o644 });
	assert.equal(readQualificationReport(root, capability(root)), undefined, "permissive qualification cache fails closed");
	chmodSync(join(root, QUALIFICATION_FILE), 0o600);
	const read = readQualificationReport(root, capability(root));
	assert.equal(read?.activationReady, false);
	assert.equal((readFileSync(join(root, QUALIFICATION_FILE)).length > 0), true);
	writeFileSync(join(root, QUALIFICATION_FILE), "{", { mode: 0o600 });
	assert.equal(readQualificationReport(root, capability(root)), undefined);
});

test("manifest rejects symlinks, hardlinks, and non-private entries", () => {
	const root = temp();
	const outside = join(temp(), "outside");
	writeFileSync(outside, "outside", { mode: 0o600 });
	symlinkSync(outside, join(root, "link"));
	assert.throws(() => storeManifest(root));
	rmSync(join(root, "link"));
	linkSync(outside, join(root, "hard"));
	assert.throws(() => storeManifest(root));
	rmSync(join(root, "hard"));
	writeFileSync(join(root, "public"), "public", { mode: 0o644 });
	assert.throws(() => storeManifest(root));
});

test("missing exact installed runtime skips provider-free qualification without touching real HOME", async () => {
	const root = temp();
	const sentinel = join(root, "real-home-sentinel");
	writeFileSync(sentinel, "unchanged");
	const report = await qualifyInstalledRuntime({
		adapterRoot: join(root, "adapter"),
		probe: { disposition: "read-only", issues: [], paths: {}, tools: {} },
	});
	assert.equal(report.activationReady, false);
	assert.equal(report.scenarios[0].status, "skipped");
	assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
});
