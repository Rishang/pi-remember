# Pi Remember Architecture Plan

Status: proposed architecture  
Compatibility baseline: Claude Remember `0.30.0`, commit `54f4da9f10a90b77fb57318192bd5a936a6d4a01`  
Pi baseline: `@earendil-works/pi-coding-agent` `0.85.1`

## Executive decision

Build a **hybrid adapter**:

- Native TypeScript owns Pi lifecycle mapping, active-branch projection, context delivery, commands, and an in-process serialized queue.
- The locally installed, version-pinned Claude Remember pipeline remains the **only writer** of the shared `.remember` store.
- Pi publishes a stable, append-only, Claude-shaped projection of each active Pi branch and supplies its exact path through `REMEMBER_TRANSCRIPT_PATH`.
- The adapter invokes the installed Remember hooks/scripts through a narrow, versioned compatibility runner; it does not copy or redistribute upstream source.

This is the shortest safe route to real compatibility. A native rewrite would have to reproduce upstream locking, positions, recovery, rejection gates, NDC compression, consolidation, path normalization, backup behavior, and many race/security fixes. The current prototype is useful as a proof of invocation, but its full-branch rewrites, synchronous hot-path hooks, and mutable plugin discovery are not safe enough for production.

## 1. Compatibility definition and non-goals

“Fully compatible” means **bidirectional store and lifecycle interoperability** for the explicitly supported upstream version:

1. Claude Code + Remember and Pi + this adapter can alternate against the same project store without migration.
2. A logical session span is summarized at most once, except where upstream intentionally permits at-least-once duplication to avoid data loss.
3. Existing store files, config layers, locks, positions, handoffs, recovery, diagnostics, and optional backup hooks retain their upstream meaning.
4. Pi never advances a Remember cursor before the corresponding memory write lands.
5. Unknown files and config keys are preserved.
6. Generated prose may differ because model output is nondeterministic; file structure, retained facts, cursor movement, lifecycle decisions, and visible notices must remain equivalent.

Non-goals for the first release:

- Reimplementing Remember’s pipeline in TypeScript.
- Bundling or modifying upstream scripts, prompts, skills, or Python modules.
- Byte-identical summary prose or token usage.
- Supporting arbitrary upstream versions without a conformance run.
- Guaranteeing a final save after `SIGKILL`, power loss, or host process destruction.
- Claiming Windows compatibility before live Git Bash/Windows validation.
- Reproducing optional cross-plugin promotions in Pi.

Compatibility is version-qualified: release 1 targets installed Remember `0.30.0`. A later upstream version is unsupported until its capability and black-box suites pass.

## 2. Decision and rationale

### Chosen: hybrid adapter

Pi-native code handles host-specific concerns; upstream code handles memory-specific concerns.

| Concern | Owner |
|---|---|
| Pi tree/session interpretation | Pi adapter |
| Stable linear transcript projection | Pi adapter |
| Pi event ordering and queueing | Pi adapter |
| Model-context vs human-notice delivery | Pi adapter |
| Store path/config resolution | Installed Remember runtime |
| Extraction, thresholds, cooldowns | Installed Remember runtime |
| Summarization acceptance/rejection | Installed Remember runtime |
| `now.md`, position, NDC, consolidation writes | Installed Remember runtime |
| Cross-host locks and recovery | Installed Remember runtime |
| Store diagnostics | Installed Remember runtime |

### Rejected: native TypeScript rewrite

It would initially be smaller at runtime but much larger in correctness surface. Upstream has dedicated tests for lock takeover, cursor ordering, unread envelopes, NDC races, consolidation races, Windows paths, worktrees, malformed config, provider routing, backup divergence, and security boundaries. Rebuilding this is not the lazy solution; it is a second memory product.

### Rejected: current thin synchronous adapter

The prototype rewrites the whole active branch and synchronously runs shell hooks around hot events. That breaks physical-line cursors after tree navigation, risks concurrent temp-file collisions, blocks tool/prompt flow, skips reload flush/rebind semantics, and chooses mutable cache directories too loosely.

## 3. Module boundaries

Keep the package small. These are implementation modules, not public framework abstractions.

```text
extensions/remember.ts          Pi registration and event wiring only
src/runtime.ts                  Session-scoped coordinator and serialized queue
src/plugin.ts                   Installed-plugin resolver + capability probe
src/projection.ts               Pi tree -> append-only host transcript
src/runner.ts                   Bounded process invocation and hook output parsing
src/context.ts                  Startup/prompt context and notice delivery
src/types.ts                    Internal records shared by the modules above
skills/                         None copied; expose installed upstream skill path
commands/                       None copied; doctor is a native Pi command

tests/unit/                     Projection, resolver, parser, state tests
tests/integration/              Fake runtime and real installed-runtime tests
tests/parity/                   Oracle/candidate black-box scenarios
```

The deep external interface is the Pi extension itself. Internally, keep one important seam around the installed runtime:

```ts
interface RememberRuntime {
  probe(): Promise<CapabilityReport>;
  sessionStart(input: HostEvent): Promise<HookOutput>;
  userPrompt(input: HostEvent): Promise<HookOutput>;
  postTool(input: HostEvent): Promise<HookOutput>;
  sessionEnd(input: HostEvent): Promise<void>;
  doctor(cwd: string): Promise<string>;
}
```

There are two real adapters for this seam: the installed-runtime process adapter and a deterministic fake used by tests. Do not introduce `StoreWriter`, `Lock`, or `Summarizer` interfaces in release 1 because only upstream implements them.

## 4. Lifecycle and event mapping

| Remember lifecycle | Pi event | Adapter action |
|---|---|---|
| `SessionStart:startup` | `session_start:startup` | Resolve runtime, restore projection state, publish projection, call upstream start, stage context for first prompt. |
| `SessionStart:clear` | `session_start:new` | New epoch/session mapping, then normal start. |
| `SessionStart:resume` | `session_start:resume` | Reconstruct active branch and mapping; never assume the old in-memory cursor. |
| `SessionStart:fork` | `session_start:fork` | Create a distinct projection/session ID, retaining source-entry dedupe metadata. |
| Reload | `session_shutdown:reload` then `session_start:reload` | Flush/mark pending, dispose queue, re-resolve runtime, and inject only if revision not already delivered. |
| Tree change | `session_tree` | Compare entry-ID paths; start a new branch epoch if the path is not a strict extension. |
| Prompt submit | `before_agent_start` | Run upstream prompt hook, aggregate its context with pending startup memory, and return one hidden custom message. |
| Tool completion | `tool_result` | Mark dirty/counter only; do not inspect a not-yet-durable branch or spawn synchronously. |
| Durable tool/turn boundary | `tool_execution_end`, `turn_end`, or `agent_settled` | Serialize new projection records, then enqueue `PostToolUse`. |
| Compaction | `session_compact` | Publish projection metadata and call start hook with `source=compact`; inject identity-only result without duplicating history. |
| Final flush | `agent_settled` plus `session_shutdown` | Opportunistic ordinary save at settled; bounded forced shutdown hook and durable pending marker. |

Important ordering rules:

- `tool_result` may fire before Pi persists the result, especially with parallel tools. It only marks state.
- `agent_end` is not final; automatic retries, compaction, or queued messages may follow. Prefer `agent_settled`.
- Extension commands are resolved before Pi input/skill expansion.
- `/reload`, `/new`, `/resume`, and `/fork` replace the extension runtime. Never retain a `ctx`, model, session manager, or abort signal across shutdown.
- Ordinary lifecycle failures fail open for coding activity, but unsafe path/runtime states enter visible read-only mode.

## 5. Canonical storage state machine and ownership

The adapter does not directly mutate these files. It calls upstream, which remains authoritative.

| File/state | Meaning | Writer | Read/injection behavior |
|---|---|---|---|
| `now.md` | Current fine-grained summaries | Upstream save/NDC | Injected at ordinary start; atomically replaced by writer. |
| `today-YYYY-MM-DD.md` | Daily NDC staging | Upstream NDC/consolidation | Today injected; prior days trigger consolidation. |
| `recent.md` | Recent consolidated memory | Upstream consolidation | Injected within cap. |
| `archive.md` | Older consolidated memory | Upstream consolidation | Injected within cap. |
| `recent-*.md`, `archive-*.md` | Oversized rotated slices | Upstream consolidation | Named/searchable, never automatically injected. |
| `remember.md` | Shared handoff | Upstream installed skill/model | Loaded first at next start. |
| `remember.<session>.md` | Per-session handoff | Upstream installed skill/model | Used only in `per_session` mode. |
| `identity.md`, `core-memories.md` | Identity/key context | User/upstream | Injected according to upstream precedence/caps. |
| `tmp/last-save.json`, `position.*` | Authoritative/session cursor state | Upstream save pipeline | Machine-local; never inject or back up. |
| `tmp/unread-envelope.json` | Quarantined unread span | Upstream extractor | Allows future parser recovery. |
| `tmp/*.lock`, cooldowns, markers | Operational coordination | Upstream hooks/pipeline | Machine-local. |
| `logs/` | Diagnostics | Upstream | Never model context or backup. |
| Pi projection/registry | Host bridge state | Pi adapter | Machine-local, never semantic memory. |

Canonical transition:

```text
Pi entries
  -> append-only projection
  -> upstream extract from committed physical cursor
  -> summary validation
  -> sibling-temp + rename into now.md
  -> atomic last-save.json update
  -> position sidecar update
  -> optional NDC: now.md snapshot -> today file -> truncate retained prefix
  -> later consolidation: prior today files -> recent.md + archive.md
```

The key invariant is: **memory commit precedes cursor commit**. Deliberate terminal no-write outcomes (`SKIP`, rejection, zero exchange, repeated-failure give-up) may advance according to upstream rules.

Empirical note: one requested live storage-evolution lane could not run tools, so inode/mtime mutation experiments were not completed. Storage claims above come from static tracing of installed `0.30.0` source/docs and observed startup output, not a live crash/concurrency experiment. The parity suite must close this gap before release.

## 6. Transcript and extraction design

Pi sessions are trees; upstream Claude extraction consumes a linear JSONL transcript and stores physical line positions. Never point upstream at Pi’s native session file and never rewrite an already-consumed projection.

### Identity

```text
PiSessionKey = Pi session UUID
BranchEpoch  = adapter epoch for one immutable root-to-leaf lineage
HostSessionId = lowercase hex derived from SHA-256("pi:" + PiSessionKey + ":" + BranchEpoch)
ProjectionPath = ~/.pi/agent/remember/transcripts/<PiSessionKey>/<BranchEpoch>.jsonl
```

The derived ID must satisfy upstream `save-session.sh` validation. Projection files and registries use owner-only permissions and live outside the shared memory store, preventing backup pollution.

### Projection algorithm

1. Read `ctx.sessionManager.getBranch()` for the active root-to-leaf lineage.
2. Compare entry IDs against the last published lineage.
3. If it is a strict extension, append only new normalized records.
4. If it diverges (`/tree`, fork semantics, unexpected prefix mismatch), freeze the old projection and start a new epoch.
5. Persist `{Pi session, epoch, host session ID, projection path, source entry IDs, committed cursor}` atomically.
6. Serialize projection publication and hook invocation per session; never let upstream read while a projection write is incomplete.

Use one deterministic physical record per relevant Pi entry. Records upstream should ignore still count toward its physical-line delta, matching its host-transcript design:

- User message -> Claude-shaped `type: "user"` with text blocks.
- Assistant message -> `type: "assistant"` with text and bounded tool-use blocks.
- Tool result -> ignored `progress` record carrying tool identity; it advances physical line count without injecting raw output into summaries.
- Compaction/branch summaries -> explicitly labelled summary records; never masquerade as original human text.
- Model/config/custom state -> ignored progress record only when needed for stable physical correspondence.
- Remember-injected custom messages -> omit entirely to prevent memory feeding back into itself.

Persist the mapping from projection lines to Pi entry IDs. Do not use Pi file offsets as semantic cursors.

### Deduplication across epochs

A branch epoch can share history with an old epoch. Before requesting a save, compute a `SaveId` from host session ID, normalizer version, and source entry-ID range. Keep adapter dedupe metadata machine-locally. Upstream’s previous-entry prompt remains the final semantic dedupe layer. Never delete an old projection while its upstream cursor or recovery record can still refer to it.

## 7. Summarizer and model strategy

Release 1 has one backend: **the installed upstream summarizer**.

- Preserve `REMEMBER_SUMMARIZER`, `REMEMBER_SUMMARIZER_FALLBACK`, `REMEMBER_MODEL`, OAuth precedence, spawn guard, output validation, rejection handling, and failure counters.
- Do not silently route a Pi session to the currently active Pi model.
- Because the projection is Claude-shaped, upstream `auto` normally selects `claude -p`; surface this fact during activation/status so the user understands provider and billing behavior.
- A failed Codex route must not fall back to Claude unless the existing explicit fallback is configured.

A future Pi-native `modelRegistry.complete()` backend is an opt-in compatibility mode, not transparent parity. Add it only after two implementations justify a real summarizer seam. It must duplicate prompt contracts, result gates, provider receipts, timeout/decline semantics, and commit ordering, and its docs must call it store-compatible rather than behavior-identical until parity passes.

## 8. Locking, atomic writes, jobs, recovery, and concurrency

### Cross-process safety

- All shared-store writes go through upstream and therefore use its literal `save.lock`, `staging.lock`, and `consolidation.lock` protocols.
- The TypeScript adapter never “approximately” reproduces those locks.
- Multiple Pi processes are coordinated by upstream locks; each has private projection files.
- Ordinary saves skip on lock contention; forced saves wait using upstream’s bounded policy.

### In-process queue

Use one session coordinator with a promise chain:

- Hot events synchronously mark dirty and return.
- Projection updates and hook calls execute in order.
- Coalesce redundant projection checkpoints, but do not coalesce externally observable `after_post_tool` listener events if full hooks.d compatibility is enabled.
- A `force` request dominates pending ordinary work.
- Queue errors are captured into status/logs; they never become unhandled rejections.

### Shutdown/reload

- Save opportunistically at `agent_settled`, reducing dependency on process exit.
- On `session_shutdown`, stop accepting work, publish the latest projection, invoke upstream SessionEnd, and wait only for its short hook handoff—not the detached model pipeline.
- Persist a pending/recovery marker before detaching. Next `session_start` reconciles it.
- On reload, perform the same handoff; do not skip flush merely because the reason is `reload`.
- `SIGKILL` remains unrecoverable in-process; next-start recovery handles any projection that was published before death.

### Writer rules

Adapter-private JSON and projection manifests use unique sibling temp files plus rename, `umask 077`, checked write results, and no predictable shared temp names. Path containment and symlink checks happen before every upstream invocation.

## 9. Config, path, and version compatibility

### Runtime discovery

Resolve from `~/.claude/plugins/installed_plugins.json`, selecting the exact `remember@...` record and supported version. Do not sort cache directory names and pick the newest-looking entry.

`PI_REMEMBER_PLUGIN_ROOT` may override discovery, but must pass the same capability probe.

Probe before activation:

- Manifest name/version/commit where available.
- Required executable scripts and Python modules.
- `doctor.sh --json` schema support when used.
- Hook output shape.
- Required config and lock capabilities.
- Bash, Python, jq/coreutils, and chosen summarizer binary.

Unknown/incompatible versions enter read-only mode with an actionable warning. An explicit unsafe override may be offered for development but must never be the default.

### Config and paths

Let upstream resolve:

```text
bundled defaults < ~/.remember/config.json < <REMEMBER_DIR>/config.json
```

The installed `0.30.0` package lacks `config.json` despite docs describing it. Runtime fallbacks still provide defaults. The adapter must probe this anomaly and must not invent a second config merge.

Pass fresh validated `cwd`, session ID, transcript path, and plugin root on every invocation. Preserve upstream behavior for:

- Relative `.remember` and external `data_dir`.
- `{slug}` replacement.
- Linked worktrees sharing the main checkout store.
- `CLAUDE_CONFIG_DIR`.
- Non-ASCII/long/Windows slug semantics.
- `handoff_mode` and per-session path hints.
- Timezone/day boundaries.

## 10. `/remember` and doctor UX

### `/remember`

Do not redistribute a copied handoff prompt. Expose the **installed upstream skill directory** through `resources_discover`, allowing Pi to use the user-installed `skills/remember/SKILL.md` at runtime. This preserves the exact supported handoff format and follows the path hint emitted by SessionStart.

If Pi command precedence prevents the skill from receiving `/remember`, do not register a competing extension command. Add only a small alias such as `/remember-save` for forced automatic-memory capture.

### Native commands

- `/remember:doctor` — run installed `doctor.sh`, capture stdout, and display it verbatim. Never reinterpret or “improve” its verdict.
- `/remember-status` — adapter-only status: supported runtime version, store/project path, host session/epoch, projection cursor, dirty/queue state, last hook outcome, and summarizer route.
- `/remember-save` — wait for idle, publish projection, invoke a forced save, and report actual disposition.

Commands work in TUI, RPC, JSON, and print modes without writing uncontrolled stdout. UI notifications are observability only; persistent behavior must not depend on them.

### Output channels

Parse upstream hook JSON into two channels:

- `additionalContext` -> hidden, delimited custom message for the model.
- `systemMessage`/diagnostics -> human-visible notification or custom message, never model context.

Plain hook text is bounded and treated as retrieved untrusted memory, not elevated into Pi’s system prompt.

## 11. Security, privacy, and license constraints

- The installed runtime executes with user privileges; require project trust before a project-local package activates.
- Validate real paths and containment for plugin root, projection, cwd, and store. Reject CR/LF, option-shaped IDs, symlink escapes, and missing projection files.
- Projection files contain session text. Store them owner-only, document retention, and prune only after no recovery/cursor can reference them.
- Never log OAuth tokens, prompts, raw private memory, or full hook payloads by default.
- Do not make outbound requests beyond the provider CLI/configuration the user has explicitly enabled.
- Preserve upstream’s explicit provider fallback policy; never create surprise cross-provider billing.
- Optional git backup is high-impact because it transmits memory. Leave it governed by upstream config and warnings; do not enable it automatically.

Licensing is a release blocker, not an implementation detail:

- Lower-risk approach: detect and invoke a copy the user independently installed; do not bundle upstream files.
- Do not publish upstream scripts, prompts, docs, fixtures, or substantial source excerpts under this package’s MIT license.
- Replace the prototype’s copied/closely paraphrased handoff prompt with runtime exposure of the installed skill.
- Upstream’s detailed Community License and README summary appear inconsistent about modification/redistribution. Obtain clarification from Digital Process Tools before public distribution. This is technical risk analysis, not legal advice.

## 12. Phased implementation

### Phase 0 — preserve evidence, retire prototype assumptions

Deliverables:

- Keep the current prototype only until parity fixtures exist.
- Add `ARCHITECTURE.md` (this document).
- Replace environment-dependent unit tests with hermetic fixtures.
- Mark package pre-release and supported version `0.30.0`.

### Phase 1 — runtime resolver and runner

Files:

- `src/plugin.ts`: installed-record parsing, exact version selection, capability report.
- `src/runner.ts`: bounded spawn, stdin, environment allowlist, output parser, cancellation.
- `src/types.ts`: `CapabilityReport`, `HostEvent`, `HookOutput`, `HookDisposition`.
- `tests/unit/plugin.test.ts`, `runner.test.ts`.

Exit criterion: fake runtime tests cover plain/JSON outputs, timeout, malformed output, missing tools, unsupported versions, and no secret leakage.

### Phase 2 — branch-safe projection

Files:

- `src/projection.ts`: lineage comparison, epoch creation, normalization, atomic registry.
- `tests/unit/projection.test.ts`.
- `tests/fixtures/pi-sessions/*.jsonl`: minimal independently authored Pi v3 fixtures.

Exit criterion: append, resume, fork, `/tree` divergence, compaction, parallel tools, reload, and ephemeral sessions never rewrite consumed lines or collide IDs.

### Phase 3 — lifecycle coordinator

Files:

- `src/runtime.ts`: session coordinator, queue, settled/shutdown recovery.
- `src/context.ts`: context/notice channel separation and dedupe revisions.
- `extensions/remember.ts`: thin registration only.
- `tests/integration/lifecycle.test.ts`.

Exit criterion: no model or shell work blocks `tool_result`; every replacement lifecycle flushes or leaves a recoverable marker; startup context is injected exactly once per revision.

### Phase 4 — installed-runtime parity

Files:

- `tests/parity/harness.ts`.
- `tests/parity/scenarios/*.test.ts`.
- `tests/helpers/store-manifest.ts`.

Run scenarios against the installed upstream oracle and candidate adapter in isolated temporary homes/projects. No real user store.

### Phase 5 — commands, resources, packaging

Files:

- Add `resources_discover` for installed upstream skill path.
- Add doctor/status/save commands.
- `README.md`: installation, version pin, provider/billing behavior, privacy, limitations.
- Final `package.json` Pi manifest and peer dependencies.

Exit criterion: local `pi -e .` smoke test in TUI plus JSON/print stdout-clean tests.

### Phase 6 — release gate

- Isolated live Claude CLI test.
- Alternate-writer test with Claude and Pi.
- Concurrency/crash injection.
- License clarification.
- Windows validation if advertised.

## 13. Test pyramid and black-box parity harness

### Unit tests

- Installed plugin record parsing and version pinning.
- Capability probe.
- Hook output parser and channel separation.
- Pi entry normalization.
- Strict-extension/common-prefix detection.
- Epoch/session-ID derivation.
- Atomic registry recovery.
- Context revision dedupe.

### Integration tests

Use a deterministic fake `RememberRuntime` to validate Pi event ordering, queueing, reload, shutdown, headless modes, and command behavior without spawning a model.

### Black-box parity tests

For each scenario, run:

- Oracle: installed Remember against a Claude-shaped fixture.
- Candidate: Pi adapter against the equivalent Pi fixture.
- Compare normalized store manifests and dispositions.

Normalize timestamps, PIDs, temp roots, and nondeterministic model prose. Do not normalize positions, filenames, permissions, section order, provider selection, lock behavior, byte caps, or retained facts.

Required scenarios:

1. Empty/new store.
2. Startup, resume, clear, fork, reload, and tree divergence.
3. Exactly 50 vs 51 physical projection lines (`>` trigger).
4. Save cooldown.
5. Three-human minimum and 30-exchange fallback.
6. Valid save, rejection, malformed response, repeated failure/give-up.
7. Forced SessionEnd below ordinary thresholds.
8. Compaction identity-only reinjection.
9. Crash then recovery.
10. Shared and per-session handoffs with concurrent sessions.
11. External store migration and `{slug}`.
12. Main checkout plus linked worktrees.
13. Config edit between hot calls.
14. Extract/injection/consolidation byte caps and rotations.
15. Read-only/full store and malformed config.
16. Concurrent saves, lock contention, and shutdown overlap.
17. Local backup/restore using a temporary bare repository only.
18. Explicit provider routing and fallback.
19. Non-ASCII, long, Windows-like, and case-variant paths.
20. Runtime/plugin update and Pi reload.

Store manifest format:

```text
relative path | file type | mode | size/hash | normalized semantic sections
```

Strongest acceptance scenario—the alternate-writer test:

1. Oracle writes A.
2. Candidate reads A and writes B.
3. Oracle reads A+B and writes C.
4. Candidate reads A+B+C.
5. Assert each fact occurs once, positions are monotonic, consolidation remains valid, unknown files survive, and handoff delivery state is correct.
6. Repeat with two concurrent hosts and interruption during each write stage.

Live provider tests remain opt-in and are never required for ordinary unit CI.

## 14. Performance budgets

Measured budgets must be recorded by platform; these are release targets:

- Extension factory: no subprocesses, timers, watchers, or filesystem scan beyond registration.
- `tool_result`: p95 under 2 ms; mark dirty only.
- Projection append/checkpoint: p95 under 10 ms for an ordinary new entry, under 50 ms for branch reprojection metadata (excluding initial full projection).
- Post-tool upstream hook: off the agent critical path; one queued invocation per tool event when full hooks.d parity is enabled.
- Warm `before_agent_start` including upstream prompt hook: p95 under 150 ms on supported Linux/macOS hardware; warn in doctor if consistently above 500 ms.
- `session_start` context availability: p95 under 500 ms excluding optional restore/consolidation network/model work, which remains detached as upstream specifies.
- Shutdown hook handoff: under 250 ms before upstream detached work; hard bound 2 seconds in Pi.
- No full active-branch rewrite on ordinary turns.
- At most one adapter job per Pi session and one upstream save writer per store.
- Projection growth is linear in durable Pi entries; pruning is bounded and reference-aware.

If exact hooks.d PostToolUse parity is too expensive on a platform, expose an explicitly named efficient mode that batches listener events. It is not the default and is not called fully behavior-compatible.

## 15. Unresolved decisions and risks

1. **Empirical storage gap:** live inode/crash/concurrency experiments were not completed. Must close in Phase 4/6.
2. **Upstream package anomaly:** installed `0.30.0` has `config.example.json` but no `config.json`; determine whether this is expected marketplace packaging.
3. **Provider expectation:** upstream auto-routing of a Claude-shaped Pi projection selects Claude. Confirm whether that default is acceptable before release; never change it silently.
4. **Pi projection semantics:** finalize which ignored Pi entries receive physical lines so threshold behavior is stable and documented.
5. **Startup injection timing:** verify hidden custom messages survive Pi compaction/retry exactly as intended across TUI/RPC/JSON/print.
6. **SessionEnd:** installed `0.30.0` performs expensive preamble before detach; consider requiring `0.31.0` after parity qualification because it fixes this without changing store semantics.
7. **Third-party hooks.d:** exact every-tool dispatch costs subprocesses. Full mode preserves it; efficient mode must be labelled divergent.
8. **Projection retention:** define deletion proof using upstream positions/recovery state; never prune by age alone.
9. **License:** public redistribution remains blocked pending clarification.
10. **Current prototype:** it must not ship unchanged; especially remove newest-cache discovery, full rewrites, synchronous tool hook, reload skip, and copied handoff prompt.

## 16. Done criteria

The extension is ready only when all are true:

- Runtime discovery pins an explicitly supported installed Remember version and fails closed to read-only on mismatch.
- Pi branch projections are append-only per epoch and survive resume, fork, reload, tree navigation, and compaction.
- Shared-store writes occur only through upstream’s canonical scripts/locks.
- Startup memory and prompt context are delivered once in the correct model channel; human notices never leak into model context.
- Tool hot paths perform no awaited model/subprocess work.
- Settled/shutdown/recovery behavior loses no published span in crash-injection tests.
- `/remember` uses the installed upstream skill rather than copied content.
- Doctor output is relayed verbatim and status accurately reports adapter state.
- Config/path/worktree/slug/timezone behavior passes parity scenarios.
- Alternate-writer tests pass with no lost or duplicate facts and monotonic positions.
- Concurrency, malformed output, read-only disk, oversized store, and provider-failure tests pass.
- TUI, RPC, JSON, and print modes remain stdout-clean and noninteractive-safe.
- Performance budgets pass on every advertised platform.
- No upstream source or substantial prompt text is redistributed.
- License/distribution approval is recorded.
- README states the supported Remember/Pi versions, provider/billing behavior, security model, and honest limitations.

## Research provenance

The plan synthesizes four independent lanes:

- Installed `0.30.0` source/docs lifecycle and pipeline trace.
- Storage-evolution lane, which observed startup output but could not perform its requested tool-based live experiment; this gap is explicit above.
- Pi `0.85.1` extension/session integration analysis.
- Independent compatibility, reliability, security, and licensing audit.

The final oracle synthesis twice failed because the Kiro provider hit an idle timeout. Its preserved partial recommendations agreed with the decision above: use a version-pinned adapter with an append-only projection, per-session serialization, separated output channels, explicit provider behavior, and a black-box compatibility gate.
