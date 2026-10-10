import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isContained } from "./fs.ts";
import type {
	CapabilityIssue,
	CapabilityReport,
	InstalledRecord,
	ProbeOptions,
	RememberManifest,
} from "./types.ts";

/** The scripts the adapter launches. Like Claude Code's hooks.json, each runs as `bash <script>`. */
const REQUIRED_SCRIPTS = [
	"scripts/session-start-hook.sh",
	"scripts/user-prompt-hook.sh",
	"scripts/post-tool-hook.sh",
	"scripts/session-end-hook.sh",
	"scripts/save-session.sh",
] as const;
const REQUIRED_TOOLS = ["bash", "python3", "jq"] as const;

type Candidate = { key: string; record: InstalledRecord };

function issue(level: CapabilityIssue["level"], code: string, message: string): CapabilityIssue {
	return { level, code, message };
}

function readJson(path: string): unknown {
	accessSync(path, constants.R_OK);
	return JSON.parse(readFileSync(path, "utf8"));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function installedRecord(value: unknown): InstalledRecord | undefined {
	if (!isObject(value)) return undefined;
	if (
		!optionalString(value.installPath)
		|| !optionalString(value.version)
		|| !optionalString(value.gitCommitSha)
		|| !optionalString(value.installedAt)
		|| !optionalString(value.lastUpdated)
	) return undefined;
	return {
		installPath: value.installPath,
		version: value.version,
		gitCommitSha: value.gitCommitSha,
		installedAt: value.installedAt,
		lastUpdated: value.lastUpdated,
	};
}

function recordsFrom(value: unknown): Candidate[] {
	if (!isObject(value) || !isObject(value.plugins)) return [];
	const records: Candidate[] = [];
	for (const [key, rawRecords] of Object.entries(value.plugins)) {
		if (!(key === "remember" || key.startsWith("remember@")) || !Array.isArray(rawRecords)) continue;
		for (const raw of rawRecords) {
			const record = installedRecord(raw);
			if (record) records.push({ key, record });
		}
	}
	return records;
}

/** The most recently updated install wins, the one Claude Code itself would be running. */
function compareCandidates(a: Candidate, b: Candidate): number {
	return (b.record.lastUpdated ?? b.record.installedAt ?? "").localeCompare(a.record.lastUpdated ?? a.record.installedAt ?? "")
		|| a.key.localeCompare(b.key)
		|| (a.record.installPath ?? "").localeCompare(b.record.installPath ?? "");
}

function chooseRecord(records: Candidate[]): Candidate {
	return [...records].sort(compareCandidates)[0];
}

function regularFile(path: string, mode: number): string | undefined {
	try {
		const resolved = realpathSync(path);
		if (!statSync(resolved).isFile()) return undefined;
		accessSync(resolved, mode);
		return resolved;
	} catch {
		return undefined;
	}
}

function runtimeFile(root: string, relativePath: string): string | undefined {
	const path = regularFile(join(root, relativePath), constants.R_OK);
	return path && isContained(root, path) ? path : undefined;
}

function toolFile(path: string): string | undefined {
	return regularFile(path, constants.X_OK);
}

function findTool(name: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = toolFile(join(directory, name));
		if (candidate) return candidate;
	}
	return undefined;
}

export function probeRememberRuntime(options: ProbeOptions = {}): CapabilityReport {
	const env = options.env ?? process.env;
	const issues: CapabilityIssue[] = [];
	const report: CapabilityReport = {
		disposition: "read-only",
		issues,
		paths: {},
		tools: {},
	};

	let requestedRoot: string | undefined;
	let record: InstalledRecord | undefined;
	const override = env.PI_REMEMBER_PLUGIN_ROOT?.trim();
	if (override) {
		requestedRoot = override;
		report.source = "override";
	} else {
		const installedPath = options.installedPluginsPath
			?? join(options.homeDir ?? homedir(), ".claude", "plugins", "installed_plugins.json");
		let parsed: unknown;
		try {
			parsed = readJson(installedPath);
		} catch {
			issues.push(issue("error", "installed-record-unreadable", "Remember installation records could not be read."));
			return report;
		}
		const records = recordsFrom(parsed);
		if (records.length === 0) {
			issues.push(issue("error", "installed-record-missing", "No valid installed Remember record was found."));
			return report;
		}
		const selected = chooseRecord(records);
		record = selected.record;
		requestedRoot = record.installPath;
		report.source = "installed-record";
		if (!requestedRoot) {
			issues.push(issue("error", "install-path-missing", "The selected Remember record has no installation path."));
			return report;
		}
	}

	try {
		report.root = realpathSync(requestedRoot);
		if (!statSync(report.root).isDirectory()) throw new Error("not a directory");
	} catch {
		issues.push(issue("error", "plugin-root-invalid", "The Remember installation root is not a resolvable directory."));
		return report;
	}

	const manifestPath = runtimeFile(report.root, ".claude-plugin/plugin.json");
	report.paths.manifest = manifestPath ?? join(report.root, ".claude-plugin", "plugin.json");
	let manifest: RememberManifest;
	try {
		if (!manifestPath) throw new Error("invalid manifest path");
		const parsed = readJson(manifestPath);
		if (!isObject(parsed)) throw new Error("not an object");
		manifest = parsed as RememberManifest;
		report.manifest = manifest;
	} catch {
		issues.push(issue("error", "manifest-invalid", "The Remember plugin manifest is missing, unreadable, malformed, or escapes its root."));
		return finish(report);
	}

	if (manifest.name !== "remember") {
		issues.push(issue("error", "manifest-name", "The selected plugin manifest is not Remember."));
	}
	report.version = typeof manifest.version === "string" ? manifest.version : record?.version;
	report.gitCommitSha = record?.gitCommitSha;

	for (const relativePath of REQUIRED_SCRIPTS) {
		if (!runtimeFile(report.root, relativePath)) {
			issues.push(issue("error", "required-script-invalid", `Required Remember script is missing, unreadable, not a regular file, or escapes its root: ${relativePath}`));
		}
	}
	const skill = runtimeFile(report.root, "skills/remember/SKILL.md");
	if (skill) report.paths.skill = skill;
	else issues.push(issue("warning", "skill-missing", "The installed Remember skill was not found, so /skill:remember is unavailable."));

	for (const tool of REQUIRED_TOOLS) {
		const supplied = options.toolPaths?.[tool];
		const path = supplied === undefined ? findTool(tool, env) : supplied ? toolFile(supplied) : undefined;
		report.tools[tool] = path;
		if (!path) issues.push(issue("error", "required-tool-missing", `Required Remember tool is unavailable: ${tool}`));
	}
	return finish(report);
}

function finish(report: CapabilityReport): CapabilityReport {
	report.disposition = report.issues.some(({ level }) => level === "error") ? "read-only" : "ready";
	return report;
}
