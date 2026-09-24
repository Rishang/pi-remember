import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { parseHookOutput, runBounded } from "../../src/runner.ts";

const temporary: string[] = [];
afterEach(() => {
	delete process.env.PI_REMEMBER_TEST_SECRET;
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-remember-runner-"));
	temporary.push(path);
	return path;
}

function helper(root: string, body: string): string {
	const path = join(root, `helper-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(path, body);
	return path;
}

function nodeRun(root: string, file: string, options: Parameters<typeof runBounded>[0] = { command: "", cwd: "" }) {
	const { args = [], ...rest } = options;
	return runBounded({ ...rest, cwd: rest.cwd || root, command: process.execPath, args: [file, ...args] });
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitGone(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (!alive(pid)) return true;
		await delay(25);
	}
	return !alive(pid);
}

test("parses plain, JSON, empty, and malformed hook output into separate channels", () => {
	assert.deepEqual(parseHookOutput("memory context\n", "notice\n"), {
		additionalContext: "memory context",
		systemMessage: "",
		diagnostics: "notice",
		format: "plain",
	});
	assert.deepEqual(parseHookOutput(JSON.stringify({
		hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "memory" },
		systemMessage: "human notice",
	}), "diag"), {
		additionalContext: "memory",
		systemMessage: "human notice",
		diagnostics: "diag",
		format: "json",
	});
	assert.equal(parseHookOutput("").format, "empty");
	const malformed = parseHookOutput("{bad", "diagnostic");
	assert.equal(malformed.additionalContext, "");
	assert.equal(malformed.format, "json");
	assert.match(malformed.diagnostics, /malformed hook JSON/);
});

test("runs argv directly with explicit cwd, stdin, and environment", async () => {
	const root = temp();
	const command = helper(root, `
		let input = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", chunk => input += chunk);
		process.stdin.on("end", () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env.ALLOWED, arg: process.argv[2], input })));
	`);
	const result = await nodeRun(root, command, {
		command: "",
		args: ["literal;not-shell"],
		cwd: root,
		env: { ALLOWED: "yes" },
		stdin: "hello",
	});
	assert.equal(result.ok, true);
	assert.deepEqual(JSON.parse(result.stdout), { cwd: root, env: "yes", arg: "literal;not-shell", input: "hello" });
});

test("does not inherit ambient secrets and redacts named, argv, and stdin secrets", async () => {
	const root = temp();
	process.env.PI_REMEMBER_TEST_SECRET = "do-not-inherit";
	const command = helper(root, `
		let input = "";
		process.stdin.on("data", chunk => input += chunk);
		process.stdin.on("end", () => {
			process.stdout.write([process.env.PI_REMEMBER_TEST_SECRET ?? "unset", process.env.COOKIE, process.argv[2], input].join("|"));
			process.stderr.write(process.env.NEUTRAL_NAME ?? "");
		});
	`);
	const result = await nodeRun(root, command, {
		command: "",
		args: ["yes"],
		cwd: root,
		env: { COOKIE: "cookie-sensitive", NEUTRAL_NAME: "123" },
		stdin: "stdin-sensitive",
		sensitiveValues: ["yes", "stdin-sensitive", "123"],
	});
	assert.equal(result.ok, true);
	assert.equal(result.stdout, "unset|[REDACTED]|[REDACTED]|[REDACTED]");
	assert.equal(result.stderr, "[REDACTED]");
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sensitive|do-not-inherit|123|yes/);
});

test("distinguishes nonzero and spawn failures without leaking command details", async () => {
	const root = temp();
	const command = helper(root, `process.stderr.write("public-error"); process.exit(7);`);
	const nonzero = await nodeRun(root, command);
	assert.equal(nonzero.failure, "nonzero");
	assert.equal(nonzero.code, 7);
	assert.equal(nonzero.stderr, "public-error");

	const spawn = await runBounded({ command: join(root, "does-not-exist-secret-name"), cwd: root });
	assert.equal(spawn.failure, "spawn");
	assert.match(spawn.stderr, /process spawn failed/);
	assert.doesNotMatch(spawn.stderr, /secret-name/);

	const invalidCwd = await nodeRun(root, command, { command: "", cwd: join(root, "missing-cwd") });
	assert.equal(invalidCwd.failure, "spawn");
});

test("timeout terminates the complete POSIX descendant process group", { skip: process.platform === "win32" }, async () => {
	const root = temp();
	const pidFile = join(root, "descendant.pid");
	const command = helper(root, `
		import { spawn } from "node:child_process";
		import { writeFileSync } from "node:fs";
		const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
		writeFileSync(process.argv[2], String(descendant.pid));
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 1000);
	`);
	const result = await nodeRun(root, command, {
		command: "",
		args: [pidFile],
		cwd: root,
		timeoutMs: 100,
		killGraceMs: 75,
	});
	const pid = Number(readFileSync(pidFile, "utf8"));
	try {
		assert.equal(result.failure, "timeout");
		assert.equal(result.failure, "timeout");
		assert.equal(await waitGone(pid), true, `descendant ${pid} survived timeout`);
	} finally {
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
});

test("AbortSignal cancellation is distinct and preserves the first termination cause", async () => {
	const root = temp();
	const command = helper(root, `process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("x"), 5);`);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);
	const result = await nodeRun(root, command, {
		command: "",
		cwd: root,
		signal: controller.signal,
		timeoutMs: 500,
		killGraceMs: 30,
		maxStdoutBytes: 1_000,
	});
	assert.equal(result.failure, "cancelled");

	const already = new AbortController();
	already.abort();
	assert.equal((await nodeRun(root, command, { command: "", cwd: root, signal: already.signal })).failure, "cancelled");
});

test("the first termination cause wins timeout/output races", async () => {
	const root = temp();
	const command = helper(root, `
		process.on("SIGTERM", () => {
			for (let i = 0; i < 100; i++) process.stdout.write("overflow");
		});
		setInterval(() => {}, 1000);
	`);
	const result = await nodeRun(root, command, {
		command: "",
		cwd: root,
		timeoutMs: 40,
		killGraceMs: 30,
		maxStdoutBytes: 8,
	});
	assert.equal(result.failure, "timeout");
});

test("output cap retains the exact valid UTF-8 prefix and input is bounded", async () => {
	const root = temp();
	const command = helper(root, `
		process.on("SIGTERM", () => {});
		process.stdout.write(Buffer.from("€abcdef", "utf8"));
		setInterval(() => {}, 1000);
	`);
	const output = await nodeRun(root, command, {
		command: "",
		cwd: root,
		maxStdoutBytes: 5,
		timeoutMs: 2_000,
		killGraceMs: 20,
	});
	assert.equal(output.failure, "output-limit");
	assert.equal(output.failure, "output-limit");
	assert.equal(output.stdout, "€ab");
	assert.equal(Buffer.byteLength(output.stdout), 5);

	const input = await nodeRun(root, command, { command: "", cwd: root, stdin: "too large", maxStdinBytes: 2 });
	assert.equal(input.failure, "input-limit");
});
