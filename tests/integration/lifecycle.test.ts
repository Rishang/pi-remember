import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { ContextChannel } from "../../src/context.ts";
import { projectBranch, type PiBranchEntry } from "../../src/projection.ts";
import {
	SessionCoordinator,
	type HookInput,
	type HostSnapshot,
	type RecoveryMarker,
	type RecoveryRecord,
	type RecoveryStore,
	type RememberRuntime,
} from "../../src/runtime.ts";
import { parseHookOutput } from "../../src/runner.ts";
import type { CapabilityReport, HookOutput } from "../../src/types.ts";
import { registerRememberExtension } from "../../extensions/remember.ts";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-remember-lifecycle-"));
	temporary.push(path);
	return path;
}

function user(id: string, parentId: string | null, text = id): PiBranchEntry {
	return { type: "message", id, parentId, message: { role: "user", content: text } };
}

const EMPTY: HookOutput = { additionalContext: "", systemMessage: "", diagnostics: "", format: "empty" };

function report(disposition: "ready" | "read-only" = "ready"): CapabilityReport {
	return {
		disposition,
		root: "/fake/remember",
		version: "0.30.0",
		issues: [],
		paths: {},
		tools: {},
		verification: "static",
	};
}

type Invoke = (input: HookInput) => Promise<HookOutput>;

class FakeRuntime implements RememberRuntime {
	readonly calls: HookInput[] = [];
	readonly disposition: "ready" | "read-only";
	readonly handler: Invoke;
	active = 0;
	maxActive = 0;
	constructor(disposition: "ready" | "read-only" = "ready", handler: Invoke = async () => EMPTY) {
		this.disposition = disposition;
		this.handler = handler;
	}
	probe(): CapabilityReport { return report(this.disposition); }
	async invoke(input: HookInput): Promise<HookOutput> {
		this.calls.push(input);
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		try { return await this.handler(input); } finally { this.active -= 1; }
	}
}

function coordinator(root: string, runtime: RememberRuntime, current: { value: HostSnapshot }, options: { shutdownTimeoutMs?: number } = {}) {
	return new SessionCoordinator({
		adapterRoot: root,
		runtime,
		snapshot: () => structuredClone(current.value),
		project: (input) => projectBranch(input),
		shutdownTimeoutMs: options.shutdownTimeoutMs,
	});
}

function snapshot(root: string, sessionId = "session-1"): { value: HostSnapshot } {
	return { value: { cwd: root, sessionId, branch: [user("a", null, "hello")] } };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

class MemoryRecoveryStore implements RecoveryStore {
	readonly records = new Map<string, RecoveryMarker>();
	writeGate?: Promise<void>;
	async write(value: RecoveryMarker): Promise<string> {
		await this.writeGate;
		const path = `/memory/${value.sessionId}`;
		this.records.set(path, structuredClone(value));
		return path;
	}
	async list(): Promise<RecoveryRecord[]> {
		return [...this.records].map(([path, value]) => ({ path, marker: structuredClone(value) }));
	}
	async remove(path: string): Promise<void> { this.records.delete(path); }
}

function marker(root: string, sessionId = "session-1"): string {
	const key = createHash("sha256").update(`pi-session:${sessionId}`).digest("hex");
	return join(root, "recovery", `${key}.json`);
}

test("context channel separates notices, bounds plain output, and delivers each revision once", () => {
	const channel = new ContextChannel();
	const notices: unknown[] = [];
	channel.stage(parseHookOutput("plain memory", "plain diagnostic"), (notice) => notices.push(notice));
	channel.stage(parseHookOutput(JSON.stringify({
		hookSpecificOutput: { additionalContext: "json memory" },
		systemMessage: "human only",
	}), "json diagnostic"), (notice) => notices.push(notice));
	channel.stage(parseHookOutput("{broken", "parse detail"), (notice) => notices.push(notice));
	const message = channel.consume();
	assert.ok(message);
	assert.equal(message.display, false);
	assert.match(message.content, /plain memory/);
	assert.match(message.content, /json memory/);
	assert.doesNotMatch(message.content, /human only|diagnostic|malformed/);
	assert.equal(notices.length, 3);
	assert.equal(channel.consume(), undefined);
	channel.stage(parseHookOutput("plain memory"));
	assert.equal(channel.consume(), undefined, "identical context revision is not redelivered");
	channel.stage(parseHookOutput("changed memory"));
	assert.match(channel.consume()!.content, /changed memory/);
	assert.equal(parseHookOutput("").format, "empty");
});

test("context aggregate stays within 64 KiB and defers distinct revisions that do not fit", () => {
	const channel = new ContextChannel();
	channel.stage({ additionalContext: "a".repeat(40_000), systemMessage: "", diagnostics: "", format: "plain" });
	channel.stage({ additionalContext: "b".repeat(40_000), systemMessage: "", diagnostics: "", format: "plain" });
	const first = channel.consume();
	assert.ok(first);
	assert.ok(Buffer.byteLength(first.content, "utf8") <= 64 * 1024);
	assert.match(first.content, /aaa/);
	assert.doesNotMatch(first.content, /bbb/);
	assert.equal(channel.pendingCount, 1);
	const second = channel.consume();
	assert.ok(second);
	assert.ok(Buffer.byteLength(second.content, "utf8") <= 64 * 1024);
	assert.match(second.content, /bbb/);
	assert.equal(channel.pendingCount, 0);

	const sharedPrefix = "x".repeat(70_000);
	const firstRevision = channel.stage({ additionalContext: `${sharedPrefix}one`, systemMessage: "", diagnostics: "", format: "plain" });
	const secondRevision = channel.stage({ additionalContext: `${sharedPrefix}two`, systemMessage: "", diagnostics: "", format: "plain" });
	assert.notEqual(firstRevision, secondRevision, "revision identity includes content beyond the retained prefix");
	assert.ok(channel.consume());
	assert.ok(channel.consume(), "the second oversized revision remains independently deliverable");
});

test("tool_result is synchronous mark-only and durable checkpoints serialize upstream work", async () => {
	const root = temp();
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const running = new Promise<void>((resolve) => { entered = resolve; });
	const runtime = new FakeRuntime("ready", async (input) => {
		if (input.kind === "post-tool" && input.generation === 1) { entered(); await gate; }
		return EMPTY;
	});
	const current = snapshot(root);
	const subject = coordinator(root, runtime, current);
	await subject.start("startup");
	const callsBefore = runtime.calls.length;
	assert.equal(subject.markToolResult(), true);
	assert.equal(runtime.calls.length, callsBefore, "hot path performed no projection or runtime call");
	const first = subject.checkpoint(false, "turn-end");
	await running;
	current.value.branch = [...current.value.branch, user("b", "a")];
	subject.markToolResult();
	const second = subject.checkpoint(false, "agent-settled");
	release();
	await Promise.all([first, second]);
	assert.equal(runtime.maxActive, 1);
	assert.deepEqual(runtime.calls.filter(({ kind }) => kind === "post-tool").map(({ generation }) => generation), [1, 2]);
	assert.equal(subject.status.dirty, false);
});

test("redundant checkpoints coalesce and a later force dominates ordinary pending work", async () => {
	const root = temp();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const runtime = new FakeRuntime("ready", async (input) => {
		if (input.kind === "session-start") await gate;
		return EMPTY;
	});
	const current = snapshot(root);
	const subject = coordinator(root, runtime, current);
	const start = subject.start("startup");
	subject.markToolResult();
	const ordinary = subject.checkpoint(false, "turn-end");
	const forced = subject.checkpoint(true, "agent-settled");
	release();
	await Promise.all([start, ordinary, forced]);
	const saves = runtime.calls.filter(({ kind }) => kind === "post-tool");
	assert.equal(saves.length, 1);
	assert.equal(saves[0].force, true);
});

test("a failed running checkpoint does not resolve a later generation", async () => {
	const root = temp();
	let entered!: () => void;
	let release!: () => void;
	const running = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const runtime = new FakeRuntime("ready", async ({ kind, generation }) => {
		if (kind === "post-tool" && generation === 1) { entered(); await gate; throw new Error("first failed"); }
		return EMPTY;
	});
	const current = snapshot(root);
	const subject = coordinator(root, runtime, current);
	await subject.start("startup");
	subject.markToolResult();
	const first = subject.checkpoint();
	await running;
	current.value.branch = [...current.value.branch, user("b", "a")];
	subject.markToolResult();
	let secondResolved = false;
	const second = subject.checkpoint().then(() => { secondResolved = true; });
	release();
	await first;
	assert.equal(secondResolved, false, "first checkpoint completion did not drain later work");
	await second;
	assert.deepEqual(runtime.calls.filter(({ kind }) => kind === "post-tool").map(({ generation }) => generation), [1, 2]);
	assert.equal(subject.status.dirty, false);
});

test("startup and prompt context aggregate once while notices never enter model context", async () => {
	const root = temp();
	const notices: string[] = [];
	const runtime = new FakeRuntime("ready", async ({ kind }) => kind === "session-start"
		? parseHookOutput(JSON.stringify({ hookSpecificOutput: { additionalContext: "startup private" }, systemMessage: "startup visible" }), "startup diagnostic")
		: kind === "prompt"
			? parseHookOutput(JSON.stringify({ hookSpecificOutput: { additionalContext: "prompt private" }, systemMessage: "prompt visible" }), "prompt diagnostic")
			: EMPTY);
	const current = snapshot(root);
	const subject = new SessionCoordinator({
		adapterRoot: root,
		runtime,
		snapshot: () => structuredClone(current.value),
		project: (input) => projectBranch(input),
		notice: ({ systemMessage, diagnostics }) => notices.push(systemMessage, diagnostics),
	});
	await subject.start("startup");
	const first = await subject.prompt();
	assert.ok(first);
	assert.match(first.content, /startup private/);
	assert.match(first.content, /prompt private/);
	assert.doesNotMatch(first.content, /visible|diagnostic/);
	assert.deepEqual(notices, ["startup visible", "startup diagnostic", "prompt visible", "prompt diagnostic"]);
	const second = await subject.prompt();
	assert.equal(second, undefined, "unchanged startup/prompt revisions inject exactly once");
});

test("delivered startup revisions survive coordinator reload and compact context is identity-only", async () => {
	const root = temp();
	const runtime = new FakeRuntime("ready", async ({ kind }) => ({
		additionalContext: kind === "compact" ? "identity only" : "same startup memory",
		systemMessage: "",
		diagnostics: "",
		format: "plain",
	}));
	const current = snapshot(root);
	const first = coordinator(root, runtime, current);
	await first.start("startup");
	const delivered = await first.prompt();
	assert.ok(delivered);
	current.value.branch = [...current.value.branch, {
		type: "custom_message", id: "ctx", parentId: "a", customType: "pi-remember-context",
		content: delivered.content, display: false, details: delivered.details,
	}];
	const reloaded = coordinator(root, runtime, current);
	await reloaded.start("reload", current.value.branch as Record<string, unknown>[]);
	assert.equal(await reloaded.prompt(), undefined);
	await reloaded.compact();
	const compact = await reloaded.prompt();
	assert.ok(compact);
	assert.match(compact.content, /identity only/);
	assert.doesNotMatch(compact.content, /same startup memory/);
});

test("startup reasons preserve distinct session identity and marker scope", async () => {
	const root = temp();
	for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
		const runtime = new FakeRuntime();
		const current = snapshot(root, `session-${reason}`);
		const subject = coordinator(root, runtime, current);
		await subject.start(reason);
		const call = runtime.calls.find(({ kind }) => kind === "session-start");
		assert.equal(call?.source, reason === "new" ? "clear" : reason);
		assert.equal(call?.sessionId, `session-${reason}`);
	}

	const first = coordinator(root, new FakeRuntime("ready", async ({ kind }) => {
		if (kind === "session-end") throw new Error("leave marker");
		return EMPTY;
	}), snapshot(root, "scope-a"));
	await first.start("startup");
	await first.shutdown("resume");
	const secondRuntime = new FakeRuntime();
	const second = coordinator(root, secondRuntime, snapshot(root, "scope-b"));
	await second.start("resume");
	const recovery = secondRuntime.calls.find(({ kind, reason }) => kind === "session-end" && reason === "recovery");
	assert.equal(recovery?.sessionId, "scope-a", "a replacement session reconciles every pending marker");
	assert.equal(recovery?.force, true);
	assert.equal(secondRuntime.calls.find(({ kind }) => kind === "session-start")?.sessionId, "scope-b");
	assert.throws(() => lstatSync(marker(root, "scope-a")));
});

test("projection and hook failures retain dirty generation and expose redacted status without rejection leaks", async () => {
	const root = temp();
	const current = snapshot(root);
	const runtime = new FakeRuntime("ready", async ({ kind }) => {
		if (kind === "post-tool") throw new Error("PRIVATE_TOOL_OUTPUT");
		return EMPTY;
	});
	const subject = coordinator(root, runtime, current);
	await subject.start("startup");
	subject.markToolResult();
	await subject.checkpoint();
	assert.equal(subject.status.dirty, true);
	assert.equal(subject.status.lastError, "lifecycle operation failed");
	assert.doesNotMatch(subject.status.lastError!, /PRIVATE/);

	const projectionFailure = new SessionCoordinator({
		adapterRoot: temp(), runtime: new FakeRuntime(), snapshot: () => current.value,
		project: async () => ({ ok: false, disposition: "refused", reason: "io-error", appendedRecords: 0, appendedBytes: 0, recoveredRecords: 0, epochCreated: false }),
	});
	projectionFailure.markToolResult();
	await projectionFailure.checkpoint();
	assert.equal(projectionFailure.status.dirty, true);
	assert.equal(projectionFailure.status.lastOutcome, "error");
});

test("read-only capability invokes no hooks and does not falsely clear dirty state", async () => {
	const root = temp();
	const runtime = new FakeRuntime("read-only");
	const subject = coordinator(root, runtime, snapshot(root));
	await subject.start("startup");
	subject.markToolResult();
	await subject.checkpoint();
	assert.equal(runtime.calls.length, 0);
	assert.equal(subject.status.disposition, "read-only");
	assert.equal(subject.status.dirty, true);
});

test("read-only lifecycle writes no projection and no recovery marker", async () => {
	const root = temp();
	let projections = 0;
	const store = new MemoryRecoveryStore();
	const subject = new SessionCoordinator({
		adapterRoot: root,
		runtime: new FakeRuntime("read-only"),
		snapshot: () => snapshot(root).value,
		project: (input) => { projections += 1; return projectBranch(input); },
		recoveryStore: store,
	});
	await subject.start("startup");
	subject.markToolResult();
	await subject.checkpoint(true, "manual-save");
	await subject.prompt();
	await subject.compact();
	await subject.shutdown("quit");
	assert.equal(projections, 0);
	assert.equal(store.records.size, 0);
	assert.equal(subject.status.markerPending, false);
	assert.equal(subject.status.phase, "stopped");
});

test("shutdown is bounded, rejects new work, cancels obsolete work, and retains a private minimal marker", async () => {
	const root = temp();
	const runtime = new FakeRuntime("ready", async ({ kind, signal }) => {
		if (kind === "post-tool" || kind === "session-end") return waitForAbort(signal);
		return EMPTY;
	});
	const current = snapshot(root);
	const subject = coordinator(root, runtime, current, { shutdownTimeoutMs: 30 });
	await subject.start("startup");
	subject.markToolResult();
	void subject.checkpoint();
	const started = performance.now();
	await subject.shutdown("reload");
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(performance.now() - started < 250);
	assert.equal(subject.markToolResult(), false);
	assert.equal(subject.status.phase, "stopped");
	assert.equal(subject.status.lastOutcome, "timeout");
	assert.equal(subject.status.markerPending, true);
	assert.equal(statSync(marker(root)).mode & 0o777, 0o600);
	assert.equal(statSync(dirname(marker(root))).mode & 0o777, 0o700);
	const stored = readFileSync(marker(root), "utf8");
	assert.doesNotMatch(stored, /hello|private|tool|content/i);
	assert.match(stored, /session-1/);
});

test("shutdown deadline includes slow marker IO and an AbortSignal-ignoring runtime", async () => {
	const slowRoot = temp();
	let releaseWrite!: () => void;
	const slowStore = new MemoryRecoveryStore();
	slowStore.writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
	const slowSubject = new SessionCoordinator({
		adapterRoot: slowRoot,
		runtime: new FakeRuntime(),
		snapshot: () => snapshot(slowRoot).value,
		project: (input) => projectBranch(input),
		recoveryStore: slowStore,
		shutdownTimeoutMs: 30,
	});
	await slowSubject.start("startup");
	const slowResult = await Promise.race([
		slowSubject.shutdown("reload").then(() => "returned"),
		new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
	]);
	assert.equal(slowResult, "returned");
	assert.equal(slowSubject.status.lastOutcome, "timeout");
	releaseWrite();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(slowStore.records.size, 1, "late marker publication remains pending after timeout");

	const ignoringRoot = temp();
	let entered!: () => void;
	const runtimeEntered = new Promise<void>((resolve) => { entered = resolve; });
	const ignoringStore = new MemoryRecoveryStore();
	const ignoringSubject = new SessionCoordinator({
		adapterRoot: ignoringRoot,
		runtime: new FakeRuntime("ready", async ({ kind }) => {
			if (kind === "session-end") { entered(); return new Promise<HookOutput>(() => undefined); }
			return EMPTY;
		}),
		snapshot: () => snapshot(ignoringRoot).value,
		project: (input) => projectBranch(input),
		recoveryStore: ignoringStore,
		shutdownTimeoutMs: 30,
	});
	await ignoringSubject.start("startup");
	const shutdown = ignoringSubject.shutdown("reload");
	await runtimeEntered;
	const ignoringResult = await Promise.race([
		shutdown.then(() => "returned"),
		new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
	]);
	assert.equal(ignoringResult, "returned");
	assert.equal(ignoringSubject.status.lastOutcome, "timeout");
	assert.equal(ignoringSubject.status.markerPending, true);
	assert.equal(ignoringStore.records.size, 1);
});

test("work queued before shutdown cannot run obsolete startup, prompt, or compact hooks", async () => {
	const root = temp();
	let entered!: () => void;
	const running = new Promise<void>((resolve) => { entered = resolve; });
	const runtime = new FakeRuntime("ready", async ({ kind, signal }) => {
		if (kind === "post-tool") { entered(); return waitForAbort(signal); }
		return EMPTY;
	});
	const subject = coordinator(root, runtime, snapshot(root), { shutdownTimeoutMs: 100 });
	await subject.start("startup");
	subject.markToolResult();
	void subject.checkpoint();
	await running;
	const queuedPrompt = subject.prompt();
	const queuedCompact = subject.compact();
	const queuedStartup = subject.start("reload");
	await subject.shutdown("reload");
	await Promise.all([queuedPrompt, queuedCompact, queuedStartup]);
	assert.equal(runtime.calls.filter(({ kind }) => kind === "prompt").length, 0);
	assert.equal(runtime.calls.filter(({ kind }) => kind === "compact").length, 0);
	assert.equal(runtime.calls.filter(({ kind }) => kind === "session-start").length, 1);
	assert.equal(subject.status.phase, "stopped");
});

test("read-only startup retains every pending recovery marker", async () => {
	const root = temp();
	const store = new MemoryRecoveryStore();
	const originalRuntime = new FakeRuntime();
	const original = new SessionCoordinator({
		adapterRoot: root,
		runtime: originalRuntime,
		snapshot: () => snapshot(root, "old-session").value,
		project: (input) => projectBranch(input),
		recoveryStore: store,
	});
	await original.start("startup");
	const markerCall = originalRuntime.calls.find(({ kind }) => kind === "session-start")!;
	await store.write({
		schemaVersion: 1,
		sessionId: markerCall.sessionId,
		cwd: markerCall.cwd,
		generation: 1,
		reason: "reload",
		hostSessionId: markerCall.hostSessionId,
		epoch: 1,
		projectionRevision: 1,
		projectionPath: markerCall.projectionPath,
	});
	const replacementRuntime = new FakeRuntime("read-only");
	const replacement = new SessionCoordinator({
		adapterRoot: root,
		runtime: replacementRuntime,
		snapshot: () => snapshot(root, "replacement").value,
		project: (input) => projectBranch(input),
		recoveryStore: store,
	});
	await replacement.start("resume");
	assert.equal(store.records.size, 1);
	assert.equal(replacement.status.markerPending, true);
	assert.equal(replacementRuntime.calls.length, 0);
});

test("successful shutdown clears marker, failed handoff preserves it, and next startup reconciles it", async () => {
	const successRoot = temp();
	const successRuntime = new FakeRuntime();
	const success = coordinator(successRoot, successRuntime, snapshot(successRoot));
	await success.start("startup");
	success.markToolResult();
	await success.shutdown("fork");
	assert.equal(success.status.markerPending, false);
	assert.throws(() => lstatSync(marker(successRoot)));
	assert.equal(successRuntime.calls.at(-1)?.kind, "session-end");
	assert.equal(successRuntime.calls.at(-1)?.force, true);

	const recoveryRoot = temp();
	const failing = new FakeRuntime("ready", async ({ kind }) => {
		if (kind === "session-end") throw new Error("handoff failed");
		return EMPTY;
	});
	const old = coordinator(recoveryRoot, failing, snapshot(recoveryRoot));
	await old.start("startup");
	old.markToolResult();
	await old.shutdown("resume");
	assert.equal(old.status.markerPending, true);

	const recoveredRuntime = new FakeRuntime();
	const recovered = coordinator(recoveryRoot, recoveredRuntime, snapshot(recoveryRoot));
	await recovered.start("resume");
	const recovery = recoveredRuntime.calls.find(({ kind, reason }) => kind === "session-end" && reason === "recovery");
	assert.equal(recovery?.force, true);
	assert.equal(recovery?.sessionId, "session-1");
	assert.equal(recoveredRuntime.calls.find(({ kind }) => kind === "session-start")?.force, false);
	assert.equal(recovered.status.markerPending, false);
});

test("adapter root and recovery marker reject symlink escapes", async () => {
	const parent = temp();
	const outside = temp();
	const linked = join(parent, "linked");
	symlinkSync(outside, linked);
	assert.throws(() => coordinator(linked, new FakeRuntime(), snapshot(parent)), /unsafe/);

	const root = temp();
	mkdirSync(join(root, "recovery"), { mode: 0o700 });
	symlinkSync(join(outside, "marker"), marker(root, "session-1"));
	const subject = coordinator(root, new FakeRuntime(), snapshot(root));
	await subject.start("startup");
	await subject.shutdown("quit");
	assert.equal(subject.status.lastOutcome, "error");
	assert.equal(lstatSync(marker(root, "session-1")).isSymbolicLink(), true);
});

test("thin Pi registration has no factory side effects and maps exact 0.85.1 events in headless mode", async () => {
	type Handler = (event: any, context: any) => unknown;
	const handlers = new Map<string, Handler>();
	let constructed = 0;
	let shutdownGate: Promise<void> | undefined;
	const fakeCoordinator = {
		startCalls: [] as string[], marks: 0, checkpoints: [] as string[], compacts: 0, shutdowns: [] as string[],
		async start(reason: string) { this.startCalls.push(reason); },
		markDirty() { this.marks += 1; return true; },
		markToolResult() { this.marks += 1; return true; },
		enqueueCheckpoint(_force: boolean, source: string) { this.checkpoints.push(source); },
		async prompt() { return { customType: "pi-remember-context", content: "hidden", display: false, details: { revision: "r", revisions: [], source: "remember" } }; },
		async compact() { this.compacts += 1; },
		async shutdown(reason: string) { this.shutdowns.push(reason); await shutdownGate; },
	};
	const commands: string[] = [];
	let probes = 0;
	registerRememberExtension({
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		registerCommand: (name: string) => { commands.push(name); },
	} as any, {
		adapterRoot: "/never-touched-during-registration",
		createCoordinator: () => { constructed += 1; return fakeCoordinator as any; },
		createRuntime: () => new FakeRuntime(),
		probe: () => { probes += 1; return report(); },
	});
	assert.equal(constructed, 0);
	assert.equal(probes, 0);
	assert.deepEqual([...handlers.keys()], [
		"session_start", "before_agent_start", "tool_result", "turn_end", "agent_end", "agent_settled", "session_tree", "session_compact", "session_shutdown",
		"resources_discover",
	]);
	assert.deepEqual(commands, ["remember:doctor", "remember-status", "remember-save"]);
	const context = {
		cwd: "/tmp/project", hasUI: false, ui: { notify() { throw new Error("headless UI used"); } },
		sessionManager: { getSessionId: () => "pi-session", getBranch: () => [user("a", null)] },
	};
	await handlers.get("session_start")!({ reason: "fork" }, context);
	assert.equal(constructed, 1);
	handlers.get("tool_result")!({}, context);
	for (const event of ["turn_end", "agent_end", "agent_settled", "session_tree"] as const) {
		const returned = handlers.get(event)!({}, context);
		assert.equal(returned, undefined, `${event} must not return an awaited Promise`);
	}
	await handlers.get("session_compact")!({}, context);
	const injected = await handlers.get("before_agent_start")!({}, context) as any;
	await handlers.get("session_shutdown")!({ reason: "fork" }, context);
	assert.equal(fakeCoordinator.marks, 4);
	assert.deepEqual(fakeCoordinator.checkpoints, ["turn-end", "agent-end", "agent-settled", "session-tree"]);
	assert.equal(fakeCoordinator.compacts, 1);
	assert.equal(injected.message.display, false);
	assert.deepEqual(fakeCoordinator.shutdowns, ["fork"]);
	await handlers.get("session_start")!({ reason: "resume" }, context);
	assert.equal(constructed, 2, "replacement lifecycle creates a fresh session-scoped coordinator");

	let releaseShutdown!: () => void;
	shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
	const overlappingShutdown = handlers.get("session_shutdown")!({ reason: "reload" }, context) as Promise<void>;
	const overlappingStart = handlers.get("session_start")!({ reason: "reload" }, context) as Promise<void>;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(constructed, 2, "overlapping start waits for outgoing shutdown cleanup");
	releaseShutdown();
	await Promise.all([overlappingShutdown, overlappingStart]);
	assert.equal(constructed, 3, "overlapping replacement starts with a fresh coordinator");
});

test("commands and skill discovery use the human channel and force a real checkpoint", async () => {
	type Handler = (event: any, context: any) => unknown;
	type Command = { handler: (args: string, ctx: any) => Promise<void> };
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const runtime = new FakeRuntime();
	registerRememberExtension({
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		registerCommand: (name: string, options: Command) => { commands.set(name, options); },
	} as any, {
		adapterRoot: join(temp(), "adapter"),
		createRuntime: () => runtime,
		probe: () => ({ ...report(), paths: { skill: "/fake/remember/skills/remember/SKILL.md" } }),
	});
	assert.deepEqual(await handlers.get("resources_discover")!({ cwd: "/tmp", reason: "startup" }, {}), { skillPaths: ["/fake/remember/skills/remember"] });

	const notices: Array<[string, string]> = [];
	let idleWaits = 0;
	const context = {
		cwd: temp(), hasUI: true, ui: { notify: (text: string, level: string) => { notices.push([text, level]); } },
		sessionManager: { getSessionId: () => "pi-session", getBranch: () => [user("a", null)] },
		waitForIdle: async () => { idleWaits += 1; },
	};

	await commands.get("remember-save")!.handler("", context);
	assert.deepEqual(notices.pop(), ["Remember save skipped: no active session.", "warning"]);

	await handlers.get("session_start")!({ reason: "startup" }, context);
	await commands.get("remember-save")!.handler("", context);
	assert.equal(idleWaits, 2);
	const forced = runtime.calls.at(-1)!;
	assert.equal(forced.kind, "post-tool");
	assert.equal(forced.force, true);
	assert.equal(forced.source, "manual-save");
	assert.deepEqual(notices.pop(), ["Remember save completed.", "info"]);

	await commands.get("remember-status")!.handler("", context);
	const [statusText] = notices.pop()!;
	assert.match(statusText, /Session: active/);
	assert.match(statusText, /Last hook: post-tool -> ok/);

	const written: string[] = [];
	const write = process.stderr.write;
	process.stderr.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stderr.write;
	try {
		await commands.get("remember-status")!.handler("", { ...context, hasUI: false, ui: { notify() { throw new Error("headless UI used"); } } });
	} finally { process.stderr.write = write; }
	assert.match(written.join(""), /^pi-remember status/);
	await handlers.get("session_shutdown")!({ reason: "quit" }, context);
});

test("skill discovery stays silent when the static probe rejects the runtime", async () => {
	type Handler = (event: any, context: any) => unknown;
	const handlers = new Map<string, Handler>();
	registerRememberExtension({ on: (event: string, handler: Handler) => { handlers.set(event, handler); }, registerCommand() {} } as any, {
		adapterRoot: "/unused",
		probe: () => ({ ...report("read-only"), paths: { skill: "/fake/remember/skills/remember/SKILL.md" } }),
	});
	assert.equal(await handlers.get("resources_discover")!({ cwd: "/tmp", reason: "startup" }, {}), undefined);
});
