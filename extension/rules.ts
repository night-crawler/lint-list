import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Rule } from "./types";
import type { GroupSpec } from "./validator";

/** Load titled JSON rules in path order, skipping unreadable or malformed files. */
export async function loadRules(dir: string): Promise<Rule[]> {
	const entries = await readdir(dir, { recursive: true });
	const files = entries.filter((f) => f.endsWith(".json")).sort();
	const rules: Rule[] = [];
	for (const rel of files) {
		try {
			const parsed: unknown = JSON.parse(await readFile(join(dir, rel), "utf8"));
			if (parsed && typeof parsed === "object" && "title" in parsed && parsed.title) {
				const rule = parsed as Omit<Rule, "_path">;
				rules.push({ ...rule, category: rule.category || dirname(rel).split("/").pop() || "uncategorized", _path: rel });
			}
		} catch {
			continue;
		}
	}
	return rules;
}

/** Batch rules by category and source path without mutating the input. Rejects non-positive or unsafe integer sizes. */
export function planGroups(rules: readonly Rule[], groupSize: number): GroupSpec[] {
	if (!Number.isSafeInteger(groupSize) || groupSize < 1) throw new Error("groupSize must be a positive integer");
	const ordered = [...rules].sort((a, b) => a.category.localeCompare(b.category) || a._path.localeCompare(b._path));
	const groups: GroupSpec[] = [];
	const pad = String(Math.ceil(ordered.length / groupSize)).length;
	for (let i = 0; i < ordered.length; i += groupSize) {
		groups.push({ label: `group-${String(groups.length + 1).padStart(pad, "0")}`, rules: ordered.slice(i, i + groupSize) });
	}
	return groups;
}
