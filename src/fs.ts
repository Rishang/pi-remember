import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, truncateSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function isContained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Create an owner-only directory chain, refusing any symlinked or non-directory component. */
export function ensurePrivateDirectory(path: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error("unsafe directory");
	const filesystemRoot = path.split(sep)[0] === "" ? sep : path.split(sep)[0];
	let current = filesystemRoot;
	for (const part of path.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			const info = lstatSync(current);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe directory");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			mkdirSync(current, { mode: 0o700 });
		}
	}
	chmodSync(path, 0o700);
}

export function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function truncateDurable(path: string, bytes: number): void {
	truncateSync(path, bytes);
	syncDirectory(path);
	syncDirectory(dirname(path));
}

export function truncateUtf8(value: string, maximum: number, marker = "\n[truncated by pi-remember]"): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maximum) return value;
	const tail = Buffer.from(marker, "utf8");
	let end = Math.max(0, maximum - tail.length);
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return Buffer.concat([buffer.subarray(0, end), tail.subarray(0, maximum - end)]).toString("utf8");
}
