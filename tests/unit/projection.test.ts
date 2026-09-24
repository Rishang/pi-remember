import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
	deriveHostSessionId,
	normalizeEntry,
	projectBranch,
	type PiBranchEntry,
	type ProjectionResult,
} from "../../src/projection.ts";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-remember-projection-"));
	temporary.push(path);
	return path;
}

function user(id: string, parentId: string | null, text = id): PiBranchEntry {
	return { type: "message", id, parentId, message: { role: "user", content: text } };
}

function assistant(id: string, parentId: string, text = id, tool?: Record<string, unknown>): PiBranchEntry {
	return {
		type: "message",
		id,
		parentId,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				...(tool ? [{ type: "toolCall", id: `${id}-tool`, name: "bash", arguments: tool }] : []),
			],
		},
	};
}

function toolResult(id: string, parentId: string, output = "RAW_TOOL_SECRET"): PiBranchEntry {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "toolResult", toolCallId: `${parentId}-tool`, toolName: "bash", content: output },
	};
}

function lines(result: ProjectionResult): Array<Record<string, unknown>> {
	assert.equal(result.ok, true);
	assert.ok(result.projectionPath);
	const text = readFileSync(result.projectionPath, "utf8");
	return text ? text.trimEnd().split("\n").map((line) => JSON.parse(line)) : [];
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

async function runWorker(root: string, sessionId: string, branchPath: string): Promise<Record<string, unknown>> {
	const helper = fileURLToPath(new URL("../helpers/projection-worker.ts", import.meta.url));
	const child = spawn(process.execPath, ["--experimental-strip-types", helper, root, sessionId, branchPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	assert.equal(code, 0, stderr);
	return JSON.parse(stdout) as Record<string, unknown>;
}

const straight = [user("a", null, "hello"), assistant("b", "a", "working")];

test("first projection creates deterministic identity, private files, and one record per relevant entry", async () => {
	const root = temp();
	const result = await projectBranch({ root, sessionId: "ephemeral-session", branch: straight });
	assert.equal(result.disposition, "epoch-created");
	assert.equal(result.reason, "first-projection");
	assert.equal(result.epochCreated, true);
	assert.equal(result.appendedRecords, 2);
	assert.ok(result.appendedBytes > 0);
	assert.equal(result.state?.currentEpoch, 1);
	assert.equal(result.state?.epochs[0].hostSessionId, deriveHostSessionId("ephemeral-session", 1));
	assert.match(result.state!.epochs[0].hostSessionId, /^[0-9a-f]{64}$/);
	assert.equal(mode(root), 0o700);
	assert.equal(mode(dirname(result.projectionPath!)), 0o700);
	assert.equal(mode(result.projectionPath!), 0o600);
	assert.equal(mode(result.registryPath!), 0o600);
	assert.equal(lines(result).length, 2);
	assert.doesNotMatch(result.projectionPath!, /\.remember/);
});

test("strict extension appends only new bytes; exact repeat and restart are idempotent", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "session-1", branch: straight });
	const before = readFileSync(first.projectionPath!);
	const branch = [...straight, toolResult("c", "b")];
	const appended = await projectBranch({ root, sessionId: "session-1", branch });
	assert.equal(appended.disposition, "appended");
	assert.equal(appended.reason, "strict-extension");
	assert.equal(appended.epochCreated, false);
	assert.equal(appended.appendedRecords, 1);
	const after = readFileSync(appended.projectionPath!);
	assert.deepEqual(after.subarray(0, before.length), before);
	assert.equal(after.length - before.length, appended.appendedBytes);

	const repeated = await projectBranch({ root, sessionId: "session-1", branch });
	assert.equal(repeated.disposition, "unchanged");
	assert.equal(repeated.reason, "exact-repeat");
	assert.equal(repeated.appendedBytes, 0);
	assert.deepEqual(readFileSync(repeated.projectionPath!), after);

	const restarted = await projectBranch({ root, sessionId: "session-1", branch, previousState: first.state });
	assert.equal(restarted.disposition, "unchanged");
	assert.deepEqual(readFileSync(restarted.projectionPath!), after);
});

test("prefix shrink and tree divergence freeze the old projection and create immutable epochs", async () => {
	const root = temp();
	const full = [...straight, user("c", "b", "third")];
	const first = await projectBranch({ root, sessionId: "tree", branch: full });
	const frozen = readFileSync(first.projectionPath!);
	const shrunk = await projectBranch({ root, sessionId: "tree", branch: straight });
	assert.equal(shrunk.reason, "prefix-shrink");
	assert.equal(shrunk.epochCreated, true);
	assert.equal(shrunk.appendedRecords, 0, "shared records remain owned by the frozen epoch");
	assert.equal(lines(shrunk).length, 0);
	assert.equal(shrunk.state?.currentEpoch, 2);
	assert.notEqual(shrunk.projectionPath, first.projectionPath);
	assert.deepEqual(readFileSync(first.projectionPath!), frozen);

	const divergentBranch = [straight[0], assistant("x", "a", "other path")];
	const divergent = await projectBranch({ root, sessionId: "tree", branch: divergentBranch });
	assert.equal(divergent.reason, "lineage-divergence");
	assert.equal(divergent.state?.currentEpoch, 3);
	assert.equal(divergent.appendedRecords, 1);
	assert.deepEqual(lines(divergent).map((record) => (record._piRemember as Record<string, unknown>).sourceEntryId), ["x"]);
	assert.deepEqual(readFileSync(first.projectionPath!), frozen);
	assert.notEqual(divergent.state!.epochs[0].hostSessionId, divergent.state!.epochs[2].hostSessionId);
});

test("normalizer changes create a new epoch and distinct sessions never share identity", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "one", branch: straight, normalizerVersion: "1" });
	const changed = await projectBranch({ root, sessionId: "one", branch: straight, normalizerVersion: "2" });
	const other = await projectBranch({ root, sessionId: "two", branch: straight, normalizerVersion: "2" });
	assert.equal(changed.reason, "normalizer-change");
	assert.equal(changed.epochCreated, true);
	assert.equal(changed.appendedRecords, 0, "a policy change cannot put shared history under a fresh cursor");
	assert.equal(lines(changed).length, 0);
	assert.notEqual(first.state!.epochs[0].hostSessionId, changed.state!.epochs[1].hostSessionId);
	assert.notEqual(changed.state!.epochs[1].hostSessionId, other.state!.epochs[0].hostSessionId);
	assert.equal(deriveHostSessionId("one", 1), deriveHostSessionId("one", 1));
});

test("fork/new sessions and ephemeral IDs use independent registry and transcript paths", async () => {
	const root = temp();
	const parent = await projectBranch({ root, sessionId: "parent-uuid", branch: straight });
	const fork = await projectBranch({ root, sessionId: "fork-uuid", branch: straight });
	const ephemeral = await projectBranch({ root, sessionId: "memory-only-id", branch: [user("z", null)] });
	assert.notEqual(parent.registryPath, fork.registryPath);
	assert.notEqual(parent.projectionPath, fork.projectionPath);
	assert.equal(fork.appendedRecords, 0, "copied fork history has one durable owner across sessions");
	assert.equal(lines(fork).length, 0);
	assert.notEqual(fork.state!.epochs[0].hostSessionId, ephemeral.state!.epochs[0].hostSessionId);
});

test("normalization labels compaction and branch summaries without creating fake human messages", async () => {
	const root = temp();
	const branch: PiBranchEntry[] = [
		user("a", null),
		{ type: "compaction", id: "b", parentId: "a", summary: "compacted facts" },
		{ type: "branch_summary", id: "c", parentId: "b", summary: "abandoned branch" },
	];
	const result = await projectBranch({ root, sessionId: "summary", branch });
	const projected = lines(result);
	assert.equal(projected[1].type, "summary");
	assert.equal(projected[1].source, "pi-compaction");
	assert.equal(projected[2].type, "progress");
	assert.equal(projected[2].source, "pi-branch-summary");
	assert.notEqual(projected[1].type, "user");
});

test("parallel completion input preserves authoritative branch order", async () => {
	const root = temp();
	const branch = [
		user("a", null),
		assistant("b", "a", "tools", { command: "one" }),
		toolResult("result-second-finished-first", "b"),
		toolResult("result-first-finished-second", "result-second-finished-first"),
	];
	const result = await projectBranch({ root, sessionId: "parallel", branch });
	const ids = lines(result).map((line) => (line._piRemember as Record<string, unknown>).sourceEntryId);
	assert.deepEqual(ids, branch.map(({ id }) => id));
});

test("text, tool calls, roles, and policy limits are globally bounded", async () => {
	const huge = "€".repeat(10_000);
	const entry = assistant("b", "a", huge, {
		z: "last",
		password: "DO_NOT_SERIALIZE",
		a: huge,
		image: { data: "BASE64_IMAGE_SECRET", mimeType: "image/png" },
	});
	const message = entry.message as Record<string, unknown>;
	const originalContent = message.content as unknown[];
	message.content = [
		...originalContent,
		...Array.from({ length: 1_000 }, (_, index) => ({ type: "toolCall", id: `tool-${index}`, name: "bash", arguments: { value: huge } })),
	];
	const one = normalizeEntry(entry, { maxTextBytes: 256, maxToolArgumentBytes: 180 });
	const two = normalizeEntry(entry, { maxTextBytes: 256, maxToolArgumentBytes: 180 });
	assert.deepEqual(one, two);
	const serialized = JSON.stringify(one);
	assert.ok(Buffer.byteLength(serialized) < 20_000);
	assert.match(serialized, /truncated/);
	assert.match(serialized, /omittedToolCalls/);
	assert.doesNotMatch(serialized, /DO_NOT_SERIALIZE|BASE64_IMAGE_SECRET/);
	assert.match(serialized, /sha256/);

	const sameIdAfterTextCap = structuredClone(entry);
	const sameIdMessage = sameIdAfterTextCap.message as Record<string, unknown>;
	const sameIdContent = sameIdMessage.content as Array<Record<string, unknown>>;
	(sameIdContent[0] as Record<string, unknown>).text = `${"x".repeat(256)}different omitted suffix`;
	const cappedOne = normalizeEntry(assistant("same", "a", `${"x".repeat(256)}first omitted suffix`), { maxTextBytes: 128 });
	const cappedTwo = normalizeEntry(assistant("same", "a", `${"x".repeat(256)}different omitted suffix`), { maxTextBytes: 128 });
	assert.equal(cappedOne?._piRemember.sourceFingerprint, cappedTwo?._piRemember.sourceFingerprint);
	assert.equal(cappedOne?._piRemember.normalizedFingerprint, cappedTwo?._piRemember.normalizedFingerprint);

	const changedOnlyAfterCap = structuredClone(entry);
	const changedContent = (changedOnlyAfterCap.message as Record<string, unknown>).content as Array<Record<string, unknown>>;
	changedContent[originalContent.length + 100].id = "different-omitted-id";
	changedContent[originalContent.length + 100].arguments = { different: "omitted" };
	const dedupeRoot = temp();
	const first = await projectBranch({ root: dedupeRoot, sessionId: "bounded-source", branch: [user("a", null), entry] });
	const second = await projectBranch({ root: dedupeRoot, sessionId: "bounded-fork", branch: [user("a", null), changedOnlyAfterCap] });
	assert.equal(first.appendedRecords, 2);
	assert.equal(second.appendedRecords, 0, "changes outside the emitted semantic cap do not create a new ownership identity");

	const role = normalizeEntry({ type: "message", id: "role", parentId: null, message: { role: "x".repeat(10_000) } });
	assert.ok(Buffer.byteLength(JSON.stringify(role)) < 1_000);
	const root = temp();
	assert.equal((await projectBranch({ root, sessionId: "infinite", branch: [], maxTextBytes: Infinity })).reason, "invalid-policy");
	assert.equal((await projectBranch({ root, sessionId: "huge", branch: [], maxToolArgumentBytes: 1_000_000 })).reason, "invalid-policy");
});

test("independently authored Pi v3 JSONL fixture preserves Remember's physical-line contract", async () => {
	const fixture = fileURLToPath(new URL("../fixtures/pi-sessions/minimal-v3.jsonl", import.meta.url));
	const entries = readFileSync(fixture, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as PiBranchEntry);
	assert.equal(entries.shift()?.type, "session");
	const result = await projectBranch({ root: temp(), sessionId: "fixture-v3", branch: entries });
	const projected = lines(result);
	assert.equal(projected.length, 3);
	assert.deepEqual(projected.map(({ type }) => type), ["user", "assistant", "progress"]);
	const serialized = readFileSync(result.projectionPath!, "utf8");
	assert.doesNotMatch(serialized, /fixture-secret-must-not-appear|private source output must not appear|authorization|src\/index\.ts/);
	assert.equal(serialized.trimEnd().split("\n").length, result.state!.epochs[0].recordSourceIds.length);
});

test("tool argument keys are bounded, private, and locale-independent", () => {
	const secretKey = `password-${"K".repeat(20_000)}`;
	const record = normalizeEntry(
		assistant("b", "a", "ok", { [secretKey]: "value", path: "token=VALUE_THAT_MUST_NOT_APPEAR" }),
		{ maxToolArgumentBytes: 128 },
	);
	const serialized = JSON.stringify(record);
	assert.ok(Buffer.byteLength(serialized) < 1_500);
	assert.doesNotMatch(serialized, /password-|KKKK|VALUE_THAT_MUST_NOT_APPEAR|token=|\"path\"/);

	const first = normalizeEntry(assistant("same", "a", "ok", { "ä": 1, Z: 2, "Ω": 3, a: 4 }));
	const second = normalizeEntry(assistant("same", "a", "ok", { a: 4, "Ω": 3, Z: 2, "ä": 1 }));
	assert.deepEqual(first, second, "code-unit ordering is independent of insertion order and host locale");
});

test("Remember custom messages are omitted and tool results never leak raw output", async () => {
	const root = temp();
	const branch: PiBranchEntry[] = [
		user("a", null),
		{ type: "message", id: "b", parentId: "a", message: { role: "custom", customType: "pi-remember-context", content: "memory feedback" } },
		toolResult("c", "b", "RAW_TOOL_SECRET"),
		{ type: "custom_message", id: "d", parentId: "c", customType: "remember", content: "handoff feedback" },
	];
	const result = await projectBranch({ root, sessionId: "omit", branch });
	assert.equal(result.state?.epochs[0].lineage.length, 4);
	assert.equal(result.appendedRecords, 2);
	const serialized = readFileSync(result.projectionPath!, "utf8");
	assert.doesNotMatch(serialized, /memory feedback|handoff feedback|RAW_TOOL_SECRET/);
	assert.match(serialized, /pi-tool-result/);
});

test("corrupt registry is archived and recovered without rewriting a durable projection", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "corrupt", branch: straight });
	const durable = readFileSync(first.projectionPath!);
	writeFileSync(first.registryPath!, "{broken", { mode: 0o600 });
	const recovered = await projectBranch({ root, sessionId: "corrupt", branch: straight });
	assert.equal(recovered.disposition, "recovered");
	assert.equal(recovered.reason, "registry-corrupt");
	assert.equal(recovered.epochCreated, false);
	assert.deepEqual(readFileSync(first.projectionPath!), durable);
	assert.ok(readdirSync(dirname(first.registryPath!)).some((name) => name.includes(".corrupt.")));
});

test("missing or inconsistent projection starts a new epoch without overwriting referenced history", async () => {
	const root = temp();
	const missingFirst = await projectBranch({ root, sessionId: "missing", branch: straight });
	unlinkSync(missingFirst.projectionPath!);
	const missing = await projectBranch({ root, sessionId: "missing", branch: straight });
	assert.equal(missing.reason, "missing-projection");
	assert.equal(missing.epochCreated, true);
	assert.equal(missing.state?.currentEpoch, 2);

	const inconsistentFirst = await projectBranch({ root, sessionId: "inconsistent", branch: straight });
	const original = readFileSync(inconsistentFirst.projectionPath!);
	writeFileSync(inconsistentFirst.projectionPath!, `${original.toString("utf8")}{bad}\n`);
	const inconsistent = await projectBranch({ root, sessionId: "inconsistent", branch: straight });
	assert.equal(inconsistent.reason, "inconsistent-projection");
	assert.equal(inconsistent.epochCreated, true);
	assert.notEqual(inconsistent.projectionPath, inconsistentFirst.projectionPath);
	assert.match(readFileSync(inconsistentFirst.projectionPath!, "utf8"), /\{bad\}/);
});

test("simulated interruption after projection fsync recovers by adopting source IDs without duplicate lines", async () => {
	const emptyRoot = temp();
	await assert.rejects(
		projectBranch({
			root: emptyRoot,
			sessionId: "empty-crash",
			branch: [],
			onProjectionSynced: () => { throw new Error("empty crash"); },
		}),
		/empty crash/,
	);
	const emptyRecovered = await projectBranch({ root: emptyRoot, sessionId: "empty-crash", branch: [] });
	assert.equal(emptyRecovered.disposition, "recovered");
	assert.equal(lines(emptyRecovered).length, 0);

	const root = temp();
	await assert.rejects(
		projectBranch({
			root,
			sessionId: "crash",
			branch: straight,
			onProjectionSynced: () => { throw new Error("simulated crash"); },
		}),
		/simulated crash/,
	);
	const recovered = await projectBranch({ root, sessionId: "crash", branch: straight });
	assert.equal(recovered.disposition, "recovered");
	assert.equal(recovered.reason, "orphan-projection");
	assert.equal(recovered.epochCreated, false);
	assert.equal(lines(recovered).length, 2);

	const extended = [...straight, user("c", "b")];
	await assert.rejects(
		projectBranch({
			root,
			sessionId: "crash",
			branch: extended,
			onProjectionSynced: () => { throw new Error("second crash"); },
		}),
	);
	const replay = await projectBranch({ root, sessionId: "crash", branch: extended });
	assert.equal(replay.disposition, "recovered");
	assert.equal(lines(replay).length, 3);
	assert.deepEqual(lines(replay).map((line) => (line._piRemember as Record<string, unknown>).sourceEntryId), ["a", "b", "c"]);
});

test("existing projection permissions are restored on append and hard-linked files are refused", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "modes", branch: straight });
	chmodSync(first.projectionPath!, 0o644);
	const appended = await projectBranch({ root, sessionId: "modes", branch: [...straight, user("c", "b")] });
	assert.equal(appended.disposition, "appended");
	assert.equal(mode(appended.projectionPath!), 0o600);

	const hardRoot = temp();
	const hardFirst = await projectBranch({ root: hardRoot, sessionId: "hardlink", branch: straight });
	const alias = join(hardRoot, "outside-alias.jsonl");
	linkSync(hardFirst.projectionPath!, alias);
	const refused = await projectBranch({ root: hardRoot, sessionId: "hardlink", branch: [...straight, user("c", "b")] });
	assert.equal(refused.reason, "inconsistent-projection");
	assert.equal(refused.epochCreated, true);
	assert.equal(readFileSync(alias, "utf8"), readFileSync(hardFirst.projectionPath!, "utf8"));
});

test("exact repeat repairs exposed projection, registry, and ownership modes", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "repeat-modes", branch: straight });
	const ownership = join(dirname(first.registryPath!), "ownership.json");
	chmodSync(first.projectionPath!, 0o644);
	chmodSync(first.registryPath!, 0o644);
	chmodSync(ownership, 0o644);
	const repeated = await projectBranch({ root, sessionId: "repeat-modes", branch: straight });
	assert.equal(repeated.disposition, "unchanged");
	assert.equal(mode(first.projectionPath!), 0o600);
	assert.equal(mode(first.registryPath!), 0o600);
	assert.equal(mode(ownership), 0o600);
});

test("same-length valid projection mutation starts a new epoch", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "same-length", branch: straight });
	const original = readFileSync(first.projectionPath!, "utf8");
	const mutated = original.replace("working", "changed");
	assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
	writeFileSync(first.projectionPath!, mutated);
	const result = await projectBranch({ root, sessionId: "same-length", branch: straight });
	assert.equal(result.reason, "inconsistent-projection");
	assert.equal(result.epochCreated, true);
	assert.notEqual(result.projectionPath, first.projectionPath);
});

test("serialization limits form part of immutable epoch policy", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "policy", branch: straight, maxTextBytes: 128 });
	const changed = await projectBranch({ root, sessionId: "policy", branch: straight, maxTextBytes: 256 });
	assert.equal(changed.reason, "normalizer-change");
	assert.equal(changed.epochCreated, true);
	assert.notEqual(first.state!.epochs[0].policyId, changed.state!.epochs[1].policyId);
	assert.equal(changed.state!.epochs[1].maxTextBytes, 256);
});

test("invalid lineage, relative roots, and symlink path escapes fail closed", async () => {
	const root = temp();
	const invalid = await projectBranch({ root, sessionId: "bad", branch: [user("a", null), user("b", "wrong")] });
	assert.equal(invalid.reason, "invalid-branch");
	assert.equal((await projectBranch({ root: "relative", sessionId: "bad", branch: [] })).reason, "unsafe-root");

	const outside = temp();
	const linkedRoot = join(root, "linked-root");
	symlinkSync(outside, linkedRoot);
	assert.equal((await projectBranch({ root: linkedRoot, sessionId: "bad", branch: straight })).reason, "unsafe-root");

	const safe = join(root, "safe");
	mkdirSync(safe, { mode: 0o700 });
	mkdirSync(join(safe, "transcripts"), { mode: 0o700 });
	const key = await projectBranch({ root: safe, sessionId: "seed", branch: [] });
	assert.equal(key.ok, true);
	// A generated subtree changed into a symlink is refused rather than followed.
	const secondRoot = join(root, "second-safe");
	mkdirSync(secondRoot, { mode: 0o700 });
	symlinkSync(outside, join(secondRoot, "registry"));
	assert.equal((await projectBranch({ root: secondRoot, sessionId: "bad", branch: straight })).reason, "unsafe-root");
});

test("two concurrent projector calls serialize and produce one durable copy", async () => {
	const root = temp();
	const branch = [...straight, user("c", "b")];
	const [one, two] = await Promise.all([
		projectBranch({ root, sessionId: "concurrent", branch }),
		projectBranch({ root, sessionId: "concurrent", branch }),
	]);
	assert.equal(one.ok, true);
	assert.equal(two.ok, true);
	const latest = await projectBranch({ root, sessionId: "concurrent", branch });
	assert.equal(latest.disposition, "unchanged");
	assert.equal(lines(latest).length, 3);
	assert.equal(new Set(lines(latest).map((line) => (line._piRemember as Record<string, unknown>).sourceEntryId)).size, 3);
});

test("distinct projector processes serialize through the filesystem lock", async () => {
	const root = temp();
	const branchPath = join(temp(), "branch.json");
	writeFileSync(branchPath, JSON.stringify([...straight, user("c", "b")]));
	const [one, two] = await Promise.all([
		runWorker(root, "multiprocess", branchPath),
		runWorker(root, "multiprocess", branchPath),
	]);
	assert.equal(one.ok, true);
	assert.equal(two.ok, true);
	const latest = await projectBranch({ root, sessionId: "multiprocess", branch: [...straight, user("c", "b")] });
	assert.equal(latest.disposition, "unchanged");
	assert.equal(lines(latest).length, 3);
});

test("SIGKILL leaving an unterminated append recovers the valid durable prefix", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "torn-process", branch: straight });
	const before = readFileSync(first.projectionPath!);
	const script = `const fs=require('fs');const fd=fs.openSync(process.argv[1],fs.constants.O_WRONLY|fs.constants.O_APPEND);fs.writeSync(fd,Buffer.from('{\"partial\":'));process.kill(process.pid,'SIGKILL')`;
	const child = spawn(process.execPath, ["-e", script, first.projectionPath!], { stdio: "ignore" });
	const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, exitedSignal) => resolve(exitedSignal)));
	assert.equal(signal, "SIGKILL");
	assert.ok(readFileSync(first.projectionPath!).length > before.length);
	const recovered = await projectBranch({ root, sessionId: "torn-process", branch: straight });
	assert.equal(recovered.disposition, "recovered");
	assert.deepEqual(readFileSync(first.projectionPath!), before);
});

test("stale adapter claims are reclaimed without replacing live claim paths", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "lock", branch: straight });
	const lockDirectory = join(root, "locks");
	const lockBase = join(lockDirectory, "projection-global.lock");
	for (const [index, nonce] of ["a".repeat(32), "b".repeat(32)].entries()) {
		writeFileSync(`${lockBase}.claim.${nonce}`, `${JSON.stringify({ pid: process.pid, start: "not-this-process-lifetime", nonce, ticket: index + 1 })}\n`, { mode: 0o600 });
	}
	// An interrupted unpublished temp file is never treated as a live final claim.
	writeFileSync(join(lockDirectory, ".projection-global.lock.claim.partial.publishing"), "{", { mode: 0o600 });
	const branch = [...straight, user("c", "b")];
	const [one, two] = await Promise.all([
		projectBranch({ root, sessionId: "lock", branch }),
		projectBranch({ root, sessionId: "lock", branch }),
	]);
	assert.equal(one.ok, true);
	assert.equal(two.ok, true);
	const result = await projectBranch({ root, sessionId: "lock", branch });
	assert.equal(result.disposition, "unchanged");
	assert.equal(lines(result).length, 3);
	assert.equal(readdirSync(lockDirectory).some((name) => name.includes(".claim.a") || name.includes(".claim.b")), false);
	assert.equal(lstatSync(first.projectionPath!).isFile(), true);
});

test("unsafe live lock claims fail closed and remain intact", async () => {
	const root = temp();
	await projectBranch({ root, sessionId: "seed-lock-root", branch: [] });
	const nonce = "c".repeat(32);
	const claim = join(root, "locks", `projection-global.lock.claim.${nonce}`);
	writeFileSync(claim, `${JSON.stringify({ pid: process.pid, nonce, ticket: 1 })}\n`, { mode: 0o600 });
	const alias = join(root, "unsafe-live-claim-alias");
	linkSync(claim, alias);
	const result = await projectBranch({ root, sessionId: "blocked-by-unsafe-lock", branch: straight, lockTimeoutMs: 50 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "lock-timeout");
	assert.equal(lstatSync(claim).nlink, 2, "unsafe active claim was not unlinked as stale");
});

test("lock timeout policy is bounded and release failures surface", async () => {
	const root = temp();
	for (const lockTimeoutMs of [NaN, Infinity, -1, 0, 1.5, 60_001]) {
		const result = await projectBranch({ root, sessionId: `timeout-${lockTimeoutMs}`, branch: [], lockTimeoutMs });
		assert.equal(result.reason, "invalid-policy");
	}

	const releaseRoot = temp();
	const lockDirectory = join(releaseRoot, "locks");
	try {
		await assert.rejects(projectBranch({
			root: releaseRoot,
			sessionId: "release-failure",
			branch: straight,
			onProjectionSynced: () => chmodSync(lockDirectory, 0o500),
		}));
	} finally {
		chmodSync(lockDirectory, 0o700);
	}
});

test("malformed ownership claims are rebuilt and cannot suppress history", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "malformed-owner-source", branch: straight });
	const ownership = join(root, "registry", "ownership.json");
	const fingerprint = first.state!.epochs[0].recordFingerprints[0];
	writeFileSync(ownership, `${JSON.stringify({ schemaVersion: 1, claims: { [fingerprint]: null } })}\n`, { mode: 0o600 });
	const fork = await projectBranch({ root, sessionId: "malformed-owner-fork", branch: straight });
	assert.equal(fork.ok, true);
	assert.equal(fork.appendedRecords, 0, "validated reconstruction retained every durable ownership claim");
	const rebuilt = JSON.parse(readFileSync(ownership, "utf8")) as { claims: Record<string, unknown> };
	assert.equal(typeof rebuilt.claims[fingerprint], "object");
});

test("tampered transcript ownership metadata fails reconstruction atomically", async () => {
	for (const tamper of [
		(meta: Record<string, unknown>) => { meta.sourceEntryId = "x".repeat(2_000); },
		(meta: Record<string, unknown>) => { meta.sourceFingerprint = "f".repeat(64); },
		(meta: Record<string, unknown>) => { meta.parentId = { forged: true }; },
	]) {
		const root = temp();
		const first = await projectBranch({ root, sessionId: "metadata-source", branch: straight });
		const records = readFileSync(first.projectionPath!, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		tamper(records[0]._piRemember as Record<string, unknown>);
		writeFileSync(first.projectionPath!, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
		unlinkSync(join(root, "registry", "ownership.json"));
		const beforeFiles = readdirSync(join(root, "transcripts"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl")).length;
		const result = await projectBranch({ root, sessionId: "metadata-target", branch: straight });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "io-error");
		const afterFiles = readdirSync(join(root, "transcripts"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl")).length;
		assert.equal(afterFiles, beforeFiles);
	}
});

test("ownership reconstruction fails closed on unsafe transcript state", async () => {
	const root = temp();
	const first = await projectBranch({ root, sessionId: "ownership-source", branch: straight });
	const ownership = join(root, "registry", "ownership.json");
	unlinkSync(ownership);
	const alias = join(root, "transcript-hardlink-alias.jsonl");
	linkSync(first.projectionPath!, alias);
	const beforeFiles = readdirSync(join(root, "transcripts"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl")).length;
	const result = await projectBranch({ root, sessionId: "ownership-target", branch: straight });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "io-error");
	const afterFiles = readdirSync(join(root, "transcripts"), { recursive: true }).filter((name) => String(name).endsWith(".jsonl")).length;
	assert.equal(afterFiles, beforeFiles, "no duplicate projection file was created");
});
