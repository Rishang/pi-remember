import { dirname, join } from "node:path";
import { SUPPORTED_REMEMBER_COMMIT } from "./plugin.ts";
import { runBounded } from "./runner.ts";
import type { RuntimeStatus } from "./runtime.ts";
import { SUPPORTED_REMEMBER_VERSION, type CapabilityReport } from "./types.ts";

export function runtimeEnvironment(root: string, cwd: string, transcriptPath?: string): Record<string, string | undefined> {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		USER: process.env.USER,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		TZ: process.env.TZ,
		CLAUDE_PLUGIN_ROOT: root,
		CLAUDE_PROJECT_DIR: cwd,
		REMEMBER_TRANSCRIPT_PATH: transcriptPath,
	};
}

/** The installed skill directory is exposed only when the static probe accepts the pinned runtime. */
export function discoverSkillPaths(report: CapabilityReport): string[] {
	return report.disposition === "ready" && report.paths.skill ? [dirname(report.paths.skill)] : [];
}

/** Doctor is upstream's read-only report; it runs whenever a root exists so it can explain a read-only state. */
export async function runDoctor(report: CapabilityReport, cwd: string, signal?: AbortSignal): Promise<string> {
	if (!report.root || !report.tools.bash) {
		return ["Remember doctor is unavailable: no usable installed runtime was found.", ...report.issues.map(({ level, message }) => `${level}: ${message}`)].join("\n");
	}
	const result = await runBounded({
		command: report.tools.bash,
		args: [join(report.root, "scripts", "doctor.sh")],
		cwd,
		env: runtimeEnvironment(report.root, cwd),
		signal,
		timeoutMs: 30_000,
	});
	if (result.ok) return result.stdout.trimEnd();
	return `Remember doctor failed (${result.failure ?? "unknown"}).${result.stderr ? `\n${result.stderr.trimEnd()}` : ""}`;
}

function short(value: string | undefined, length = 12): string {
	return value ? value.slice(0, length) : "unknown";
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

export function formatStatus(report: CapabilityReport, status: Readonly<RuntimeStatus> | undefined, adapterRoot: string): string {
	const lines = [
		"pi-remember status",
		`Supported Remember: ${SUPPORTED_REMEMBER_VERSION} (${short(SUPPORTED_REMEMBER_COMMIT)})`,
		`Installed Remember: ${report.version ?? "unknown"} (${short(report.gitCommitSha)}) via ${report.source ?? "none"}${report.root ? ` at ${report.root}` : ""}`,
		`Hook execution: ${report.disposition}`,
	];
	for (const { level, code, message } of report.issues) lines.push(`  ${level} ${code}: ${message}`);
	if (!status) {
		lines.push("Session: no active coordinator");
	} else {
		lines.push(
			`Session: ${status.phase}, host session ${short(status.hostSessionId)}, epoch ${status.epoch ?? "none"}, projection revision ${status.projectionRevision ?? "none"}`,
			`Queue: dirty ${yesNo(status.dirty)} (generation ${status.dirtyGeneration}, published ${status.publishedGeneration}), queued ${yesNo(status.queued)}, forced save pending ${yesNo(status.forcePending)}, recovery marker pending ${yesNo(status.markerPending)}`,
			`Last hook: ${status.lastHook ?? "none"} -> ${status.lastOutcome ?? "none"}${status.lastError ? ` (${status.lastError})` : ""}`,
		);
	}
	lines.push(`Adapter root: ${adapterRoot}`, "Store path and summarizer route are resolved by upstream Remember; run /remember:doctor for them.");
	return lines.join("\n");
}

export function describeSave(status: Readonly<RuntimeStatus>): { text: string; level: "info" | "warning" } {
	if (status.lastOutcome === "ok" && status.lastHook === "post-tool") return { text: "Remember save completed.", level: "info" };
	if (status.lastOutcome === "read-only" || status.disposition === "read-only") {
		return { text: "Remember is read-only; nothing was saved. Run /remember-status for the reason.", level: "warning" };
	}
	return { text: `Remember save did not complete (${status.lastError ?? status.lastOutcome ?? "unknown"}).`, level: "warning" };
}
