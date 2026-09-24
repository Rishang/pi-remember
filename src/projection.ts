import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory, hash, isContained, syncDirectory, truncateDurable, truncateUtf8 } from "./fs.ts";
import { basename, dirname, join } from "node:path";

export const DEFAULT_NORMALIZER_VERSION = "1";
const SCHEMA_VERSION = 2;
const SERIALIZATION_POLICY = {
	defaultTextBytes: 16_384,
	maxTextBytes: 1_048_576,
	defaultToolArgumentBytes: 4_096,
	maxToolArgumentBytes: 65_536,
	maxToolCalls: 32,
	identifierBytes: 256,
	roleBytes: 128,
	typeBytes: 128,
	sourceEntryIdChars: 1_024,
	normalizerVersionChars: 128,
	argumentStringBytes: 1_024,
	argumentDepth: 5,
	argumentArrayItems: 20,
	argumentObjectKeys: 50,
	argumentKeyHashes: 50,
	argumentNodes: 512,
	contentBlocks: 256,
} as const;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const SECRET_KEY = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie|private[_-]?key|access[_-]?key)/i;
const BINARY_KEY = /^(?:data|image|images|base64|bytes|buffer|screenshot)$/i;

export interface PiBranchEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
	[key: string]: unknown;
}

export interface ProjectionLineageEntry {
	id: string;
	parentId: string | null;
}

export interface ProjectionEpochState {
	epoch: number;
	hostSessionId: string;
	projection: string;
	normalizerVersion: string;
	maxTextBytes: number;
	maxToolArgumentBytes: number;
	policyId: string;
	lineage: ProjectionLineageEntry[];
	recordSourceIds: string[];
	recordFingerprints: string[];
	durableBytes: number;
	projectionSha256: string;
}

export interface ProjectionRegistry {
	schemaVersion: 2;
	sessionId: string;
	sessionKey: string;
	revision: number;
	currentEpoch: number;
	epochs: ProjectionEpochState[];
}

interface OwnershipRegistry {
	schemaVersion: 1;
	claims: Record<string, { sessionKey: string; epoch: number; sourceEntryId: string }>;
}

export type ProjectionReason =
	| "first-projection"
	| "strict-extension"
	| "exact-repeat"
	| "prefix-shrink"
	| "lineage-divergence"
	| "normalizer-change"
	| "missing-projection"
	| "inconsistent-projection"
	| "registry-missing"
	| "registry-corrupt"
	| "orphan-projection"
	| "prior-state"
	| "invalid-session"
	| "invalid-branch"
	| "invalid-policy"
	| "unsafe-root"
	| "lock-timeout"
	| "io-error";

export interface ProjectionResult {
	ok: boolean;
	disposition: "epoch-created" | "appended" | "unchanged" | "recovered" | "refused";
	reason: ProjectionReason;
	state?: ProjectionRegistry;
	projectionPath?: string;
	registryPath?: string;
	appendedRecords: number;
	appendedBytes: number;
	recoveredRecords: number;
	epochCreated: boolean;
}

export interface ProjectBranchOptions {
	root: string;
	sessionId: string;
	branch: readonly PiBranchEntry[];
	normalizerVersion?: string;
	maxTextBytes?: number;
	maxToolArgumentBytes?: number;
	lockTimeoutMs?: number;
	/** Test seam: throws after projection fsync and before ownership/registry publication. */
	onProjectionSynced?: (path: string) => void;
}

type RecordMetadata = {
	sourceEntryId: string;
	/** Policy-independent ownership identity for copied Pi lineage. */
	sourceFingerprint: string;
	/** Hash of the policy-specific normalized payload without metadata. */
	normalizedFingerprint: string;
	parentId: string | null;
	policyId: string;
};

type NormalizedRecord = Record<string, unknown> & { _piRemember: RecordMetadata };
type Scan = {
	records: NormalizedRecord[];
	lines: string[];
	bytes: number;
	validBytes: number;
	valid: boolean;
	torn: boolean;
	recoverableTail: boolean;
	sha256: string;
};

function refused(reason: ProjectionReason): ProjectionResult {
	return { ok: false, disposition: "refused", reason, appendedRecords: 0, appendedBytes: 0, recoveredRecords: 0, epochCreated: false };
}

function sessionKey(sessionId: string): string {
	return hash(`pi-session:${sessionId}`);
}

export function deriveHostSessionId(sessionId: string, epoch: number): string {
	return hash(`pi:${sessionId}:${epoch}`);
}

function policyId(version: string, maxTextBytes: number, maxToolArgumentBytes: number): string {
	return hash(JSON.stringify({ ...SERIALIZATION_POLICY, version, maxTextBytes, maxToolArgumentBytes }));
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
	return Number.isSafeInteger(value) && value! >= 128 && value! <= maximum ? value! : fallback;
}

function validateSessionId(value: string): boolean {
	return value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

function validSourceEntryId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= SERIALIZATION_POLICY.sourceEntryIdChars && !/[\r\n\0]/.test(value);
}

function validParentId(value: unknown): value is string | null {
	return value === null || validSourceEntryId(value);
}

function validateBranch(branch: readonly PiBranchEntry[]): boolean {
	const seen = new Set<string>();
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (!entry || typeof entry !== "object" || typeof entry.type !== "string") return false;
		if (!validSourceEntryId(entry.id) || seen.has(entry.id)) return false;
		if (entry.parentId !== null && typeof entry.parentId !== "string") return false;
		if (index === 0 ? entry.parentId !== null : entry.parentId !== branch[index - 1].id) return false;
		seen.add(entry.id);
	}
	return true;
}

function prepareRoot(root: string): string {
	ensurePrivateDirectory(root);
	return root;
}

function safePath(root: string, ...parts: string[]): string {
	const path = join(root, ...parts);
	if (!isContained(root, path)) throw new Error("path escaped root");
	return path;
}

function textFrom(content: unknown, maxBytes: number = SERIALIZATION_POLICY.maxTextBytes): string {
	if (typeof content === "string") return truncateUtf8(content, maxBytes);
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const raw of content.slice(0, SERIALIZATION_POLICY.contentBlocks)) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Record<string, unknown>;
		if (block.type !== "text" || typeof block.text !== "string") continue;
		const separator = text ? "\n" : "";
		const remaining = maxBytes - Buffer.byteLength(text, "utf8") - Buffer.byteLength(separator, "utf8");
		if (remaining <= 0) break;
		text += separator + truncateUtf8(block.text, remaining);
		if (Buffer.byteLength(text, "utf8") >= maxBytes) break;
	}
	return text;
}

type WorkBudget = { remaining: number };

type BoundedKeyEntry = { safe: string; value: unknown; collision: boolean };
type BoundedKeys = { entries: BoundedKeyEntry[]; truncated: boolean; observed: number };

function boundedKeyEntries(source: Record<string, unknown>): BoundedKeys {
	const bySafe = new Map<string, BoundedKeyEntry>();
	let observed = 0;
	let truncated = false;
	let inspected = 0;
	for (const original in source) {
		inspected += 1;
		if (Object.prototype.hasOwnProperty.call(source, original)) {
			observed += 1;
			const safe = truncateUtf8(original, SERIALIZATION_POLICY.argumentStringBytes, "[truncated]");
			const prior = bySafe.get(safe);
			if (prior) prior.collision = true;
			else bySafe.set(safe, { safe, value: source[original], collision: false });
		}
		// Conservative at exactly the cap: never inspect an additional key merely to prove exhaustion.
		if (inspected >= SERIALIZATION_POLICY.argumentObjectKeys) { truncated = true; break; }
	}
	const entries = [...bySafe.values()].sort((a, b) => a.safe < b.safe ? -1 : a.safe > b.safe ? 1 : 0);
	return { entries, truncated, observed };
}

function stableObject(keys: BoundedKeys, depth: number, budget: WorkBudget): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const entry of keys.entries) {
		result[entry.safe] = entry.collision ? "[key collision omitted]" : stableValue(entry.value, entry.safe, depth + 1, budget);
	}
	if (keys.truncated) result["[keys truncated]"] = true;
	return result;
}

function stableValue(value: unknown, key = "", depth = 0, budget: WorkBudget = { remaining: SERIALIZATION_POLICY.argumentNodes }): unknown {
	if (budget.remaining-- <= 0) return "[node budget truncated]";
	if (SECRET_KEY.test(key)) return "[REDACTED]";
	if (BINARY_KEY.test(key) || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return "[binary omitted]";
	if (depth >= SERIALIZATION_POLICY.argumentDepth) return "[depth truncated]";
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return truncateUtf8(value, SERIALIZATION_POLICY.argumentStringBytes, "[truncated]");
	if (Array.isArray(value)) return value.slice(0, SERIALIZATION_POLICY.argumentArrayItems).map((item) => stableValue(item, "", depth + 1, budget));
	if (typeof value === "object") return stableObject(boundedKeyEntries(value as Record<string, unknown>), depth, budget);
	return truncateUtf8(String(value), SERIALIZATION_POLICY.argumentStringBytes, "[truncated]");
}

/** Privacy-safe argument metadata: no raw key names or values are persisted. */
function boundedArguments(value: unknown, maxBytes: number): Record<string, unknown> {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
	const keys = boundedKeyEntries(source);
	const budget = { remaining: SERIALIZATION_POLICY.argumentNodes - 1 };
	const serialized = JSON.stringify(stableObject(keys, 0, budget));
	const result: Record<string, unknown> = {
		_pi_argument_count: keys.observed,
		...(keys.truncated ? { _pi_argument_count_truncated: true } : {}),
		sha256: hash(serialized),
		...(Buffer.byteLength(serialized, "utf8") > maxBytes ? { _pi_truncated: true } : {}),
	};
	const keyHashes: string[] = [];
	for (const { safe } of keys.entries.slice(0, SERIALIZATION_POLICY.argumentKeyHashes)) {
		const candidate = [...keyHashes, hash(safe)];
		if (Buffer.byteLength(JSON.stringify({ ...result, _pi_argument_key_hashes: candidate }), "utf8") > maxBytes) break;
		keyHashes.push(candidate[candidate.length - 1]);
	}
	if (keyHashes.length) result._pi_argument_key_hashes = keyHashes;
	return result;
}

function isRememberCustom(entry: PiBranchEntry, message?: Record<string, unknown>): boolean {
	const customType = typeof entry.customType === "string" ? entry.customType
		: typeof message?.customType === "string" ? message.customType : "";
	return customType === "remember" || customType.startsWith("pi-remember");
}

function sourceFingerprintFor(sourceEntryId: string, parentId: string | null): string {
	return hash(JSON.stringify({ id: sourceEntryId, parentId }));
}

/** Copied Pi lineage preserves entry identity even when normalization policy changes. */
function sourceFingerprint(entry: PiBranchEntry): string {
	return sourceFingerprintFor(entry.id, entry.parentId);
}

function normalizedPayload(entry: PiBranchEntry, maxTextBytes: number, maxToolArgumentBytes: number): Record<string, unknown> | undefined {
	if (entry.type === "message") {
		const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : {};
		const role = message.role;
		if (isRememberCustom(entry, message)) return undefined;
		if (role === "user") {
			const text = textFrom(message.content, maxTextBytes);
			return { type: "user", message: { content: text ? [{ type: "text", text }] : [] } };
		}
		if (role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
			const blocks: Record<string, unknown>[] = [];
			const text = textFrom(content, maxTextBytes);
			if (text) blocks.push({ type: "text", text });
			let toolCalls = 0;
			let omittedToolCalls = 0;
			for (const raw of content.slice(0, SERIALIZATION_POLICY.contentBlocks)) {
				if (!raw || typeof raw !== "object") continue;
				const block = raw as Record<string, unknown>;
				if (block.type !== "toolCall" || typeof block.name !== "string") continue;
				if (toolCalls++ >= SERIALIZATION_POLICY.maxToolCalls) { omittedToolCalls = 1; break; }
				blocks.push({
					type: "tool_use",
					id: truncateUtf8(typeof block.id === "string" ? block.id : entry.id, SERIALIZATION_POLICY.identifierBytes, "[truncated]"),
					name: truncateUtf8(block.name, SERIALIZATION_POLICY.identifierBytes, "[truncated]"),
					input: boundedArguments(block.arguments ?? {}, maxToolArgumentBytes),
				});
			}
			return { type: "assistant", message: { content: blocks }, ...(omittedToolCalls ? { toolCallsTruncated: true, omittedToolCalls } : {}) };
		}
		if (role === "toolResult") {
			return {
				type: "progress",
				source: "pi-tool-result",
				toolCallId: typeof message.toolCallId === "string" ? truncateUtf8(message.toolCallId, SERIALIZATION_POLICY.identifierBytes, "[truncated]") : "",
				toolName: typeof message.toolName === "string" ? truncateUtf8(message.toolName, SERIALIZATION_POLICY.identifierBytes, "[truncated]") : "",
			};
		}
		return { type: "progress", source: "pi-message", role: typeof role === "string" ? truncateUtf8(role, SERIALIZATION_POLICY.roleBytes, "[truncated]") : "unknown" };
	}
	if (entry.type === "custom_message" && isRememberCustom(entry)) return undefined;
	if (entry.type === "compaction") return { type: "summary", source: "pi-compaction", summary: truncateUtf8(typeof entry.summary === "string" ? entry.summary : "", maxTextBytes) };
	if (entry.type === "branch_summary") return { type: "progress", source: "pi-branch-summary", summary: truncateUtf8(typeof entry.summary === "string" ? entry.summary : "", maxTextBytes) };
	return { type: "progress", source: `pi-${truncateUtf8(entry.type, SERIALIZATION_POLICY.typeBytes, "[truncated]")}` };
}

export function normalizeEntry(
	entry: PiBranchEntry,
	options: { normalizerVersion?: string; maxTextBytes?: number; maxToolArgumentBytes?: number } = {},
): NormalizedRecord | undefined {
	const normalizerVersion = options.normalizerVersion ?? DEFAULT_NORMALIZER_VERSION;
	const maxTextBytes = boundedLimit(options.maxTextBytes, SERIALIZATION_POLICY.defaultTextBytes, SERIALIZATION_POLICY.maxTextBytes);
	const maxToolArgumentBytes = boundedLimit(options.maxToolArgumentBytes, SERIALIZATION_POLICY.defaultToolArgumentBytes, SERIALIZATION_POLICY.maxToolArgumentBytes);
	const payload = normalizedPayload(entry, maxTextBytes, maxToolArgumentBytes);
	if (!payload) return undefined;
	const meta: RecordMetadata = {
		sourceEntryId: entry.id,
		sourceFingerprint: sourceFingerprint(entry),
		normalizedFingerprint: hash(JSON.stringify(payload)),
		parentId: entry.parentId,
		policyId: policyId(normalizerVersion, maxTextBytes, maxToolArgumentBytes),
	};
	return { ...payload, _piRemember: meta };
}

function lineFor(record: NormalizedRecord): string {
	return `${JSON.stringify(record)}\n`;
}

function privateRegularFile(path: string): boolean {
	try {
		const info = lstatSync(path);
		return !info.isSymbolicLink() && info.isFile() && info.nlink === 1;
	} catch { return false; }
}

function fileHash(path: string, bytes?: number): string {
	const content = readFileSync(path);
	return hash(bytes === undefined ? content : content.subarray(0, bytes));
}

/** Returns the maximal valid newline-delimited prefix and identifies a torn tail. */
function scanProjection(path: string): Scan {
	if (!privateRegularFile(path)) return { records: [], lines: [], bytes: 0, validBytes: 0, valid: false, torn: false, recoverableTail: false, sha256: "" };
	chmodSync(path, 0o600);
	const buffer = readFileSync(path);
	const records: NormalizedRecord[] = [];
	const lines: string[] = [];
	let offset = 0;
	let validBytes = 0;
	let malformed = false;
	let recoverableTail = false;
	while (offset < buffer.length) {
		const newline = buffer.indexOf(0x0a, offset);
		if (newline < 0) { malformed = true; recoverableTail = true; break; }
		const bytes = buffer.subarray(offset, newline);
		try {
			const line = bytes.toString("utf8");
			const parsed = JSON.parse(line) as NormalizedRecord;
			if (!parsed || typeof parsed !== "object" || !parsed._piRemember) throw new Error("metadata missing");
			const meta = parsed._piRemember;
			if (!validSourceEntryId(meta.sourceEntryId) || !validParentId(meta.parentId) ||
				meta.sourceFingerprint !== sourceFingerprintFor(meta.sourceEntryId, meta.parentId) ||
				!/^[0-9a-f]{64}$/.test(meta.normalizedFingerprint) || !/^[0-9a-f]{64}$/.test(meta.policyId)) throw new Error("metadata invalid");
			const { _piRemember: _metadata, ...payload } = parsed;
			if (hash(JSON.stringify(payload)) !== meta.normalizedFingerprint) throw new Error("payload fingerprint mismatch");
			records.push(parsed);
			lines.push(line);
			validBytes = newline + 1;
			offset = newline + 1;
		} catch { malformed = true; break; }
	}
	const torn = malformed || validBytes !== buffer.length;
	return { records, lines, bytes: buffer.length, validBytes, valid: !torn, torn, recoverableTail, sha256: hash(buffer.subarray(0, validBytes)) };
}

function atomicJson(path: string, value: unknown): void {
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
		fsyncSync(fd);
	} finally { closeSync(fd); }
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	chmodSync(path, 0o600);
	syncDirectory(dirname(path));
}

function appendDurable(path: string, data: string, create: boolean): number {
	const flags = constants.O_WRONLY | constants.O_APPEND | (create ? constants.O_CREAT | constants.O_EXCL : 0) | (constants.O_NOFOLLOW ?? 0);
	const fd = openSync(path, flags, 0o600);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1) throw new Error("projection is not private");
		fchmodSync(fd, 0o600);
		const buffer = Buffer.from(data, "utf8");
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
		fsyncSync(fd);
		return buffer.length;
	} finally { closeSync(fd); }
}

function processStart(pid: number): string | undefined {
	try {
		const fields = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" ");
		return fields[21];
	} catch { return undefined; }
}

type LockOwner = { pid: number; start?: string; nonce: string; ticket?: number };

function ownerAlive(owner: LockOwner): boolean {
	if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
	try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
	const start = processStart(owner.pid);
	return !owner.start || !start || owner.start === start;
}

function readLock(path: string): LockOwner {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("unsafe lock claim");
	const value = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
	if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)) throw new Error("invalid lock claim");
	if (value.start !== undefined && typeof value.start !== "string") throw new Error("invalid lock claim");
	if (value.ticket !== undefined && (!Number.isSafeInteger(value.ticket) || value.ticket < 1)) throw new Error("invalid lock claim");
	return value;
}

function writeClaim(path: string, owner: LockOwner): void {
	// Leading dot keeps unpublished files outside both live claim prefixes.
	const temp = join(dirname(path), `.${basename(path)}.publishing.${process.pid}.${randomBytes(8).toString("hex")}`);
	try {
		const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		// The final claim appears only after its complete contents are durable.
		renameSync(temp, path);
		syncDirectory(dirname(path));
	} catch (error) {
		try { unlinkSync(temp); } catch { /* absent or already published */ }
		throw error;
	}
}

function claimPaths(base: string, kind: "choosing" | "claim"): string[] {
	const prefix = `${basename(base)}.${kind}.`;
	return readdirSync(dirname(base)).filter((name) => name.startsWith(prefix)).map((name) => join(dirname(base), name));
}

function liveClaims(base: string, kind: "choosing" | "claim"): Array<{ path: string; owner: LockOwner }> {
	const live: Array<{ path: string; owner: LockOwner }> = [];
	for (const path of claimPaths(base, kind)) {
		let owner: LockOwner;
		try { owner = readLock(path); } catch (error) {
			// A claim may disappear after directory enumeration; every other safety/read failure blocks acquisition.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (ownerAlive(owner)) live.push({ path, owner });
		else {
			// Claim paths contain random nonces and are immutable, so confirmed-dead cleanup cannot unlink a replacement owner.
			try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	return live;
}

/** Lamport bakery lock using immutable, uniquely named claims; safe stale cleanup needs no path replacement. */
async function acquireLock(path: string, timeoutMs: number): Promise<() => void> {
	const deadline = Date.now() + timeoutMs;
	const nonce = randomBytes(16).toString("hex");
	const owner: LockOwner = { pid: process.pid, start: processStart(process.pid), nonce };
	const choosingPath = `${path}.choosing.${nonce}`;
	const claimPath = `${path}.claim.${nonce}`;
	let claimed = false;
	try {
		writeClaim(choosingPath, owner);
		const tickets = liveClaims(path, "claim").map(({ owner: candidate }) => candidate.ticket ?? 0);
		owner.ticket = Math.max(0, ...tickets) + 1;
		writeClaim(claimPath, owner);
		claimed = true;
		unlinkSync(choosingPath);
		syncDirectory(dirname(path));

		while (true) {
			const choosing = liveClaims(path, "choosing");
			const blockers = liveClaims(path, "claim").filter(({ owner: candidate }) =>
				candidate.nonce !== nonce &&
				((candidate.ticket ?? 0) < owner.ticket! || ((candidate.ticket ?? 0) === owner.ticket && candidate.nonce < nonce)),
			);
			if (choosing.length === 0 && blockers.length === 0) {
				return () => {
					if (readLock(claimPath).nonce !== nonce) throw new Error("lock ownership lost");
					unlinkSync(claimPath);
					syncDirectory(dirname(path));
				};
			}
			if (Date.now() >= deadline) throw new Error("lock timeout");
			await delay(10);
		}
	} catch (error) {
		try { unlinkSync(choosingPath); } catch { /* absent */ }
		if (claimed) try { unlinkSync(claimPath); } catch { /* absent */ }
		throw error;
	}
}

function lineage(branch: readonly PiBranchEntry[]): ProjectionLineageEntry[] {
	return branch.map(({ id, parentId }) => ({ id, parentId }));
}

function sameLineage(a: readonly ProjectionLineageEntry[], b: readonly ProjectionLineageEntry[]): boolean {
	return a.length === b.length && a.every((item, index) => item.id === b[index].id && item.parentId === b[index].parentId);
}

function prefixOf(prefix: readonly ProjectionLineageEntry[], full: readonly ProjectionLineageEntry[]): boolean {
	return prefix.length <= full.length && prefix.every((item, index) => item.id === full[index].id && item.parentId === full[index].parentId);
}

function stateValid(value: unknown, sessionId: string, key: string): value is ProjectionRegistry {
	if (!value || typeof value !== "object") return false;
	const state = value as ProjectionRegistry;
	if (state.schemaVersion !== SCHEMA_VERSION || state.sessionId !== sessionId || state.sessionKey !== key) return false;
	if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.currentEpoch) || !Array.isArray(state.epochs)) return false;
	const epochs = new Set<number>();
	for (const epoch of state.epochs) {
		if (!epoch || !Number.isSafeInteger(epoch.epoch) || epoch.epoch < 1 || epochs.has(epoch.epoch)) return false;
		epochs.add(epoch.epoch);
		if (epoch.hostSessionId !== deriveHostSessionId(sessionId, epoch.epoch)) return false;
		if (epoch.projection !== `transcripts/${key}/${epoch.epoch}.jsonl`) return false;
		if (epoch.policyId !== policyId(epoch.normalizerVersion, epoch.maxTextBytes, epoch.maxToolArgumentBytes)) return false;
		if (!Array.isArray(epoch.lineage) || !Array.isArray(epoch.recordSourceIds) || !Array.isArray(epoch.recordFingerprints)) return false;
		if (epoch.recordSourceIds.length !== epoch.recordFingerprints.length || !epoch.recordFingerprints.every((id) => /^[0-9a-f]{64}$/.test(id))) return false;
		for (let index = 0; index < epoch.lineage.length; index++) {
			const item = epoch.lineage[index];
			if (!item || typeof item.id !== "string" || !item.id || (index === 0 ? item.parentId !== null : item.parentId !== epoch.lineage[index - 1].id)) return false;
		}
		if (!Number.isSafeInteger(epoch.durableBytes) || epoch.durableBytes < 0 || !/^[0-9a-f]{64}$/.test(epoch.projectionSha256)) return false;
	}
	return epochs.has(state.currentEpoch);
}

function readState(path: string, sessionId: string, key: string): { state?: ProjectionRegistry; corrupt: boolean } {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) return { corrupt: true };
		chmodSync(path, 0o600);
		const value = JSON.parse(readFileSync(path, "utf8"));
		return stateValid(value, sessionId, key) ? { state: value, corrupt: false } : { corrupt: true };
	} catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { corrupt: false } : { corrupt: true }; }
}

function archive(path: string): void {
	try { renameSync(path, `${path}.corrupt.${randomBytes(8).toString("hex")}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function epochPath(root: string, key: string, epoch: number): { relative: string; absolute: string } {
	return { relative: `transcripts/${key}/${epoch}.jsonl`, absolute: safePath(root, "transcripts", key, `${epoch}.jsonl`) };
}

function existingEpochs(root: string, key: string): number[] {
	try {
		return readdirSync(safePath(root, "transcripts", key)).map((name) => /^(\d+)\.jsonl$/.exec(name)?.[1])
			.filter((value): value is string => !!value).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
	} catch { return []; }
}

function nextEpoch(state: ProjectionRegistry | undefined, root: string, key: string): number {
	return Math.max(0, ...(state?.epochs.map(({ epoch }) => epoch) ?? []), ...existingEpochs(root, key)) + 1;
}

function current(state: ProjectionRegistry): ProjectionEpochState | undefined {
	return state.epochs.find(({ epoch }) => epoch === state.currentEpoch);
}

function scanBranchLength(scan: Scan, branch: readonly PiBranchEntry[], policy: { normalizerVersion: string; maxTextBytes: number; maxToolArgumentBytes: number }): number {
	if (scan.torn) return -1;
	let branchIndex = -1;
	for (let index = 0; index < scan.records.length; index++) {
		const record = scan.records[index];
		const found = branch.findIndex((entry, candidate) => candidate > branchIndex && sourceFingerprint(entry) === record._piRemember.sourceFingerprint);
		if (found < 0) return -1;
		branchIndex = found;
		const expected = normalizeEntry(branch[found], policy);
		if (!expected || JSON.stringify(expected) !== scan.lines[index]) return -1;
	}
	return branchIndex + 1;
}

function rebuildOwnership(root: string): OwnershipRegistry {
	const claims: OwnershipRegistry["claims"] = {};
	const transcripts = safePath(root, "transcripts");
	for (const key of readdirSync(transcripts)) {
		if (!/^[0-9a-f]{64}$/.test(key)) continue;
		const directory = safePath(transcripts, key);
		const info = lstatSync(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe transcript directory");
		for (const name of readdirSync(directory)) {
			const match = /^(\d+)\.jsonl$/.exec(name);
			if (!match) continue;
			const epoch = Number(match[1]);
			if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid transcript epoch");
			const scan = scanProjection(epochPath(root, key, epoch).absolute);
			if (!scan.valid) throw new Error("unsafe or unreadable transcript");
			for (const record of scan.records) claims[record._piRemember.sourceFingerprint] ??= { sessionKey: key, epoch, sourceEntryId: record._piRemember.sourceEntryId };
		}
	}
	return { schemaVersion: 1, claims };
}

function ownershipValid(value: unknown): value is OwnershipRegistry {
	if (!value || typeof value !== "object") return false;
	const ownership = value as OwnershipRegistry;
	if (ownership.schemaVersion !== 1 || !ownership.claims || typeof ownership.claims !== "object" || Array.isArray(ownership.claims)) return false;
	for (const [fingerprint, claim] of Object.entries(ownership.claims)) {
		if (!/^[0-9a-f]{64}$/.test(fingerprint) || !claim || typeof claim !== "object") return false;
		if (!/^[0-9a-f]{64}$/.test(claim.sessionKey) || !Number.isSafeInteger(claim.epoch) || claim.epoch < 1) return false;
		if (!validSourceEntryId(claim.sourceEntryId)) return false;
	}
	return true;
}

function readOwnership(path: string, root: string): { ownership: OwnershipRegistry; rebuilt: boolean } {
	let text: string;
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("unsafe ownership");
		chmodSync(path, 0o600);
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { ownership: rebuildOwnership(root), rebuilt: true };
	}
	try {
		const value = JSON.parse(text) as unknown;
		if (!ownershipValid(value)) throw new Error("invalid ownership");
		return { ownership: value, rebuilt: false };
	} catch {
		archive(path);
		return { ownership: rebuildOwnership(root), rebuilt: true };
	}
}

function recoverOrphan(
	root: string,
	sessionId: string,
	key: string,
	branch: readonly PiBranchEntry[],
	policy: { normalizerVersion: string; maxTextBytes: number; maxToolArgumentBytes: number },
): ProjectionRegistry | undefined {
	for (const epoch of existingEpochs(root, key).sort((a, b) => b - a)) {
		const path = epochPath(root, key, epoch);
		let scan = scanProjection(path.absolute);
		if (scan.recoverableTail && scan.validBytes <= scan.bytes) {
			truncateDurable(path.absolute, scan.validBytes);
			scan = scanProjection(path.absolute);
		}
		const branchLength = scanBranchLength(scan, branch, policy);
		if (!scan.valid || branchLength < 0) continue;
		return {
			schemaVersion: 2,
			sessionId,
			sessionKey: key,
			revision: 0,
			currentEpoch: epoch,
			epochs: [{
				epoch,
				hostSessionId: deriveHostSessionId(sessionId, epoch),
				projection: path.relative,
				normalizerVersion: policy.normalizerVersion,
				maxTextBytes: policy.maxTextBytes,
				maxToolArgumentBytes: policy.maxToolArgumentBytes,
				policyId: policyId(policy.normalizerVersion, policy.maxTextBytes, policy.maxToolArgumentBytes),
				lineage: lineage(branch.slice(0, branchLength)),
				recordSourceIds: scan.records.map((record) => record._piRemember.sourceEntryId),
				recordFingerprints: scan.records.map((record) => record._piRemember.sourceFingerprint),
				durableBytes: scan.bytes,
				projectionSha256: scan.sha256,
			}],
		};
	}
	return undefined;
}

function repairAndScan(path: string, epoch: ProjectionEpochState): { scan: Scan; recovered: boolean; inconsistent: boolean } {
	let scan = scanProjection(path);
	if (!privateRegularFile(path)) return { scan, recovered: false, inconsistent: true };
	if (epoch.durableBytes > scan.validBytes || fileHash(path, epoch.durableBytes) !== epoch.projectionSha256) return { scan, recovered: false, inconsistent: true };
	let recovered = false;
	if (scan.recoverableTail) {
		truncateDurable(path, scan.validBytes);
		scan = scanProjection(path);
		recovered = true;
	}
	if (scan.torn) return { scan, recovered, inconsistent: true };
	return { scan, recovered, inconsistent: false };
}

/** Publish one active Pi lineage without rewriting any consumed projection. */
export async function projectBranch(options: ProjectBranchOptions): Promise<ProjectionResult> {
	if (!validateSessionId(options.sessionId)) return refused("invalid-session");
	if (!validateBranch(options.branch)) return refused("invalid-branch");
	const policy = {
		normalizerVersion: options.normalizerVersion ?? DEFAULT_NORMALIZER_VERSION,
		maxTextBytes: options.maxTextBytes ?? SERIALIZATION_POLICY.defaultTextBytes,
		maxToolArgumentBytes: options.maxToolArgumentBytes ?? SERIALIZATION_POLICY.defaultToolArgumentBytes,
	};
	if (!policy.normalizerVersion || policy.normalizerVersion.length > SERIALIZATION_POLICY.normalizerVersionChars || /[\r\n\0]/.test(policy.normalizerVersion)) return refused("invalid-policy");
	if (boundedLimit(policy.maxTextBytes, -1, SERIALIZATION_POLICY.maxTextBytes) !== policy.maxTextBytes ||
		boundedLimit(policy.maxToolArgumentBytes, -1, SERIALIZATION_POLICY.maxToolArgumentBytes) !== policy.maxToolArgumentBytes) return refused("invalid-policy");
	const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 60_000) return refused("invalid-policy");
	const currentPolicy = policyId(policy.normalizerVersion, policy.maxTextBytes, policy.maxToolArgumentBytes);
	let root: string;
	try { root = prepareRoot(options.root); } catch { return refused("unsafe-root"); }
	const key = sessionKey(options.sessionId);
	try {
		ensurePrivateDirectory(safePath(root, "registry"));
		ensurePrivateDirectory(safePath(root, "transcripts", key));
		ensurePrivateDirectory(safePath(root, "locks"));
	} catch { return refused("unsafe-root"); }
	const registryPath = safePath(root, "registry", `${key}.json`);
	const ownershipPath = safePath(root, "registry", "ownership.json");
	const lockPath = safePath(root, "locks", "projection-global.lock");
	let release: (() => void) | undefined;
	try { release = await acquireLock(lockPath, lockTimeoutMs); } catch { return refused("lock-timeout"); }
	try {
		const loaded = readState(registryPath, options.sessionId, key);
		if (loaded.corrupt) archive(registryPath);
		let state = loaded.state;
		let recovered = false;
		if (!state) {
			state = recoverOrphan(root, options.sessionId, key, options.branch, policy);
			if (state) recovered = true;
		}
		state ??= { schemaVersion: 2, sessionId: options.sessionId, sessionKey: key, revision: 0, currentEpoch: 0, epochs: [] };
		const ownershipResult = readOwnership(ownershipPath, root);
		const ownership = ownershipResult.ownership;
		if (ownershipResult.rebuilt) atomicJson(ownershipPath, ownership);
		let epoch = current(state);
		let createReason: ProjectionReason | undefined;

		if (epoch) {
			const path = safePath(root, ...epoch.projection.split("/"));
			if (!privateRegularFile(path)) {
				try { lstatSync(path); createReason = "inconsistent-projection"; } catch { createReason = "missing-projection"; }
			} else {
				const repaired = repairAndScan(path, epoch);
				if (repaired.inconsistent) createReason = "inconsistent-projection";
				else {
					const ids = repaired.scan.records.map((record) => record._piRemember.sourceEntryId);
					const fingerprints = repaired.scan.records.map((record) => record._piRemember.sourceFingerprint);
					if (ids.length < epoch.recordSourceIds.length || !epoch.recordSourceIds.every((id, index) => id === ids[index])) createReason = "inconsistent-projection";
					else if (ids.length > epoch.recordSourceIds.length && scanBranchLength(repaired.scan, options.branch, {
						normalizerVersion: epoch.normalizerVersion,
						maxTextBytes: epoch.maxTextBytes,
						maxToolArgumentBytes: epoch.maxToolArgumentBytes,
					}) < 0) createReason = "inconsistent-projection";
					else if (repaired.recovered || ids.length !== epoch.recordSourceIds.length || repaired.scan.bytes !== epoch.durableBytes) {
						epoch.recordSourceIds = ids;
						epoch.recordFingerprints = fingerprints;
						epoch.durableBytes = repaired.scan.bytes;
						epoch.projectionSha256 = repaired.scan.sha256;
						for (const record of repaired.scan.records) ownership.claims[record._piRemember.sourceFingerprint] ??= { sessionKey: key, epoch: epoch.epoch, sourceEntryId: record._piRemember.sourceEntryId };
						recovered = true;
					}
				}
			}
			if (!createReason && epoch.policyId !== currentPolicy) createReason = "normalizer-change";
			if (!createReason) {
				const now = lineage(options.branch);
				if (sameLineage(epoch.lineage, now)) {
					// Re-hash every repeat, so same-length mutation cannot pass as unchanged.
					const scan = scanProjection(path);
					if (scan.sha256 !== epoch.projectionSha256) createReason = "inconsistent-projection";
					else {
						state.revision += recovered ? 1 : 0;
						if (recovered || loaded.corrupt) { atomicJson(ownershipPath, ownership); atomicJson(registryPath, state); }
						return { ok: true, disposition: recovered || loaded.corrupt ? "recovered" : "unchanged", reason: loaded.corrupt ? "registry-corrupt" : recovered ? "orphan-projection" : "exact-repeat", state, projectionPath: path, registryPath, appendedRecords: 0, appendedBytes: 0, recoveredRecords: recovered ? epoch.recordSourceIds.length : 0, epochCreated: false };
					}
				}
				if (!createReason && !prefixOf(epoch.lineage, now)) createReason = now.length < epoch.lineage.length && prefixOf(now, epoch.lineage) ? "prefix-shrink" : "lineage-divergence";
			}
		}

		let epochCreated = false;
		if (!epoch || createReason) {
			const number = nextEpoch(state, root, key);
			const path = epochPath(root, key, number);
			epoch = {
				epoch: number,
				hostSessionId: deriveHostSessionId(options.sessionId, number),
				projection: path.relative,
				normalizerVersion: policy.normalizerVersion,
				maxTextBytes: policy.maxTextBytes,
				maxToolArgumentBytes: policy.maxToolArgumentBytes,
				policyId: currentPolicy,
				lineage: [],
				recordSourceIds: [],
				recordFingerprints: [],
				durableBytes: 0,
				projectionSha256: hash(""),
			};
			state.epochs.push(epoch);
			state.currentEpoch = number;
			epochCreated = true;
			createReason ??= loaded.corrupt ? "registry-corrupt" : recovered ? "orphan-projection" : state.epochs.length === 1 ? "first-projection" : "registry-missing";
		}

		const additions = options.branch.slice(epoch.lineage.length);
		const normalized = additions.map((entry) => normalizeEntry(entry, policy)).filter((record): record is NormalizedRecord => !!record);
		// Global claims survive epochs and forked Pi sessions, so common history is never emitted under a fresh Remember cursor.
		const records = normalized.filter((record) => ownership.claims[record._piRemember.sourceFingerprint] === undefined);
		const data = records.map(lineFor).join("");
		const path = safePath(root, ...epoch.projection.split("/"));
		const appendedBytes = appendDurable(path, data, epochCreated);
		if (epochCreated) syncDirectory(dirname(path));
		options.onProjectionSynced?.(path);
		epoch.lineage.push(...lineage(additions));
		epoch.recordSourceIds.push(...records.map((record) => record._piRemember.sourceEntryId));
		epoch.recordFingerprints.push(...records.map((record) => record._piRemember.sourceFingerprint));
		epoch.durableBytes += appendedBytes;
		epoch.projectionSha256 = fileHash(path);
		for (const record of records) ownership.claims[record._piRemember.sourceFingerprint] = { sessionKey: key, epoch: epoch.epoch, sourceEntryId: record._piRemember.sourceEntryId };
		// Projection is durable first, then reconstructable ownership, then the session cursor.
		atomicJson(ownershipPath, ownership);
		state.revision += 1;
		atomicJson(registryPath, state);
		return {
			ok: true,
			disposition: epochCreated ? "epoch-created" : recovered ? "recovered" : additions.length ? "appended" : "unchanged",
			reason: createReason ?? (recovered ? "orphan-projection" : "strict-extension"),
			state,
			projectionPath: path,
			registryPath,
			appendedRecords: records.length,
			appendedBytes,
			recoveredRecords: recovered ? epoch.recordSourceIds.length - records.length : 0,
			epochCreated,
		};
	} catch (error) {
		if (options.onProjectionSynced) throw error;
		return refused("io-error");
	} finally { release?.(); }
}
