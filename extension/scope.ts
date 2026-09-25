import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AuditScope } from "./types";

export type GitExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; code: number }>;

const SKIPPED_DIRS: Record<string, true> = {
	".git": true,
	".hg": true,
	".svn": true,
	node_modules: true,
	target: true,
	dist: true,
	build: true,
	out: true,
	vendor: true,
	third_party: true,
	".omp": true,
	".idea": true,
	".vscode": true,
	__pycache__: true,
	".venv": true,
	venv: true,
	".next": true,
	".turbo": true,
	coverage: true,
};
const BINARY_EXTENSIONS =
	/\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|class|o|a|so|dll|dylib|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|lockb|sqlite|db|parquet)$/i;
const isSourcePath = (file: string): boolean =>
	!BINARY_EXTENSIONS.test(file) && !file.split("/").some((part) => SKIPPED_DIRS[part] === true);

export async function resolveAuditScope(
	exec: GitExec,
	cwd: string,
	mode: "auto" | "diff" | "full",
	base: string,
): Promise<AuditScope> {
	if (mode === "full") return resolveFullScope(exec, cwd);
	if (mode === "auto") {
		const branch = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeout: 15_000 });
		if (branch.code === 0 && (branch.stdout.trim() === "main" || branch.stdout.trim() === "master")) {
			return resolveFullScope(exec, cwd);
		}
	}
	const scope = await resolveDiffScope(exec, cwd, base);
	if (scope) return scope;
	if (mode === "diff") throw new Error("scope=diff but no base could be resolved (not a git repo or no base ref)");
	return resolveFullScope(exec, cwd);
}

/** A full-tree file represented as additions; diff mode never synthesizes untracked changes. */
function addedFileDiff(file: string, content: string): string {
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const oldPath = JSON.stringify(`a/${file}`);
	const newPath = JSON.stringify(`b/${file}`);
	const header = `diff --git ${oldPath} ${newPath}\nnew file mode 100644\n--- /dev/null\n+++ ${newPath}\n`;
	if (lines.length === 0) return header;
	return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n${content.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
}

async function snapshotFiles(cwd: string, files: string[]): Promise<{ files: string[]; diffText: string }> {
	const included: string[] = [];
	const diffs: string[] = [];
	for (const file of files) {
		if (!isSourcePath(file)) continue;
		let content: string;
		try {
			content = await readFile(join(cwd, file), "utf8");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		if (content.includes("\0")) continue;
		included.push(file);
		diffs.push(addedFileDiff(file, content));
	}
	return { files: included, diffText: diffs.join("") };
}

/** Read metadata and patch from ONE git diff invocation, including rename/deletion paths without quoting loss. */
export async function resolveDiffScope(exec: GitExec, cwd: string, baseArg: string): Promise<AuditScope | undefined> {
	const git = async (...args: string[]) => {
		const result = await exec("git", args, { cwd, timeout: 15_000 });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};
	if ((await git("rev-parse", "--is-inside-work-tree")) !== "true") return undefined;
	const originHead = baseArg ? undefined : await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
	const candidates = baseArg ? [baseArg] : ["main", "master", originHead, "origin/main", "origin/master"];
	let base: string | undefined;
	let baseCommit: string | undefined;
	for (const candidate of candidates) {
		if (!candidate) continue;
		const commit = await git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
		if (commit) {
			base = candidate;
			baseCommit = commit;
			break;
		}
	}
	if (!base || !baseCommit) {
		if (baseArg) throw new Error(`Cannot resolve diff base ${JSON.stringify(baseArg)}`);
		return undefined;
	}

	const patch = await exec(
		"git",
		[
			"diff",
			"--patch-with-raw",
			"-z",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--unified=3",
			"-M",
			baseCommit,
			"--",
		],
		{ cwd, timeout: 15_000 },
	);
	if (patch.code !== 0) throw new Error("git diff failed; no audit snapshot was captured");
	const files: string[] = [];
	const deletedFiles: string[] = [];
	let diffText = "";
	if (patch.stdout) {
		const boundary = patch.stdout.indexOf("\0\0");
		if (boundary < 0) throw new Error("git diff returned no raw-metadata/patch boundary");
		const metadata = patch.stdout.slice(0, boundary).split("\0");
		for (let i = 0; i < metadata.length; ) {
			const header = metadata[i++];
			const status = /^:\d+ \d+ [\da-f]+ [\da-f]+ ([A-Z])\d*$/.exec(header)?.[1];
			let file = metadata[i++];
			if (status === "R" || status === "C") file = metadata[i++];
			if (!status || file === undefined) throw new Error("Invalid git diff raw metadata");
			(status === "D" ? deletedFiles : files).push(file);
		}
		diffText = patch.stdout.slice(boundary + 2);
	}
	return { kind: "diff", base, baseCommit, files, deletedFiles, diffText };
}

/** Preserve full-tree mode with one all-additions snapshot, not per-rule filesystem scans. */
export async function resolveFullScope(exec: GitExec, cwd: string): Promise<AuditScope> {
	const tracked = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, timeout: 15_000 });
	const files: string[] = [];
	if (tracked.code === 0) {
		files.push(...tracked.stdout.split("\0").filter(Boolean));
	} else {
		const walk = async (dir: string) => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					if (SKIPPED_DIRS[entry.name] !== true) await walk(join(dir, entry.name));
				} else if (entry.isFile()) files.push(relative(cwd, join(dir, entry.name)));
			}
		};
		await walk(cwd);
	}
	return { kind: "full", ...(await snapshotFiles(cwd, [...new Set(files)].sort())) };
}
