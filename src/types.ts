export const SUPPORTED_REMEMBER_VERSION = "0.30.0";

export type RuntimeDisposition = "ready" | "read-only";
export type CapabilityLevel = "error" | "warning";

export interface CapabilityIssue {
	level: CapabilityLevel;
	code: string;
	message: string;
}

export interface RememberManifest {
	name?: string;
	version?: string;
	repository?: string;
	[key: string]: unknown;
}

export interface InstalledRecord {
	installPath?: string;
	version?: string;
	gitCommitSha?: string;
	installedAt?: string;
	lastUpdated?: string;
}

export interface CapabilityReport {
	disposition: RuntimeDisposition;
	root?: string;
	manifest?: RememberManifest;
	version?: string;
	gitCommitSha?: string;
	source?: "override" | "installed-record";
	issues: CapabilityIssue[];
	paths: {
		manifest?: string;
		skill?: string;
	};
	tools: Record<string, string | undefined>;
	/** This phase verifies static prerequisites only; behavioral parity is a later gate. */
	verification: "static";
}

export interface ProbeOptions {
	env?: Readonly<Record<string, string | undefined>>;
	installedPluginsPath?: string;
	homeDir?: string;
	supportedVersion?: string;
	supportedCommit?: string;
	toolPaths?: Readonly<Record<string, string | undefined>>;
}

export type RunFailure = "nonzero" | "spawn" | "timeout" | "cancelled" | "input-limit" | "output-limit";

export type HostEventName = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "SessionEnd";

export interface HostEvent {
	event: HostEventName;
	cwd: string;
	sessionId: string;
	hostSessionId: string;
	transcriptPath: string;
	source?: string;
	reason?: string;
	generation: number;
	force: boolean;
}

export type HookDisposition = "ok" | "read-only" | RunFailure;

export interface RunOptions {
	command: string;
	args?: readonly string[];
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	stdin?: string;
	/** Values to redact from captured stdout/stderr, including argv/stdin secrets. */
	sensitiveValues?: readonly string[];
	/** Environment names whose values must be redacted regardless of naming heuristic. */
	sensitiveEnvNames?: readonly string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	killGraceMs?: number;
	maxStdinBytes?: number;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
}

export interface RunResult {
	ok: boolean;
	failure?: RunFailure;
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	outputLimited: boolean;
}

export interface HookOutput {
	additionalContext: string;
	systemMessage: string;
	diagnostics: string;
	format: "empty" | "plain" | "json";
}
