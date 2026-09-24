import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	chmod,
	lstat,
	open,
	readFile,
	readdir,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ContextChannel, deliveredContextRevisions, type ContextMessage, type NoticeObserver } from "./context.ts";
import { projectBranch, type PiBranchEntry, type ProjectionResult } from "./projection.ts";
import type { CapabilityReport, HookOutput } from "./types.ts";

const DEFAULT_SHUTDOWN_MS = 2_000;
const MARKER_SCHEMA = 1;

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type HookKind = "session-start" | "prompt" | "post-tool" | "session-end" | "compact";

export interface HostSnapshot {
	sessionId: string;
	cwd: string;
	branch: readonly PiBranchEntry[];
}

export interface ProjectionInput extends HostSnapshot { root: string }
export type ProjectionAdapter = (input: ProjectionInput) => Promise<ProjectionResult>;

export interface HookInput {
	kind: HookKind;
	cwd: string;
	sessionId: string;
	hostSessionId: string;
	projectionPath: string;
	source?: string;
	reason?: string;
	generation: number;
	force: boolean;
	signal: AbortSignal;
}

export interface RememberRuntime {
	probe(): Promise<CapabilityReport> | CapabilityReport;
	invoke(input: HookInput): Promise<HookOutput>;
}

export interface RuntimeStatus {
	phase: "idle" | "starting" | "active" | "shutting-down" | "stopped";
	disposition: "unknown" | "ready" | "read-only";
	dirty: boolean;
	dirtyGeneration: number;
	publishedGeneration: number;
	queued: boolean;
	forcePending: boolean;
	markerPending: boolean;
	lastHook?: HookKind;
	lastError?: string;
	lastOutcome?: "ok" | "read-only" | "cancelled" | "timeout" | "error";
	hostSessionId?: string;
	epoch?: number;
	projectionRevision?: number;
}

export interface CoordinatorOptions {
	adapterRoot: string;
	runtime: RememberRuntime;
	snapshot: () => HostSnapshot;
	project?: ProjectionAdapter;
	notice?: NoticeObserver;
	shutdownTimeoutMs?: number;
	recoveryStore?: RecoveryStore;
}

export interface RecoveryRecord { path: string; marker: RecoveryMarker }
export interface RecoveryStore {
	write(marker: RecoveryMarker): Promise<string>;
	list(): Promise<RecoveryRecord[]>;
	remove(path: string): Promise<void>;
}

export type RecoveryMarker = {
	schemaVersion: 1;
	sessionId: string;
	cwd: string;
	generation: number;
	reason: string;
	hostSessionId: string;
	epoch: number;
	projectionRevision: number;
	projectionPath: string;
};

type Deferred = { promise: Promise<void>; resolve(): void };
type Work = {
	kind: "startup" | "checkpoint" | "prompt" | "compact" | "shutdown";
	generation: number;
	force: boolean;
	source?: string;
	reason?: string;
	completions?: Deferred[];
};
type PublishedProjection = {
	result: ProjectionResult;
	snapshot: HostSnapshot;
	epoch: NonNullable<ReturnType<typeof currentEpoch>>;
};

function deferred(): Deferred {
	let resolve!: () => void;
	return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function publicError(error: unknown): string {
	if (error instanceof Error && error.name === "AbortError") return "cancelled";
	if (error && typeof error === "object" && "failure" in error && typeof error.failure === "string") return error.failure;
	return "lifecycle operation failed";
}

function isContained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function ensurePrivateDirectory(path: string): void {
	const absolute = resolve(path);
	if (!isAbsolute(path) || absolute !== path) throw new Error("unsafe adapter root");
	const filesystemRoot = absolute.split(sep)[0] === "" ? sep : absolute.split(sep)[0];
	let current = filesystemRoot;
	for (const part of absolute.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			const info = lstatSync(current);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe adapter root");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			mkdirSync(current, { mode: 0o700 });
		}
	}
	chmodSync(absolute, 0o700);
	if (realpathSync(absolute) !== absolute) throw new Error("unsafe adapter root");
}

function recoveryKey(sessionId: string): string {
	return createHash("sha256").update(`pi-session:${sessionId}`).digest("hex");
}

function validMarker(value: unknown, root: string): value is RecoveryMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as RecoveryMarker;
	return marker.schemaVersion === MARKER_SCHEMA
		&& typeof marker.sessionId === "string" && marker.sessionId.length > 0 && marker.sessionId.length <= 512 && !/[\r\n\0]/.test(marker.sessionId)
		&& isAbsolute(marker.cwd) && resolve(marker.cwd) === marker.cwd && !/[\r\n\0]/.test(marker.cwd)
		&& Number.isSafeInteger(marker.generation) && marker.generation >= 0
		&& typeof marker.reason === "string" && marker.reason.length <= 64 && !/[\r\n\0]/.test(marker.reason)
		&& /^[0-9a-f]{64}$/.test(marker.hostSessionId)
		&& Number.isSafeInteger(marker.epoch) && marker.epoch > 0
		&& Number.isSafeInteger(marker.projectionRevision) && marker.projectionRevision >= 0
		&& isAbsolute(marker.projectionPath) && resolve(marker.projectionPath) === marker.projectionPath
		&& isContained(root, marker.projectionPath);
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

export class FileRecoveryStore implements RecoveryStore {
	readonly #root: string;
	readonly #directory: string;

	constructor(root: string) {
		this.#root = root;
		this.#directory = join(root, "recovery");
		if (!isContained(root, this.#directory)) throw new Error("marker escaped root");
		ensurePrivateDirectory(this.#directory);
	}

	async write(marker: RecoveryMarker): Promise<string> {
		if (!validMarker(marker, this.#root)) throw new Error("invalid marker");
		const path = join(this.#directory, `${recoveryKey(marker.sessionId)}.json`);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("unsafe marker");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const temporary = join(this.#directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(marker)}\n`);
			await handle.sync();
		} catch (error) {
			try { await unlink(temporary); } catch { /* best effort before publication */ }
			throw error;
		} finally { await handle.close(); }
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
		await syncDirectory(this.#directory);
		return path;
	}

	async list(): Promise<RecoveryRecord[]> {
		const records: RecoveryRecord[] = [];
		for (const name of (await readdir(this.#directory)).sort()) {
			if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
			const path = join(this.#directory, name);
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("unsafe marker");
			await chmod(path, 0o600);
			const marker = JSON.parse(await readFile(path, "utf8")) as unknown;
			if (!validMarker(marker, this.#root) || name !== `${recoveryKey(marker.sessionId)}.json`) throw new Error("invalid marker");
			records.push({ path, marker });
		}
		return records;
	}

	async remove(path: string): Promise<void> {
		if (dirname(path) !== this.#directory || !/^[0-9a-f]{64}\.json$/.test(basename(path))) throw new Error("unsafe marker");
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("unsafe marker");
			const quarantine = join(this.#directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.delete`);
			await rename(path, quarantine);
			await syncDirectory(this.#directory);
			await unlink(quarantine);
			await syncDirectory(this.#directory);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

function currentEpoch(result: ProjectionResult) {
	return result.state?.epochs.find(({ epoch }) => epoch === result.state?.currentEpoch);
}

function startSource(reason: SessionStartReason): string {
	return reason === "new" ? "clear" : reason;
}

/** Session-scoped serialized lifecycle coordinator. Hot events only mutate counters. */
export class SessionCoordinator {
	readonly #root: string;
	readonly #runtime: RememberRuntime;
	readonly #snapshot: () => HostSnapshot;
	readonly #project: ProjectionAdapter;
	readonly #notice?: NoticeObserver;
	readonly #shutdownTimeoutMs: number;
	readonly #recovery: RecoveryStore;
	readonly #context = new ContextChannel();
	readonly #status: RuntimeStatus = {
		phase: "idle", disposition: "unknown", dirty: false, dirtyGeneration: 0, publishedGeneration: 0,
		queued: false, forcePending: false, markerPending: false,
	};
	#tail: Promise<void> = Promise.resolve();
	#pendingCheckpoint?: Work;
	#runningCheckpoint = false;
	#accepting = true;
	#activeAbort?: AbortController;
	#capability?: CapabilityReport;
	#lastProjection?: PublishedProjection;
	#shutdownMarkerPath?: string;
	#shutdownExpired = false;

	constructor(options: CoordinatorOptions) {
		ensurePrivateDirectory(options.adapterRoot);
		this.#root = options.adapterRoot;
		this.#runtime = options.runtime;
		this.#snapshot = options.snapshot;
		this.#project = options.project ?? ((input) => projectBranch(input));
		this.#notice = options.notice;
		this.#recovery = options.recoveryStore ?? new FileRecoveryStore(this.#root);
		this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_MS;
		if (!Number.isSafeInteger(this.#shutdownTimeoutMs) || this.#shutdownTimeoutMs < 1 || this.#shutdownTimeoutMs > 30_000) throw new Error("invalid shutdown timeout");
	}

	get status(): Readonly<RuntimeStatus> { return { ...this.#status }; }

	markDirty(): boolean {
		if (!this.#accepting) return false;
		this.#status.dirtyGeneration += 1;
		this.#status.dirty = true;
		return true;
	}

	markToolResult(): boolean { return this.markDirty(); }

	start(reason: SessionStartReason, deliveredBranch?: readonly Record<string, unknown>[]): Promise<void> {
		if (!this.#accepting) return Promise.resolve();
		this.#status.phase = "starting";
		if (deliveredBranch) this.#context.seedDelivered(deliveredContextRevisions(deliveredBranch));
		return this.#enqueue({ kind: "startup", generation: this.#status.dirtyGeneration, force: false, source: startSource(reason) });
	}

	checkpoint(force = false, source = "durable-boundary"): Promise<void> {
		if (!this.#accepting) return Promise.resolve();
		const completion = deferred();
		if (this.#pendingCheckpoint) {
			this.#pendingCheckpoint.generation = Math.max(this.#pendingCheckpoint.generation, this.#status.dirtyGeneration);
			this.#pendingCheckpoint.force ||= force;
			this.#pendingCheckpoint.completions!.push(completion);
		} else {
			const work: Work = {
				kind: "checkpoint", generation: this.#status.dirtyGeneration, force, source, completions: [completion],
			};
			this.#pendingCheckpoint = work;
			void this.#enqueue(work);
		}
		this.#refreshQueueStatus();
		return completion.promise;
	}

	/** Fire-and-forget durable boundary used by Pi handlers that must not block the agent loop. */
	enqueueCheckpoint(force = false, source = "durable-boundary"): void {
		void this.checkpoint(force, source);
	}

	async prompt(): Promise<ContextMessage | undefined> {
		if (!this.#accepting) return undefined;
		await this.#enqueue({ kind: "prompt", generation: this.#status.dirtyGeneration, force: false });
		return this.#context.consume();
	}

	compact(source = "compact"): Promise<void> {
		if (!this.#accepting) return Promise.resolve();
		return this.#enqueue({ kind: "compact", generation: this.#status.dirtyGeneration, force: false, source });
	}

	async shutdown(reason: SessionShutdownReason): Promise<void> {
		if (!this.#accepting) return;
		this.#accepting = false;
		this.#status.phase = "shutting-down";
		const markersBeforeShutdown = this.#status.markerPending;
		this.#status.markerPending = true;
		this.#activeAbort?.abort();

		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"timeout">((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout("timeout"), this.#shutdownTimeoutMs);
		});
		const handoff = (async () => {
			// A read-only runtime can never replay a marker, so writing one would only accumulate files.
			if (!await this.#probe()) {
				this.#status.markerPending = markersBeforeShutdown;
				return;
			}
			const projection = this.#lastProjection ?? await this.#projection();
			this.#shutdownMarkerPath = await this.#recovery.write(this.#markerFor(projection, reason));
			if (this.#shutdownExpired) return;
			await this.#enqueue({ kind: "shutdown", generation: this.#status.dirtyGeneration, force: true, reason });
		})().then(() => "done" as const).catch((error) => {
			this.#capture(error);
			return "error" as const;
		});

		const outcome = await Promise.race([handoff, timeout]);
		if (timer) clearTimeout(timer);
		if (outcome === "timeout") {
			this.#shutdownExpired = true;
			this.#activeAbort?.abort();
			this.#status.lastOutcome = "timeout";
			this.#status.lastError = "shutdown handoff timed out";
			// `handoff` is already rejection-handled and checks #shutdownExpired before marker removal.
			void handoff;
		}
		this.#status.phase = "stopped";
	}

	#refreshQueueStatus(): void {
		this.#status.queued = this.#runningCheckpoint || !!this.#pendingCheckpoint;
		this.#status.forcePending = !!this.#pendingCheckpoint?.force;
	}

	#capture(error: unknown): void {
		if (this.#shutdownExpired) return;
		this.#status.lastError = publicError(error);
		this.#status.lastOutcome = this.#status.lastError === "cancelled" ? "cancelled" : "error";
	}

	#enqueue(work: Work): Promise<void> {
		const run = this.#tail.then(() => this.#execute(work));
		const guarded = run.catch((error) => this.#capture(error));
		this.#tail = guarded;
		return guarded;
	}

	async #execute(work: Work): Promise<void> {
		if (work.kind === "checkpoint") {
			if (this.#pendingCheckpoint === work) this.#pendingCheckpoint = undefined;
			this.#runningCheckpoint = true;
			this.#refreshQueueStatus();
		}
		try { await this.#run(work); }
		catch (error) { this.#capture(error); }
		finally {
			if (work.kind === "checkpoint") {
				this.#runningCheckpoint = false;
				for (const completion of work.completions ?? []) completion.resolve();
				this.#refreshQueueStatus();
			}
		}
	}

	async #probe(): Promise<boolean> {
		if (!this.#capability) this.#capability = await this.#runtime.probe();
		this.#status.disposition = this.#capability.disposition;
		if (this.#capability.disposition !== "ready") {
			this.#status.lastOutcome = "read-only";
			return false;
		}
		return true;
	}

	#validateProjectionPath(path: string): string {
		const realRoot = realpathSync(this.#root);
		const realProjection = realpathSync(path);
		const info = statSync(realProjection);
		if (!isContained(realRoot, realProjection) || !info.isFile() || info.nlink !== 1) throw new Error("unsafe projection");
		return realProjection;
	}

	async #projection(): Promise<PublishedProjection> {
		const snapshot = this.#snapshot();
		const result = await this.#project({ ...snapshot, root: this.#root });
		const epoch = currentEpoch(result);
		if (!result.ok || !result.projectionPath || !epoch) throw new Error("projection failed");
		this.#validateProjectionPath(result.projectionPath);
		this.#status.hostSessionId = epoch.hostSessionId;
		this.#status.epoch = epoch.epoch;
		this.#status.projectionRevision = result.state?.revision;
		const published = { result, snapshot, epoch };
		this.#lastProjection = published;
		return published;
	}

	async #invoke(input: Omit<HookInput, "signal">, stage = true, allowDuringShutdown = false): Promise<boolean> {
		if ((!this.#accepting && !allowDuringShutdown) || !await this.#probe()) return false;
		if ((!this.#accepting && !allowDuringShutdown) || this.#shutdownExpired) return false;
		const controller = new AbortController();
		this.#activeAbort = controller;
		try {
			const output = await this.#runtime.invoke({ ...input, signal: controller.signal });
			if (this.#shutdownExpired) return false;
			if (stage) this.#context.stage(output, this.#notice);
			this.#status.lastHook = input.kind;
			this.#status.lastOutcome = "ok";
			this.#status.lastError = undefined;
			return true;
		} finally {
			if (this.#activeAbort === controller) this.#activeAbort = undefined;
		}
	}

	async #invokeProjection(
		kind: HookKind,
		projection: PublishedProjection,
		work: Work,
		stage = true,
		allowDuringShutdown = false,
	): Promise<boolean> {
		return this.#invoke({
			kind,
			cwd: projection.snapshot.cwd,
			sessionId: projection.snapshot.sessionId,
			hostSessionId: projection.epoch.hostSessionId,
			projectionPath: projection.result.projectionPath!,
			source: work.source,
			reason: work.reason,
			generation: work.generation,
			force: work.force,
		}, stage, allowDuringShutdown);
	}

	async #recoverPending(): Promise<void> {
		const records = await this.#recovery.list();
		this.#status.markerPending = records.length > 0;
		if (records.length === 0 || !await this.#probe()) return;
		for (const record of records) {
			try {
				this.#validateProjectionPath(record.marker.projectionPath);
				const succeeded = await this.#invoke({
					kind: "session-end",
					cwd: record.marker.cwd,
					sessionId: record.marker.sessionId,
					hostSessionId: record.marker.hostSessionId,
					projectionPath: record.marker.projectionPath,
					reason: "recovery",
					generation: record.marker.generation,
					force: true,
				}, false);
				if (succeeded) await this.#recovery.remove(record.path);
			} catch (error) { this.#capture(error); }
		}
		this.#status.markerPending = (await this.#recovery.list()).length > 0;
	}

	#markerFor(projection: PublishedProjection, reason: string): RecoveryMarker {
		return {
			schemaVersion: MARKER_SCHEMA,
			sessionId: projection.snapshot.sessionId,
			cwd: projection.snapshot.cwd,
			generation: this.#status.dirtyGeneration,
			reason,
			hostSessionId: projection.epoch.hostSessionId,
			epoch: projection.epoch.epoch,
			projectionRevision: projection.result.state?.revision ?? 0,
			projectionPath: projection.result.projectionPath!,
		};
	}

	async #run(work: Work): Promise<void> {
		// Work accepted before shutdown may still be waiting on the serial tail. Only the
		// explicit shutdown handoff may perform work after the coordinator stops accepting.
		if (!this.#accepting && work.kind !== "shutdown") return;
		if (work.kind === "startup") await this.#recoverPending();
		// Read-only means no session text is projected to disk and no hook runs.
		if (!await this.#probe()) {
			if (work.kind === "startup" && this.#accepting) this.#status.phase = "active";
			return;
		}
		if (work.kind === "startup") {
			if (!this.#accepting) return;
			const projection = await this.#projection();
			if (!this.#accepting) return;
			await this.#invokeProjection("session-start", projection, work);
			if (this.#accepting) this.#status.phase = "active";
			return;
		}
		if (work.kind === "prompt") {
			const projection = await this.#projection();
			await this.#invokeProjection("prompt", projection, work);
			return;
		}
		if (work.kind === "compact") {
			const projection = await this.#projection();
			await this.#invokeProjection("compact", projection, work);
			return;
		}
		if (work.kind === "checkpoint") {
			if (!this.#accepting) return;
			const generation = Math.max(work.generation, this.#status.dirtyGeneration);
			if (!work.force && generation <= this.#status.publishedGeneration) return;
			const projection = await this.#projection();
			if (await this.#invokeProjection("post-tool", projection, { ...work, generation })) {
				this.#status.publishedGeneration = Math.max(this.#status.publishedGeneration, generation);
				this.#status.dirty = this.#status.dirtyGeneration > this.#status.publishedGeneration;
			}
			return;
		}

		const projection = await this.#projection();
		this.#shutdownMarkerPath = await this.#recovery.write(this.#markerFor(projection, work.reason ?? "shutdown"));
		this.#status.markerPending = true;
		if (this.#shutdownExpired) return;
		if (await this.#invokeProjection("session-end", projection, work, false, true)) {
			this.#status.publishedGeneration = Math.max(this.#status.publishedGeneration, work.generation);
			this.#status.dirty = this.#status.dirtyGeneration > this.#status.publishedGeneration;
			if (!this.#shutdownExpired && this.#shutdownMarkerPath) {
				await this.#recovery.remove(this.#shutdownMarkerPath);
				this.#status.markerPending = false;
			}
		}
	}
}
