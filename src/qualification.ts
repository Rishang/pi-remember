import { chmodSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_REMEMBER_COMMIT } from "./plugin.ts";
import { SUPPORTED_REMEMBER_VERSION, type CapabilityReport } from "./types.ts";

export const QUALIFICATION_FILE = "qualification-v1.json";
export const REQUIRED_ACTIVATION_SCENARIOS = [
	"extract-equivalence",
	"physical-lines-50-51",
	"response-gates",
	"cursor-manifest",
	"hermetic-isolation",
	"manifest-security",
	"full-save-alternate-writer",
	"hook-lifecycle",
	"forced-session-end",
	"concurrent-save-locks",
	"read-only-malformed-config",
] as const;

export type QualificationScenario = {
	id: string;
	status: "passed" | "blocked" | "skipped" | "failed";
	detail: string;
};

export type QualificationReport = {
	schemaVersion: 1;
	version: string;
	commit: string;
	providerCalls: 0;
	activationReady: boolean;
	scenarios: QualificationScenario[];
};

export function qualificationReady(report: QualificationReport): boolean {
	const statuses = new Map(report.scenarios.map(({ id, status }) => [id, status]));
	return report.version === SUPPORTED_REMEMBER_VERSION
		&& report.commit === SUPPORTED_REMEMBER_COMMIT
		&& report.providerCalls === 0
		&& REQUIRED_ACTIVATION_SCENARIOS.every((id) => statuses.get(id) === "passed");
}

export function readQualificationReport(adapterRoot: string, capability: CapabilityReport): QualificationReport | undefined {
	try {
		const path = join(adapterRoot, QUALIFICATION_FILE);
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 || (info.mode & 0o077) !== 0) return undefined;
		chmodSync(path, 0o600);
		const value = JSON.parse(readFileSync(path, "utf8")) as QualificationReport;
		if (value.schemaVersion !== 1 || value.version !== capability.version || value.commit !== capability.gitCommitSha
			|| value.providerCalls !== 0 || !Array.isArray(value.scenarios)) return undefined;
		if (!value.scenarios.every((item) => item && typeof item.id === "string"
			&& ["passed", "blocked", "skipped", "failed"].includes(item.status) && typeof item.detail === "string")) return undefined;
		value.activationReady = qualificationReady(value);
		return value;
	} catch { return undefined; }
}
