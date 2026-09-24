import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { HookOutput, RunFailure, RunOptions, RunResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_INPUT_BYTES = 1_000_000;
const DEFAULT_OUTPUT_BYTES = 256_000;
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH|PRIVATE_KEY|COOKIE|ACCESS_KEY)/i;
type TerminationCause = Extract<RunFailure, "timeout" | "cancelled" | "output-limit">;

type Capture = {
	decoder: StringDecoder;
	text: string;
	total: number;
	limit: number;
	truncated: boolean;
};

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function publicSpawnError(error: unknown): string {
	if (!error || typeof error !== "object") return "process spawn failed";
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return code ? `process spawn failed (${code})` : "process spawn failed";
}

function sensitiveValues(options: RunOptions): string[] {
	const explicitNames = new Set(options.sensitiveEnvNames ?? []);
	const values = new Set(
		(options.sensitiveValues ?? []).filter((value) => value.length > 0),
	);
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (typeof value !== "string" || value.length === 0) continue;
		if (explicitNames.has(key) || (SECRET_NAME.test(key) && value.length >= 4)) values.add(value);
	}
	return [...values];
}

function redact(text: string, values: readonly string[]): string {
	let redacted = text;
	for (const value of values) redacted = redacted.split(value).join("[REDACTED]");
	return redacted;
}

function createCapture(limit: number): Capture {
	return { decoder: new StringDecoder("utf8"), text: "", total: 0, limit, truncated: false };
}

function captureChunk(capture: Capture, chunk: Buffer | string): boolean {
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	const remaining = Math.max(0, capture.limit - Math.min(capture.total, capture.limit));
	capture.total += buffer.length;
	if (remaining > 0) capture.text += capture.decoder.write(buffer.subarray(0, remaining));
	if (buffer.length > remaining) capture.truncated = true;
	return capture.truncated;
}

function captureText(capture: Capture): string {
	// Do not flush an incomplete trailing UTF-8 sequence when a byte cap cut it.
	return capture.text + (capture.truncated ? "" : capture.decoder.end());
}

function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, force: boolean): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		if (force) {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
				shell: false,
			});
			killer.unref();
		} else {
			child.kill(signal);
		}
		return;
	}
	try {
		// The child starts a detached POSIX process group; negative PID targets it and descendants.
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

/** Run one argv-vector process with no shell and no ambient environment inheritance. */
export function runBounded(options: RunOptions): Promise<RunResult> {
	const stdin = options.stdin ?? "";
	if (byteLength(stdin) > (options.maxStdinBytes ?? DEFAULT_INPUT_BYTES)) {
		return Promise.resolve({
			ok: false,
			failure: "input-limit",
			code: null,
			signal: null,
			stdout: "",
			stderr: "input exceeded configured limit",
			timedOut: false,
			outputLimited: false,
		});
	}
	if (options.signal?.aborted) {
		return Promise.resolve({
			ok: false,
			failure: "cancelled",
			code: null,
			signal: null,
			stdout: "",
			stderr: "",
			timedOut: false,
			outputLimited: false,
		});
	}

	return new Promise((resolve) => {
		const env = Object.fromEntries(
			Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const secrets = sensitiveValues(options);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(options.command, [...(options.args ?? [])], {
				cwd: options.cwd,
				env,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			resolve({
				ok: false,
				failure: "spawn",
				code: null,
				signal: null,
				stdout: "",
				stderr: publicSpawnError(error),
				timedOut: false,
				outputLimited: false,
			});
			return;
		}

		let settled = false;
		let cause: TerminationCause | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let closeCode: number | null = null;
		let closeSignal: NodeJS.Signals | null = null;
		const stdout = createCapture(options.maxStdoutBytes ?? DEFAULT_OUTPUT_BYTES);
		const stderr = createCapture(options.maxStderrBytes ?? DEFAULT_OUTPUT_BYTES);

		const abort = () => terminate("cancelled");
		const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			const failure = spawnError ? "spawn" : cause ?? (code === 0 ? undefined : "nonzero");
			resolve({
				ok: failure === undefined,
				failure,
				code,
				signal,
				stdout: redact(captureText(stdout), secrets),
				stderr: failure === "output-limit"
					? "output exceeded configured limit"
					: spawnError ? publicSpawnError(spawnError) : redact(captureText(stderr), secrets),
				timedOut: failure === "timeout",
				outputLimited: failure === "output-limit",
			});
		};
		const terminate = (nextCause: TerminationCause) => {
			if (settled || cause) return;
			cause = nextCause;
			clearTimeout(timeoutTimer);
			killTree(child, "SIGTERM", false);
			killTimer = setTimeout(() => {
				if (settled) return;
				// Always force the process group after grace, even if its leader exited.
				// Otherwise a detached descendant that ignored TERM can outlive the result.
				killTree(child, "SIGKILL", true);
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
				finish(closeCode, closeSignal ?? "SIGKILL");
			}, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
		};
		const timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) terminate("cancelled");
		child.stdout.on("data", (chunk) => {
			if (captureChunk(stdout, chunk)) terminate("output-limit");
		});
		child.stderr.on("data", (chunk) => {
			if (captureChunk(stderr, chunk)) terminate("output-limit");
		});
		child.once("error", (error) => finish(null, null, error));
		child.once("close", (code, signal) => {
			closeCode = code;
			closeSignal = signal;
			if (!cause) finish(code, signal);
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(stdin);
	});
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Separate model context from human-facing system messages and diagnostics. */
export function parseHookOutput(stdout: string, stderr = ""): HookOutput {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return { additionalContext: "", systemMessage: "", diagnostics: stderr.trim(), format: "empty" };
	}
	if (trimmed.startsWith("{")) {
		try {
			const value = JSON.parse(trimmed) as Record<string, unknown>;
			const specific = value.hookSpecificOutput && typeof value.hookSpecificOutput === "object"
				? value.hookSpecificOutput as Record<string, unknown>
				: {};
			return {
				additionalContext: stringField(specific.additionalContext ?? value.additionalContext),
				systemMessage: stringField(value.systemMessage),
				diagnostics: stderr.trim(),
				format: "json",
			};
		} catch {
			return {
				additionalContext: "",
				systemMessage: "",
				diagnostics: ["malformed hook JSON", stderr.trim()].filter(Boolean).join("\n"),
				format: "json",
			};
		}
	}
	return {
		additionalContext: trimmed,
		systemMessage: "",
		diagnostics: stderr.trim(),
		format: "plain",
	};
}
