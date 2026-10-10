import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerRememberExtension } from "../../extensions/remember.ts";
import { probeRememberRuntime } from "../../src/plugin.ts";

// Drives a Pi session through the installed Remember hooks, end to end. Only the
// summarizer is faked: a `claude` on PATH that returns one memory entry.
const installed = probeRememberRuntime();
const MARKER = "pi-remember round-trip marker";

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "pi-remember-installed-"));
	const paths = { root, home: join(root, "home"), bin: join(root, "bin"), project: join(root, "project"), adapter: join(root, "adapter") };
	for (const path of [paths.home, paths.bin, paths.project]) mkdirSync(path);
	const claude = join(paths.bin, "claude");
	writeFileSync(claude, `#!/bin/bash\ncat >/dev/null\nprintf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"## 00:00 | main\\n${MARKER}","usage":{"input_tokens":1,"output_tokens":1}}'\n`);
	chmodSync(claude, 0o755);
	return paths;
}

function piSession(project: string, adapterRoot: string, sessionId: string) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	registerRememberExtension({ on: (event: string, handler: never) => handlers.set(event, handler), registerCommand: () => {} } as never, { adapterRoot });
	const branch: Record<string, unknown>[] = [];
	const ctx = {
		cwd: project, hasUI: false, ui: { notify: () => {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
	};
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)!(payload, ctx);
	return {
		start: () => emit("session_start", { reason: "startup" }),
		async turn(text: string): Promise<string> {
			branch.push({ type: "message", id: `u${branch.length}`, parentId: branch.at(-1)?.id ?? null, message: { role: "user", content: [{ type: "text", text }] } });
			const result = await emit("before_agent_start") as { message?: { content: string } } | undefined;
			branch.push({ type: "message", id: `a${branch.length}`, parentId: branch.at(-1)!.id, message: { role: "assistant", content: [{ type: "text", text: `Done: ${text}` }] } });
			emit("tool_result");
			await emit("turn_end");
			await emit("agent_end");
			return result?.message?.content ?? "";
		},
		stop: () => emit("session_shutdown", { reason: "quit" }),
	};
}

function savedMemory(project: string): string {
	const store = join(project, ".remember");
	if (!existsSync(store)) return "";
	return readdirSync(store).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(store, name), "utf8")).join("\n");
}

test("a Pi session saves to and recalls from the installed Remember store", {
	skip: installed.disposition !== "ready" && "no usable Remember install",
	timeout: 90_000,
}, async () => {
	const paths = sandbox();
	const saved = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("REMEMBER_")) delete process.env[key];
	Object.assign(process.env, { HOME: paths.home, PATH: `${paths.bin}:${saved.PATH}`, PI_REMEMBER_PLUGIN_ROOT: installed.root });
	try {
		const first = piSession(paths.project, paths.adapter, "first");
		await first.start();
		assert.ok(existsSync(join(paths.project, ".remember")), "session start creates the project store");
		for (const text of ["fix the parser", "add tests", "split the lexer", "update the README"]) await first.turn(text);
		await first.stop();

		// session-end hands the forced save to a background process, as it does in Claude Code.
		const deadline = Date.now() + 60_000;
		while (!savedMemory(paths.project).includes(MARKER) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
		assert.match(savedMemory(paths.project), new RegExp(MARKER));

		const second = piSession(paths.project, paths.adapter, "second");
		await second.start();
		assert.match(await second.turn("what did we do?"), new RegExp(MARKER));
		await second.stop();
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(paths.root, { recursive: true, force: true, maxRetries: 5 });
	}
});
