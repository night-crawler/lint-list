import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** `(path, isDir) => ignored` for slash-separated paths relative to the `.lintignore` directory. */
export type LintIgnore = (path: string, isDir?: boolean) => boolean;

interface IgnoreRule {
	regex: RegExp;
	negate: boolean;
	dirOnly: boolean;
}

/** Translate one anchored gitignore glob; `*`, `?` and `[...]` never cross `/`, `**` spans segments. */
function compileGlob(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			const segmentStart = i === 0 || glob[i - 1] === "/";
			if (glob[i + 1] === "*" && segmentStart && (i + 2 === glob.length || glob[i + 2] === "/")) {
				if (i + 2 === glob.length) {
					source += ".*";
					i++;
				} else {
					source += "(?:.*/)?";
					i += 2;
				}
			} else {
				source += "[^/]*";
				while (glob[i + 1] === "*") i++;
			}
		} else if (char === "?") {
			source += "[^/]";
		} else if (char === "[") {
			let end = i + 1;
			if (glob[end] === "!" || glob[end] === "^") end++;
			if (glob[end] === "]") end++;
			while (end < glob.length && glob[end] !== "]") end++;
			if (end >= glob.length) {
				source += "\\[";
				continue;
			}
			let body = glob.slice(i + 1, end);
			const negated = body[0] === "!" || body[0] === "^";
			if (negated) body = body.slice(1);
			source += `(?!/)[${negated ? "^" : ""}${body.replace(/[\\[^]/g, "\\$&")}]`;
			i = end;
		} else {
			const literal = char === "\\" && i + 1 < glob.length ? glob[++i] : char;
			source += literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

/** Parse gitignore syntax: comments, `!` negation, trailing `/` for directories, `/` anchoring, `**`. */
export function parseLintIgnore(text: string): LintIgnore {
	const rules: IgnoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		let line = rawLine.replace(/\r$/, "").replace(/(?<!\\) +$/, "");
		if (line === "" || line.startsWith("#")) continue;
		const negate = line.startsWith("!");
		if (negate) line = line.slice(1);
		const dirOnly = line.endsWith("/");
		if (dirOnly) line = line.replace(/\/+$/, "");
		const anchored = line.includes("/");
		line = line.replace(/^\/+/, "");
		if (line === "") continue;
		rules.push({ regex: compileGlob(anchored ? line : `**/${line}`), negate, dirOnly });
	}
	if (rules.length === 0) return () => false;
	return (path, isDir = false) => {
		const parts = path.split("/");
		for (let depth = 1; depth <= parts.length; depth++) {
			const prefix = parts.slice(0, depth).join("/");
			const prefixIsDir = depth < parts.length || isDir;
			let ignored = false;
			for (const rule of rules) {
				if ((!rule.dirOnly || prefixIsDir) && rule.regex.test(prefix)) ignored = !rule.negate;
			}
			// As in git, nothing below an excluded directory can be re-included.
			if (ignored) return true;
		}
		return false;
	};
}

/** Load `<cwd>/.lintignore`; a missing file ignores nothing. */
export async function loadLintIgnore(cwd: string): Promise<LintIgnore> {
	try {
		return parseLintIgnore(await readFile(join(cwd, ".lintignore"), "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return () => false;
		throw error;
	}
}
