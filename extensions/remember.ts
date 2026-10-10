import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeRememberRuntime } from "../src/plugin.ts";
import { describeSave, discoverSkillPaths, formatStatus, runDoctor, runtimeEnvironment } from "../src/commands.ts";
import { parseHookOutput, runBounded } from "../src/runner.ts";
import { SessionCoordinator, type CoordinatorOptions, type HookInput, type HostSnapshot, type RememberRuntime } from "../src/runtime.ts";
import type { CapabilityReport, HookOutput } from "../src/types.ts";

const EMPTY: HookOutput = { additionalContext: "", systemMessage: "", diagnostics: "", format: "empty" };

type PiSurface = Pick<ExtensionAPI, "on" | "registerCommand">;
type ContextLike = Pick<ExtensionContext, "cwd" | "sessionManager" | "hasUI" | "ui">;

export interface RegistrationDependencies {
	adapterRoot?: string;
	createCoordinator?: (options: CoordinatorOptions) => SessionCoordinator;
	createRuntime?: () => RememberRuntime;
	/** Static probe used for skill discovery and command reports. */
	probe?: () => CapabilityReport;
}

function show(ctx: Pick<ExtensionContext, "hasUI" | "ui">, text: string, level: "info" | "warning" = "info"): void {
	// Custom messages are sent to the model, so command output stays on the human channel.
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else process.stderr.write(`${text}\n`);
}

function snapshot(ctx: ContextLike): HostSnapshot {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		branch: ctx.sessionManager.getBranch() as unknown as HostSnapshot["branch"],
	};
}

const HOOKS: Record<HookInput["kind"], [script: string, event: string]> = {
	"session-start": ["session-start-hook.sh", "SessionStart"],
	compact: ["session-start-hook.sh", "SessionStart"],
	prompt: ["user-prompt-hook.sh", "UserPromptSubmit"],
	"post-tool": ["post-tool-hook.sh", "PostToolUse"],
	"session-end": ["session-end-hook.sh", "SessionEnd"],
};

/** Runs the installed Remember hook scripts the way Claude Code's hooks.json does. */
export class InstalledRememberRuntime implements RememberRuntime {
	#report?: CapabilityReport;

	probe(): CapabilityReport {
		return this.#report ??= probeRememberRuntime();
	}

	async invoke(input: HookInput): Promise<HookOutput> {
		const report = this.probe();
		if (report.disposition !== "ready" || !report.root || !report.tools.bash) return EMPTY;
		if (input.force && input.kind === "post-tool") {
			// save-session.sh prints pipeline logs, not hook JSON; never stage them as model context.
			const saved = await runBounded({
				command: report.tools.bash,
				args: [join(report.root, "scripts", "save-session.sh"), input.hostSessionId, "--force"],
				cwd: input.cwd,
				env: runtimeEnvironment(report.root, input.cwd, input.projectionPath),
				signal: input.signal,
				timeoutMs: 120_000,
			});
			if (!saved.ok) throw { failure: saved.failure };
			return EMPTY;
		}
		const [scriptName, event] = HOOKS[input.kind];
		const script = join(report.root, "scripts", scriptName);
		const payload = JSON.stringify({
			hook_event_name: event,
			session_id: input.hostSessionId,
			transcript_path: input.projectionPath,
			cwd: input.cwd,
			source: input.kind === "compact" ? "compact" : input.source,
			reason: input.reason,
		});
		const result = await runBounded({
			command: report.tools.bash,
			args: [script],
			cwd: input.cwd,
			env: runtimeEnvironment(report.root, input.cwd, input.projectionPath),
			stdin: payload,
			signal: input.signal,
			// Claude Code's budgets: 10s for SessionEnd (hooks.json), its 60s default for the rest.
			timeoutMs: input.kind === "session-end" ? 10_000 : 60_000,
			sensitiveValues: [payload],
		});
		if (!result.ok) throw { failure: result.failure };
		return parseHookOutput(result.stdout, result.stderr);
	}
}

/** Exact Pi 0.85.1 lifecycle registration. No probing, IO, timers, or coordinator construction occurs here. */
export function registerRememberExtension(pi: PiSurface, dependencies: RegistrationDependencies = {}): void {
	let coordinator: SessionCoordinator | undefined;
	let latestContext: ContextLike | undefined;
	let replacementReady: Promise<void> = Promise.resolve();
	const create = dependencies.createCoordinator ?? ((options) => new SessionCoordinator(options));
	const runtime = dependencies.createRuntime ?? (() => new InstalledRememberRuntime());
	const root = dependencies.adapterRoot ?? join(homedir(), ".pi", "agent", "remember");
	const probe = dependencies.probe ?? (() => probeRememberRuntime());
	let activeRuntime: RememberRuntime | undefined;

	const bind = (ctx: ContextLike) => { latestContext = ctx; };
	const currentSnapshot = () => {
		if (!latestContext) throw new Error("session context unavailable");
		return snapshot(latestContext);
	};

	pi.on("session_start", async (event, ctx) => {
		bind(ctx);
		// Pi may deliver the replacement start before the outgoing shutdown handler settles.
		// Never route that start to a coordinator that has already stopped accepting work.
		await replacementReady;
		if (!coordinator) {
			activeRuntime = runtime();
			coordinator = create({
				adapterRoot: root,
				runtime: activeRuntime,
				snapshot: currentSnapshot,
				// Like Claude Code: a hook's systemMessage reaches the user; stderr from a successful hook does not.
				notice: ({ systemMessage }) => {
					if (systemMessage && latestContext?.hasUI) latestContext.ui.notify(systemMessage, "info");
				},
			});
		}
		await coordinator.start(event.reason, ctx.sessionManager.getBranch() as unknown as Record<string, unknown>[]);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		bind(ctx);
		const message = await coordinator?.prompt();
		return message ? { message } : undefined;
	});

	pi.on("tool_result", (_event, ctx) => {
		bind(ctx);
		coordinator?.markDirty();
	});

	// tool_result is not yet durably represented. turn_end is the first selected durable tool boundary.
	pi.on("turn_end", (_event, ctx) => {
		bind(ctx);
		void coordinator?.checkpoint(false, "turn-end");
	});
	pi.on("agent_end", (_event, ctx) => {
		bind(ctx);
		coordinator?.markDirty();
		void coordinator?.checkpoint(false, "agent-end");
	});
	pi.on("agent_settled", (_event, ctx) => {
		bind(ctx);
		void coordinator?.checkpoint(false, "agent-settled");
	});
	pi.on("session_tree", (_event, ctx) => {
		bind(ctx);
		coordinator?.markDirty();
		void coordinator?.checkpoint(false, "session-tree");
	});
	pi.on("session_compact", (_event, ctx) => {
		bind(ctx);
		coordinator?.markDirty();
		return coordinator?.compact("compact");
	});
	pi.on("session_shutdown", async (event, ctx) => {
		bind(ctx);
		const outgoing = coordinator;
		const shutdown = outgoing?.shutdown(event.reason) ?? Promise.resolve();
		// Publish the barrier before awaiting so an overlapping replacement start waits for
		// cleanup and constructs a fresh session-scoped coordinator.
		replacementReady = shutdown.then(
			() => { if (coordinator === outgoing) coordinator = undefined; },
			() => { if (coordinator === outgoing) coordinator = undefined; },
		);
		await shutdown;
	});

	// Pi invokes skills as /skill:remember, so the installed upstream skill never competes with a command.
	pi.on("resources_discover", () => {
		const skillPaths = discoverSkillPaths(probe());
		return skillPaths.length ? { skillPaths } : undefined;
	});

	pi.registerCommand("remember:doctor", {
		description: "Run the installed Remember doctor and show its report verbatim",
		handler: async (_args, ctx) => {
			show(ctx, await runDoctor(probe(), ctx.cwd));
		},
	});

	pi.registerCommand("remember-status", {
		description: "Show pi-remember adapter status",
		handler: async (_args, ctx) => {
			const report = await (activeRuntime ?? runtime()).probe();
			show(ctx, formatStatus(report, coordinator?.status, root));
		},
	});

	pi.registerCommand("remember-save", {
		description: "Wait for idle, then force a Remember save of this session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const current = coordinator;
			if (!current) {
				show(ctx, "Remember save skipped: no active session.", "warning");
				return;
			}
			await current.checkpoint(true, "manual-save");
			const { text, level } = describeSave(current.status);
			show(ctx, text, level);
		},
	});
}

export default function rememberExtension(pi: ExtensionAPI): void {
	registerRememberExtension(pi);
}
