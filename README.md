# pi-remember

A [Pi](https://github.com/earendil-works/pi) extension that lets Pi sessions feed the **Claude Code Remember plugin** you have already installed. It projects each Pi session into a Claude-shaped transcript and calls Remember's own hook scripts, so Pi and Claude Code share one memory store.

It does not bundle any Remember code. It looks for the copy Claude Code installed and runs that.

> **Status: pre-release.** Hook execution is **off by default** and stays off until the provider-free qualification report (below) passes every required scenario. Two scenarios (`full-save-alternate-writer`, `hook-lifecycle`) are currently always `blocked`, so today the extension runs **read-only**: skill discovery, `/remember:doctor` and `/remember-status` work, and memory capture does not.

## Requirements

| Component | Version |
|---|---|
| Claude Code Remember plugin | exactly `0.30.0`, commit `54f4da9f10a90b77fb57318192bd5a936a6d4a01` |
| Pi (`@earendil-works/pi-coding-agent`) | lifecycle written against `0.85.1` |
| Tools on `PATH` | `bash`, `python3`, `jq` |
| Node (tests only) | a version with `--experimental-strip-types` |

Runtime discovery reads `~/.claude/plugins/installed_plugins.json` and selects the `remember@…` record matching the pinned version and commit. `PI_REMEMBER_PLUGIN_ROOT` overrides discovery but must pass the same checks. Any other version makes the extension read-only; it never guesses from cache directory names.

## Install

```bash
pi -e /path/to/pi-remember          # try it for one run
pi install /path/to/pi-remember     # or add it as a local package
```

## Commands

| Command | What it does |
|---|---|
| `/skill:remember` | The installed upstream `skills/remember/SKILL.md`, exposed through `resources_discover` only when the runtime passes the version pin. Writes the handoff note. |
| `/remember:doctor` | Runs upstream `scripts/doctor.sh` and shows its output verbatim. Works in read-only mode so it can explain why. |
| `/remember-status` | Adapter state: supported vs installed version, probe issues, host session/epoch, projection revision, dirty/queue state, last hook result. |
| `/remember-save` | Waits for the agent to go idle, publishes the projection, and runs upstream `save-session.sh <id> --force`. Reports what actually happened. |

Command output goes to the UI notification channel (or stderr when there is no UI). It is never sent as a message, because Pi forwards custom messages to the model.

## Qualification

```bash
npm run test:parity -- --output-root ~/.pi/agent/remember
```

This runs the installed Remember runtime in isolated temporary homes with a fake provider on `PATH`, so it makes no model calls. It writes `qualification-v1.json`. Hooks run only when that file matches the installed version and commit and every required scenario has passed.

## Provider and billing

Remember itself picks the summarizer. For a Claude-shaped transcript it uses the `claude` CLI (Haiku), billed to whatever account that CLI is logged into. This extension adds no provider, never switches provider, and makes no network requests of its own.

## Privacy and security

- Projections contain session text. They live under `~/.pi/agent/remember` in owner-only (`0700`/`0600`) files. Nothing is written in read-only mode.
- Scripts run with an allowlisted environment (`PATH`, `HOME`, `USER`, locale, `TZ`, and the Remember path variables). Secrets are redacted from captured output.
- Plugin root, projection, and recovery paths are checked with realpath and containment checks; symlink escapes are rejected.
- Remember's optional git backup sends memory off-machine. It stays under Remember's own config and is never turned on here.

## Limitations

- Read-only until qualification can pass (see Status above).
- Store path and summarizer route are decided by upstream Remember and are not shown in `/remember-status`; use `/remember:doctor`.
- `/remember` is not registered as a command. Pi runs skills as `/skill:remember`, and a competing command could shadow the upstream skill.
- Only Linux/POSIX has been exercised. Windows is untested.
- Projection files are not pruned yet.

## License

Not yet licensed for distribution. Remember's Community License terms on modification and redistribution are unclear, so the package stays `private` until that is clarified. This package never copies Remember's scripts, prompts, or docs.

## Development

```bash
npm run check   # syntax check every module
npm test        # unit, integration, and provider-free parity tests
```
