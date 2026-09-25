import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFindings, planGroups } from "./index";
import { parsePrediction } from "./predictor";
import { buildReport } from "./report";
import type { GitExec } from "./scope";
import { resolveDiffScope, resolveFullScope } from "./scope";
import type { Rule } from "./types";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const exec: GitExec = async (command, args, options) => {
	const process = Bun.spawn([command, ...args], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
	return { stdout, code };
};

async function repository(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lint-audit-test-"));
	temporaryDirectories.push(dir);
	for (const args of [
		["init", "-q", "-b", "main"],
		["config", "user.name", "Lint Test"],
		["config", "user.email", "lint@example.invalid"],
	]) {
		const result = await exec("git", args, { cwd: dir });
		if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
	}
	return dir;
}

const rules: Rule[] = [
	{ id: 1, title: "First", category: "B", _path: "b/1.json" },
	{ id: 2, title: "Second", category: "A", _path: "a/2.json" },
	{ id: 3, title: "Third", category: "A", _path: "a/3.json" },
];

describe("snapshot boundaries", () => {
	test("captures staged, unstaged, renamed and deleted tracked files in one diff without losing unusual paths", async () => {
		const dir = await repository();
		await writeFile(join(dir, "old.rs"), "fn old() {}\n");
		await writeFile(join(dir, "changed.rs"), "fn before() {}\n");
		await writeFile(join(dir, "deleted.rs"), "fn gone() {}\n");
		await exec("git", ["add", "."], { cwd: dir });
		await exec("git", ["commit", "-qm", "base"], { cwd: dir });
		const renamed = 'renamed\t"file".rs';
		await exec("git", ["mv", "old.rs", renamed], { cwd: dir });
		await unlink(join(dir, "deleted.rs"));
		await writeFile(join(dir, "changed.rs"), "fn staged() {}\n");
		await exec("git", ["add", "changed.rs"], { cwd: dir });
		await writeFile(join(dir, "changed.rs"), "fn staged() {}\nfn unstaged() {}\n");
		await writeFile(join(dir, "new file.rs"), "fn untracked() {}");
		await writeFile(join(dir, "empty.rs"), "");
		await writeFile(join(dir, "binary.dat"), "a\0b");
		let diffCalls = 0;
		const scope = await resolveDiffScope(
			async (command, args, options) => {
				if (args[0] === "diff") diffCalls++;
				return exec(command, args, options);
			},
			dir,
			"main",
		);
		expect(diffCalls).toBe(1);
		expect(scope?.kind).toBe("diff");
		if (scope?.kind !== "diff") throw new Error("Expected diff scope");
		expect(scope.files.sort()).toEqual(["changed.rs", renamed].sort());
		expect(scope.deletedFiles).toEqual(["deleted.rs"]);
		expect(scope.diffText).toContain("+fn staged() {}");
		expect(scope.diffText).toContain("+fn unstaged() {}");
		expect(scope.diffText).toContain("-fn gone() {}");
		expect(scope.diffText).not.toContain("untracked");
		expect(scope.diffText).not.toContain("binary.dat");
		await writeFile(join(dir, "changed.rs"), "fn changed_after_snapshot() {}\n");
		expect(scope.diffText).not.toContain("changed_after_snapshot");
		const full = await resolveFullScope(exec, dir);
		expect(full.files).not.toContain("deleted.rs");
		expect(full.diffText).toContain("+fn changed_after_snapshot() {}");
		expect(full.diffText).toContain("+fn untracked() {}\n\\ No newline at end of file\n");
		expect(full.files).toContain("empty.rs");
	});

	test("uses the local base tip rather than a remote merge-base and matches git diff main", async () => {
		const dir = await repository();
		await writeFile(join(dir, "shared.rs"), "fn original() {}\n");
		await exec("git", ["add", "."], { cwd: dir });
		await exec("git", ["commit", "-qm", "common"], { cwd: dir });
		await exec("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
		await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: dir });
		await exec("git", ["branch", "feature"], { cwd: dir });
		await writeFile(join(dir, "main-only.rs"), "fn added_on_main() {}\n");
		await exec("git", ["add", "."], { cwd: dir });
		await exec("git", ["commit", "-qm", "advance main"], { cwd: dir });
		await exec("git", ["checkout", "-q", "feature"], { cwd: dir });
		await writeFile(join(dir, "shared.rs"), "fn feature_change() {}\n");
		await writeFile(join(dir, "untracked.rs"), "fn excluded() {}\n");

		const scope = await resolveDiffScope(exec, dir, "");
		if (scope?.kind !== "diff") throw new Error("Expected diff scope");
		const expected = await exec("git", ["diff", "--no-color", "main", "--"], { cwd: dir });
		expect(scope.base).toBe("main");
		expect(scope.diffText).toBe(expected.stdout);
		expect(scope.deletedFiles).toEqual(["main-only.rs"]);
		expect(scope.files).toEqual(["shared.rs"]);
	});
});

describe("prediction and validation boundaries", () => {
	test("accepts one structured boolean verdict, not prose, coercions or contradictory fields", () => {
		expect(parsePrediction(' \n{ "violates": true }\n')).toBe("a");
		expect(parsePrediction('{"violates":false}')).toBe("b");
		for (const text of [
			"a",
			'A violation seems likely, so {"violates":true}',
			'{"violates":"false"}',
			'{"violates":true,"violates":false}',
			'{"violates":false,"confidence":1}',
			"{}",
			'{"violates":true',
		]) {
			expect(() => parsePrediction(text)).toThrow();
		}
	});

	test("candidate grouping has bounded batches and keeps each supplied rule once", () => {
		const groups = planGroups(rules, 2);
		expect(groups.map((group) => group.rules.map((rule) => rule.id))).toEqual([[2, 3], [1]]);
		expect(planGroups([], 2)).toEqual([]);
	});

	test("normalizes structured findings and unrecognized severities", () => {
		const findings = extractFindings({
			findings: [
				{ rule_id: 421, file: "src/cache.rs", lines: "11-13", severity: "high", evidence: "guard", suggestion: "drop before await" },
				{ rule_id: 1, file: "x", suggestion: "y", severity: "urgent" },
			],
		});
		expect(findings?.map((finding) => finding.severity)).toEqual(["high", undefined]);
		expect(extractFindings('{"findings":[]}')).toBeUndefined();
	});

	test("malformed findings are failures, never silently clean", () => {
		expect(extractFindings({ findings: [{ rule_id: 1, file: "x.rs" }] })).toBeUndefined();
		expect(extractFindings({ findings: [] })).toEqual([]);
	});

	test("confirmed findings stay severity-ordered within files", () => {
		const report = buildReport({
			generatedAt: new Date("2026-01-01T00:00:00Z"),
			scope: { kind: "diff", base: "main", baseCommit: "0123456789abcdef", files: ["src/cache.rs"], deletedFiles: [], diffText: "" },
			predictorModel: "predictor",
			validatorModel: "validator",
			rulesTotal: 3,
			predictions: [
				{ ruleId: 1, answer: "a" },
				{ ruleId: 2, answer: "a" },
				{ ruleId: 3, answer: "b" },
			],
			groups: [
				{
					group: "group-1",
					ruleIds: [1, 2],
					clean: false,
					findings: [
						{ rule_id: 1, file: "src/cache.rs", lines: "3", severity: "low", suggestion: "rename" },
						{
							rule_id: 2,
							file: "src/cache.rs",
							lines: "11-13",
							severity: "high",
							evidence: "guard across await",
							suggestion: "drop guard",
						},
					],
				},
			],
			rulesById: new Map(rules.map((rule) => [String(rule.id), rule])),
			runDir: "/tmp/run",
		});
		const ids = [...report.matchAll(/^#### .*Rule (\d+)/gm)].map((match) => Number(match[1]));
		expect(ids).toEqual([2, 1]);
	});
});
