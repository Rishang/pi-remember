import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type StoreManifestEntry = {
	path: string;
	type: "file" | "directory";
	mode: string;
	size: number;
	hash?: string;
	sections: string[];
};

function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function normalizeText(text: string, roots: readonly string[]): string {
	let value = text.replace(/\bpid[=: ]+\d+\b/gi, "pid=<PID>")
		.replace(/\b\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?\b/g, "<TIMESTAMP>");
	for (const root of [...roots].sort((a, b) => b.length - a.length)) value = value.replaceAll(root, "<ROOT>");
	return value;
}

function semanticSections(path: string, roots: readonly string[]): string[] {
	const text = normalizeText(readFileSync(path, "utf8"), roots);
	if (path.endsWith(".json")) {
		try { return [JSON.stringify(JSON.parse(text))]; } catch { return [text]; }
	}
	const sections = text.split(/(?=^=== |^##? )/m).map((part) => part.trim()).filter(Boolean);
	return sections.length ? sections : [text];
}

/** Build a deterministic, fail-closed store manifest without following links. */
export function storeManifest(root: string, normalizedRoots: readonly string[] = [root]): StoreManifestEntry[] {
	const absolute = resolve(root);
	if (!isAbsolute(root) || absolute !== root || realpathSync(root) !== root) throw new Error("unsafe store root");
	const entries: StoreManifestEntry[] = [];
	const visit = (directory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			if (!contained(root, path)) throw new Error("store path escaped root");
			const info = lstatSync(path);
			if (info.isSymbolicLink()) throw new Error("store contains symlink");
			const relativePath = relative(root, path).split(sep).join("/");
			const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
			if ((info.mode & 0o077) !== 0) throw new Error("store entry is not owner-only");
			if (info.isDirectory()) {
				entries.push({ path: relativePath, type: "directory", mode, size: info.size, sections: [] });
				visit(path);
			} else if (info.isFile()) {
				if (info.nlink !== 1) throw new Error("store contains hard-linked file");
				const content = readFileSync(path);
				entries.push({
					path: relativePath,
					type: "file",
					mode,
					size: content.length,
					hash: createHash("sha256").update(content).digest("hex"),
					sections: semanticSections(path, normalizedRoots),
				});
			} else throw new Error("store contains unsupported file type");
		}
	};
	visit(root);
	return entries;
}

export function comparableManifest(entries: readonly StoreManifestEntry[]): unknown {
	return entries.map(({ path, type, mode, size, hash, sections }) => ({ path, type, mode, size, hash, sections }));
}
