import { createHash } from "node:crypto";
import {
	chmodSync,
	linkSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeRememberRuntime, SUPPORTED_REMEMBER_COMMIT } from "../../src/plugin.ts";
import { projectBranch, type PiBranchEntry } from "../../src/projection.ts";
import { QUALIFICATION_FILE, qualificationReady, type QualificationReport, type QualificationScenario } from "../../src/qualification.ts";
import { runBounded } from "../../src/runner.ts";
import { SUPPORTED_REMEMBER_VERSION, type CapabilityReport, type RunResult } from "../../src/types.ts";
import { comparableManifest, storeManifest } from "../helpers/store-manifest.ts";

export type HarnessOptions = {
	adapterRoot?: string;
	keepSandbox?: boolean;
	probe?: CapabilityReport;
};

type Sandbox = {
	root: string;
	home: string;
	config: string;
	project: string;
	adapter: string;
	temporary: string;
	fakeBin: string;
	providerMarker: string;
};

type ExtractResult = {
	exchanges: string;
	position: number;
	human_count: number;
	assistant_count: number;
	envelope: string;
};

const BLOCKED: QualificationScenario[] = [
	{ id: "full-save-alternate-writer", status: "blocked", detail: "Full save and A/B/C alternate-writer qualification requires an upstream summarizer boundary; no provider was invoked." },
	{ id: "hook-lifecycle", status: "blocked", detail: "SessionStart and SessionEnd launch detached recovery, maintenance, or save work; provider-free interception is not yet proven complete." },
	{ id: "forced-session-end", status: "blocked", detail: "Forced SessionEnd is deferred with hook lifecycle because the installed hook backgrounds save-session." },
	{ id: "concurrent-save-locks", status: "blocked", detail: "Canonical save.lock contention is deferred until the complete save pipeline can use a deterministic fake summarizer." },
	{ id: "read-only-malformed-config", status: "blocked", detail: "Static unit coverage exists, but installed-runtime config/store behavior is not an activation scenario yet." },
];

function scenario(id: string, detail: string): QualificationScenario {
	return { id, status: "passed", detail };
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function sandbox(adapterRoot?: string): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pi-remember-parity-"));
	chmodSync(root, 0o700);
	const value = {
		root,
		home: join(root, "isolated-home"),
		config: join(root, "isolated-claude-config"),
		project: join(root, "project-ユニコード-long-path"),
		adapter: adapterRoot ? realpathSync(adapterRoot) : join(root, "adapter"),
		temporary: join(root, "tmp"),
		fakeBin: join(root, "fake-bin"),
		providerMarker: join(root, "provider-invoked"),
	};
	for (const path of [value.home, value.config, value.project, value.adapter, value.temporary, value.fakeBin]) privateDirectory(path);
	for (const name of ["claude", "codex", "git"]) {
		const path = join(value.fakeBin, name);
		writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${name} >> '${value.providerMarker}'\nexit 97\n`, { mode: 0o700 });
		chmodSync(path, 0o700);
	}
	return value;
}

function childEnvironment(box: Sandbox, runtimeRoot: string, rememberDir: string): Record<string, string> {
	return {
		HOME: box.home,
		CLAUDE_CONFIG_DIR: box.config,
		CLAUDE_PROJECT_DIR: box.project,
		REMEMBER_DIR: rememberDir,
		TMPDIR: box.temporary,
		PATH: box.fakeBin,
		PYTHONPATH: runtimeRoot,
		PYTHONUTF8: "1",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TZ: "UTC",
		REMEMBER_SUMMARIZER: "claude",
		REMEMBER_SUMMARIZER_FALLBACK: "",
	};
}

function pythonInvocation(report: CapabilityReport, args: readonly string[]): { command: string; args: string[] } {
	if (!report.tools.bash || !report.tools.python3) throw new Error("qualified Bash/Python runtime unavailable");
	return {
		command: report.tools.bash,
		args: ["-c", 'umask 077; exec "$0" "$@"', report.tools.python3, ...args],
	};
}

async function python(report: CapabilityReport, box: Sandbox, rememberDir: string, args: readonly string[], stdin = ""): Promise<RunResult> {
	if (!report.root) throw new Error("qualified runtime unavailable");
	const invocation = pythonInvocation(report, args);
	return runBounded({
		command: invocation.command,
		args: invocation.args,
		cwd: report.root,
		env: childEnvironment(box, report.root, rememberDir),
		stdin,
		timeoutMs: 10_000,
		killGraceMs: 250,
		maxStdinBytes: 256_000,
		maxStdoutBytes: 512_000,
		maxStderrBytes: 128_000,
		sensitiveValues: [box.root, process.env.HOME ?? ""],
	});
}

function branch(lines: number): PiBranchEntry[] {
	const entries: PiBranchEntry[] = [
		{ type: "message", id: "entry-0", parentId: null, message: { role: "user", content: "fact alpha" } },
		{ type: "message", id: "entry-1", parentId: "entry-0", message: { role: "assistant", content: [{ type: "text", text: "ack alpha" }] } },
	];
	for (let index = 2; index < lines; index++) entries.push({ type: "progress", id: `entry-${index}`, parentId: `entry-${index - 1}` });
	return entries;
}

function oracleLines(lines: number): string {
	const records: Array<Record<string, unknown>> = [
		{ type: "user", message: { content: [{ type: "text", text: "fact alpha" }] } },
		{ type: "assistant", message: { content: [{ type: "text", text: "ack alpha" }] } },
	];
	for (let index = 2; index < lines; index++) records.push({ type: "progress", source: "pi-progress" });
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function extract(report: CapabilityReport, box: Sandbox, transcript: string, rememberDir: string): Promise<ExtractResult> {
	const envPath = childEnvironment(box, report.root!, rememberDir);
	envPath.REMEMBER_TRANSCRIPT_PATH = transcript;
	const invocation = pythonInvocation(report, ["-m", "pipeline.extract", "--session", "abc123", "--project-dir", box.project, "--json"]);
	const result = await runBounded({
		command: invocation.command,
		args: invocation.args,
		cwd: report.root!, env: envPath, timeoutMs: 10_000, maxStdoutBytes: 512_000, maxStderrBytes: 128_000,
		sensitiveValues: [box.root, process.env.HOME ?? ""],
	});
	if (!result.ok) throw new Error("installed extractor failed");
	return JSON.parse(result.stdout) as ExtractResult;
}

function normalizedExtract(value: ExtractResult): unknown {
	return {
		exchanges: value.exchanges.replace(/^Session: .*$/m, "Session: <SESSION>"),
		position: value.position,
		human_count: value.human_count,
		assistant_count: value.assistant_count,
		envelope: value.envelope,
	};
}

async function runExtractScenarios(report: CapabilityReport, box: Sandbox): Promise<QualificationScenario[]> {
	const scenarios: QualificationScenario[] = [];
	for (const lines of [3, 50, 51]) {
		const oracle = join(box.root, `oracle-${lines}.jsonl`);
		writeFileSync(oracle, oracleLines(lines), { mode: 0o600 });
		const candidateRoot = join(box.root, `candidate-${lines}`);
		privateDirectory(candidateRoot);
		const projected = await projectBranch({ root: candidateRoot, sessionId: `candidate-${lines}`, branch: branch(lines) });
		if (!projected.ok || !projected.projectionPath) throw new Error("candidate projection failed");
		const oracleResult = await extract(report, box, oracle, join(box.root, `oracle-store-${lines}`));
		const candidateResult = await extract(report, box, projected.projectionPath, join(box.root, `candidate-store-${lines}`));
		if (JSON.stringify(normalizedExtract(oracleResult)) !== JSON.stringify(normalizedExtract(candidateResult))) throw new Error(`extract mismatch at ${lines} lines`);
		if (oracleResult.position !== lines) throw new Error(`physical position mismatch at ${lines} lines`);
	}
	scenarios.push(scenario("extract-equivalence", "Installed extractor produced identical semantic exchanges for independently authored oracle and Pi projection transcripts."));
	scenarios.push(scenario("physical-lines-50-51", "Installed extractor preserved exact physical positions at 50 and 51 lines without invoking a summarizer."));
	scenarios.push(scenario("non-ascii-long-path", "Extraction and projection succeeded under an isolated non-ASCII project path."));
	return scenarios;
}

function vars(stdout: string): Record<string, string> {
	return Object.fromEntries(stdout.trim().split("\n").map((line) => {
		const split = line.indexOf("=");
		return [line.slice(0, split), line.slice(split + 1)];
	}));
}

async function runResponseGates(report: CapabilityReport, box: Sandbox): Promise<QualificationScenario> {
	for (const [input, expectedSkip, expectedRejected] of [
		[JSON.stringify({ result: "SKIP no durable fact" }), "true", "false"],
		[JSON.stringify({ result: "I cannot help with that request." }), "true", "true"],
	] as const) {
		const result = await python(report, box, join(box.root, "response-store"), ["-m", "pipeline.shell", "parse-haiku"], input);
		if (!result.ok) throw new Error("response gate failed");
		const parsed = vars(result.stdout);
		if (parsed.IS_SKIP !== expectedSkip || parsed.IS_REJECTED !== expectedRejected || parsed.PROVIDER !== "claude") throw new Error("response gate disposition mismatch");
	}
	const malformed = await python(report, box, join(box.root, "response-store"), ["-m", "pipeline.shell", "parse-haiku"], "{bad");
	if (malformed.ok || malformed.failure !== "nonzero") throw new Error("malformed response was accepted");
	return scenario("response-gates", "Installed response parser distinguished SKIP, rejection, and malformed JSON using synthetic local input only.");
}

async function savePosition(report: CapabilityReport, box: Sandbox, store: string): Promise<void> {
	privateDirectory(join(store, "tmp"));
	const result = await python(report, box, store, [
		"-m", "pipeline.shell", "save-position", join(store, "tmp", "last-save.json"), "abc123", "51", "claude-code",
	]);
	if (!result.ok) throw new Error("cursor writer failed");
}

async function runCursorManifest(report: CapabilityReport, box: Sandbox): Promise<QualificationScenario[]> {
	const oracle = join(box.root, "oracle-store");
	const candidate = join(box.root, "candidate-store");
	for (const store of [oracle, candidate]) {
		privateDirectory(store);
		writeFileSync(join(store, "unknown.keep"), "preserve-me\n", { mode: 0o600 });
		await savePosition(report, box, store);
	}
	const left = comparableManifest(storeManifest(oracle, [box.root]));
	const right = comparableManifest(storeManifest(candidate, [box.root]));
	if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error("cursor store manifests differ");
	if (readFileSync(join(candidate, "unknown.keep"), "utf8") !== "preserve-me\n") throw new Error("unknown file changed");

	const unsafe = join(box.root, "unsafe-store");
	privateDirectory(unsafe);
	const outside = join(box.root, "outside");
	writeFileSync(outside, "outside", { mode: 0o600 });
	symlinkSync(outside, join(unsafe, "link"));
	let rejectedLink = false;
	try { storeManifest(unsafe); } catch { rejectedLink = true; }
	rmSync(join(unsafe, "link"));
	linkSync(outside, join(unsafe, "hard"));
	let rejectedHardlink = false;
	try { storeManifest(unsafe); } catch { rejectedHardlink = true; }
	if (!rejectedLink || !rejectedHardlink) throw new Error("unsafe manifest entry accepted");
	return [
		scenario("cursor-manifest", "Installed cursor writer produced identical owner-only manifests and preserved an unknown file."),
		scenario("manifest-security", "Manifest builder rejected symlink and hardlink entries and retained exact modes, sizes, hashes, filenames, and semantic sections."),
	];
}

function writeQualification(root: string, report: QualificationReport): void {
	privateDirectory(root);
	const target = join(root, QUALIFICATION_FILE);
	const temporary = join(root, `.${QUALIFICATION_FILE}.${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, target);
	chmodSync(target, 0o600);
}

function unavailable(probe: CapabilityReport): QualificationReport {
	const exact = probe.version === SUPPORTED_REMEMBER_VERSION && probe.gitCommitSha === SUPPORTED_REMEMBER_COMMIT;
	return {
		schemaVersion: 1,
		version: probe.version ?? "",
		commit: probe.gitCommitSha ?? "",
		providerCalls: 0,
		activationReady: false,
		scenarios: [{ id: "exact-runtime", status: "skipped", detail: exact ? "Static runtime prerequisites failed." : "Exact supported runtime version and commit are unavailable." }, ...BLOCKED],
	};
}

function providerFreePrerequisites(capability: CapabilityReport): boolean {
	return capability.version === SUPPORTED_REMEMBER_VERSION
		&& capability.gitCommitSha === SUPPORTED_REMEMBER_COMMIT
		&& !!capability.root
		&& !!capability.tools.python3
		&& !!capability.tools.bash
		&& !capability.issues.some(({ code }) => code === "manifest-invalid" || code === "manifest-name"
			|| code === "unsupported-version" || code === "unsupported-commit" || code === "required-module-invalid");
}

/** Provider-free installed-runtime qualification. It never runs from extension import or lifecycle events. */
export async function qualifyInstalledRuntime(options: HarnessOptions = {}): Promise<QualificationReport> {
	const capability = options.probe ?? probeRememberRuntime();
	if (!providerFreePrerequisites(capability)) {
		const report = unavailable(capability);
		if (options.adapterRoot) writeQualification(options.adapterRoot, report);
		return report;
	}
	const box = sandbox(options.adapterRoot);
	try {
		const scenarios: QualificationScenario[] = [
			scenario("exact-runtime", "Resolver selected exact Remember 0.30.0 and qualified commit; provider-free Python prerequisites passed."),
			...await runExtractScenarios(capability, box),
			await runResponseGates(capability, box),
			...await runCursorManifest(capability, box),
			scenario("hermetic-isolation", "Every child used isolated HOME, CLAUDE_CONFIG_DIR, TMPDIR, project, store, and fake-provider PATH; no provider executable ran."),
			...BLOCKED,
		];
		if (readFileIfExists(box.providerMarker)) throw new Error("provider executable invoked");
		const report: QualificationReport = {
			schemaVersion: 1,
			version: capability.version,
			commit: capability.gitCommitSha,
			providerCalls: 0,
			activationReady: false,
			scenarios,
		};
		report.activationReady = qualificationReady(report);
		writeQualification(box.adapter, report);
		return report;
	} catch {
		const report: QualificationReport = {
			schemaVersion: 1,
			version: capability.version,
			commit: capability.gitCommitSha,
			providerCalls: 0,
			activationReady: false,
			scenarios: [{ id: "provider-free-harness", status: "failed", detail: "A provider-free qualification scenario failed; details intentionally omitted from the cached report." }, ...BLOCKED],
		};
		writeQualification(box.adapter, report);
		return report;
	} finally {
		if (!options.keepSandbox) rmSync(box.root, { recursive: true, force: true });
	}
}

function readFileIfExists(path: string): string {
	try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function reportDigest(report: QualificationReport): string {
	return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

async function main(): Promise<void> {
	const outputIndex = process.argv.indexOf("--output-root");
	const outputRoot = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
	const report = await qualifyInstalledRuntime({ adapterRoot: outputRoot });
	process.stdout.write(`${JSON.stringify({ ...report, reportDigest: reportDigest(report) }, null, 2)}\n`);
	process.exitCode = report.scenarios.some(({ status }) => status === "failed") ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await main();
