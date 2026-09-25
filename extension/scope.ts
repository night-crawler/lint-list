import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { type LintIgnore, loadLintIgnore } from "./lintignore";
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

async function snapshotFiles(cwd: string, files: string[], ignore: LintIgnore): Promise<{ files: string[]; diffText: string }> {
	const included: string[] = [];
	const diffs: string[] = [];
	for (const file of files) {
		if (!isSourcePath(file) || ignore(file)) continue;
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

const GIT_QUOTE_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Decode one git C-quoted path token (`"a/\303\251"`); unquoted tokens pass through. */
function unquoteGitPath(token: string): string {
	if (!token.startsWith('"')) return token;
	const bytes: number[] = [];
	const end = token.length - 1;
	for (let i = 1; i < end; ) {
		const escape = token.indexOf("\\", i);
		const runEnd = escape < 0 || escape >= end ? end : escape;
		if (runEnd > i) {
			bytes.push(...Buffer.from(token.slice(i, runEnd), "utf8"));
			i = runEnd;
		} else if (/[0-7]/.test(token[i + 1])) {
			bytes.push(Number.parseInt(token.slice(i + 1, i + 4), 8));
			i += 4;
		} else {
			const byte = GIT_QUOTE_ESCAPES[token[i + 1]];
			if (byte === undefined) throw new Error(`Invalid git quoted path ${token}`);
			bytes.push(byte);
			i += 2;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/** Destination path of one `diff --git` section: `rename to`/`copy to` when present, else the symmetric header path. */
function diffSectionPath(section: string): string {
	const lines = section.split("\n");
	for (const line of lines.slice(1)) {
		if (/^(---|\+\+\+|@@|Binary files) /.test(line)) break;
		const target = /^(?:rename|copy) to (.*)$/.exec(line)?.[1];
		if (target !== undefined) return unquoteGitPath(target);
	}
	const header = lines[0].slice("diff --git ".length);
	if (header.startsWith('"')) {
		const end = /^"(?:[^"\\]|\\.)*"/.exec(header)?.[0];
		if (end) return unquoteGitPath(end).replace(/^a\//, "");
	} else {
		const path = header.slice(2, 2 + (header.length - 5) / 2);
		if (header === `a/${path} b/${path}`) return path;
	}
	throw new Error(`Cannot attribute git diff section: ${lines[0]}`);
}

/** Drop `diff --git` sections whose destination is ignored; kept bytes are unchanged. */
function filterDiffSections(diffText: string, ignore: LintIgnore): string {
	const starts: number[] = [];
	if (diffText.startsWith("diff --git ")) starts.push(0);
	for (let at = diffText.indexOf("\ndiff --git "); at >= 0; at = diffText.indexOf("\ndiff --git ", at + 1)) starts.push(at + 1);
	let kept = diffText.slice(0, starts[0] ?? diffText.length);
	for (let i = 0; i < starts.length; i++) {
		const section = diffText.slice(starts[i], starts[i + 1] ?? diffText.length);
		if (!ignore(diffSectionPath(section))) kept += section;
	}
	return kept;
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
	const ignore = await loadLintIgnore(cwd);
	const files: string[] = [];
	const deletedFiles: string[] = [];
	let diffText = "";
	let ignoredAny = false;
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
			if (ignore(file)) ignoredAny = true;
			else (status === "D" ? deletedFiles : files).push(file);
		}
		diffText = patch.stdout.slice(boundary + 2);
		if (ignoredAny) diffText = filterDiffSections(diffText, ignore);
	}
	return { kind: "diff", base, baseCommit, files, deletedFiles, diffText };
}

/** Preserve full-tree mode with one all-additions snapshot, not per-rule filesystem scans. */
export async function resolveFullScope(exec: GitExec, cwd: string): Promise<AuditScope> {
	const tracked = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, timeout: 15_000 });
	const ignore = await loadLintIgnore(cwd);
	const files: string[] = [];
	if (tracked.code === 0) {
		files.push(...tracked.stdout.split("\0").filter(Boolean));
	} else {
		const walk = async (dir: string) => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					const path = join(dir, entry.name);
					if (SKIPPED_DIRS[entry.name] !== true && !ignore(relative(cwd, path), true)) await walk(path);
				} else if (entry.isFile()) files.push(relative(cwd, join(dir, entry.name)));
			}
		};
		await walk(cwd);
	}
	return { kind: "full", ...(await snapshotFiles(cwd, [...new Set(files)].sort(), ignore)) };
}
