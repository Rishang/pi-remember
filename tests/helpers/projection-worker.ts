import { readFileSync } from "node:fs";
import { projectBranch, type PiBranchEntry } from "../../src/projection.ts";

const [root, sessionId, branchPath] = process.argv.slice(2);
if (!root || !sessionId || !branchPath) process.exit(2);
const branch = JSON.parse(readFileSync(branchPath, "utf8")) as PiBranchEntry[];
const result = await projectBranch({ root, sessionId, branch, lockTimeoutMs: 10_000 });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
