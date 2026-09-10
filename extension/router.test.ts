import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildGroupPrompt, extractFindings, loadRules, planGroups } from "./index";
import { buildReport } from "./report";
import {
	type ChangeUnit,
	ROUTER_VERSION,
	RouteSelector,
	type RoutingMap,
	batchUnits,
	buildRouterInput,
	heuristicRoutes,
	loadRoutingMap,
	parseUnifiedDiff,
	unitFromFile,
	unitsFromDiff,
	validateRouterResponse,
} from "./router";
import type { Rule } from "./types";

const here = import.meta.dir;
const mapPromise = loadRoutingMap(join(here, "routing-map.json"));

const SAMPLE_DIFF = `diff --git a/src/cache.rs b/src/cache.rs
index 1111111..2222222 100644
--- a/src/cache.rs
+++ b/src/cache.rs
@@ -10,7 +10,8 @@ impl Cache {
     pub async fn refresh(&self) {
-        let guard = self.inner.lock().unwrap();
+        let guard = self.inner.lock().unwrap(); // std::sync::Mutex
+        self.backend.fetch_all().await;
         guard.clear();
     }
 }
diff --git a/tests/cache_test.rs b/tests/cache_test.rs
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/tests/cache_test.rs
@@ -0,0 +1,3 @@
+#[test]
+fn refresh_clears() {}
+
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
index 4444444..0000000
--- a/docs/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Old
-Removed.
diff --git a/src/a.rs b/src/b.rs
similarity index 100%
rename from src/a.rs
rename to src/b.rs
diff --git a/assets/logo.png b/assets/logo.png
index 5555555..6666666 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

describe("routing map", () => {
	test("route vocabulary in the prompt matches the map exactly", async () => {
		const map = await mapPromise;
		const prompt = await readFile(join(here, "routing-prompt.md"), "utf8");
		const promptRoutes = [...prompt.matchAll(/^- ([a-z_]+): /gm)].map((m) => m[1]);
		const optional = Object.keys(map.routes).filter((r) => !map.always.includes(r));
		expect(promptRoutes.sort()).toEqual(optional.sort());
		expect(map.always.sort()).toEqual(["comments", "envy"]);
	});

	test("every bundled rule is reachable through some route", async () => {
		const map = await mapPromise;
		const rules = await loadRules(join(here, "..", "rules"));
		const mapped = new Set(Object.values(map.routes).flatMap((r) => r.rule_ids));
		const unmapped = rules.filter((r) => !mapped.has(Number(r.id)));
		expect(unmapped.map((r) => r._path)).toEqual([]);
	});
});

describe("diff units", () => {
	test("parses statuses, hunks, renames and binaries", () => {
		const files = parseUnifiedDiff(SAMPLE_DIFF);
		expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
			["src/cache.rs", "modified", false],
			["tests/cache_test.rs", "added", false],
			["docs/old.md", "deleted", false],
			["src/b.rs", "renamed", false],
			["assets/logo.png", "modified", true],
		]);
		expect(files[3].oldPath).toBe("src/a.rs");
		expect(files[0].body.startsWith("@@ -10,7 +10,8 @@")).toBe(true);
	});

	test("signal lines are only added/removed lines, without hunk headers", () => {
		const units = unitsFromDiff(SAMPLE_DIFF);
		expect(units[0].signalLines).toEqual([
			"        let guard = self.inner.lock().unwrap();",
			"        let guard = self.inner.lock().unwrap(); // std::sync::Mutex",
			"        self.backend.fetch_all().await;",
		]);
		expect(units.map((u) => u.id)).toEqual(["U1", "U2", "U3", "U4", "U5"]);
		expect(units[4].text).toBe("(binary file)");
	});

	test("batches pack under the budget and never drop a unit", () => {
		const units = Array.from({ length: 7 }, (_, i) => ({ ...unitsFromDiff(SAMPLE_DIFF)[0], id: `U${i + 1}`, text: "x".repeat(1000) }));
		const batches = batchUnits(units, 2600);
		expect(batches.flat().map((u) => u.id)).toEqual(units.map((u) => u.id));
		expect(batches.every((b) => b.length <= 2)).toBe(true);
		expect(batchUnits([{ ...units[0], text: "y".repeat(10_000) }], 100)).toHaveLength(1);
	});

	test("full-tree excerpt keeps the head and heuristic hits, marks truncation", () => {
		const body = [...Array.from({ length: 50 }, (_, i) => `let x${i} = ${i};`), "let guard = m.lock().unwrap();", "tail();"].join("\n");
		const unit = unitFromFile("U1", "src/x.rs", body);
		expect(unit.truncated).toBe(true);
		expect(unit.text).toContain("let x39 = 39;");
		expect(unit.text).not.toContain("let x40 = 40;");
		expect(unit.text).toContain("51: let guard = m.lock().unwrap();");
		expect(unit.signalLines).toHaveLength(52);
	});
});

describe("heuristics", () => {
	test("strong lexical signals select their routes", () => {
		const [cache, test] = unitsFromDiff(SAMPLE_DIFF);
		const cacheHits = heuristicRoutes(cache);
		expect([...cacheHits.keys()].sort()).toEqual(["async_runtime", "locks", "shared_state"]);
		expect(cacheHits.get("locks")).toEqual([".lock()"]);
		const testHits = heuristicRoutes(test);
		expect([...testHits.keys()].sort()).toEqual(["test_behavior", "test_design", "test_environment"]);
	});

	test("a pure local arithmetic change selects nothing", () => {
		const units = unitsFromDiff(`diff --git a/src/math.rs b/src/math.rs
--- a/src/math.rs
+++ b/src/math.rs
@@ -1,1 +1,1 @@
-fn f(x: u32) -> u32 { x.wrapping_mul(2) }
+fn f(x: u32) -> u32 { x.wrapping_mul(3) }
`);
		expect(heuristicRoutes(units[0]).size).toBe(0);
	});
	test("keywords in prose and data files are not operations", () => {
		const units = unitsFromDiff(`diff --git a/docs/design.md b/docs/design.md
--- a/docs/design.md
+++ b/docs/design.md
@@ -1,1 +1,2 @@
 # Design
+We hold the Mutex while we .await the kafka consumer and fsync the WAL.
diff --git a/config/app.toml b/config/app.toml
--- a/config/app.toml
+++ b/config/app.toml
@@ -1,1 +1,1 @@
-timeout = 30
+timeout = 60
`);
		expect(heuristicRoutes(units[0]).size).toBe(0);
		expect([...heuristicRoutes(units[1]).keys()].sort()).toEqual(["config_loading", "config_model"]);
	});
});

describe("router response validation", () => {
	const units: ChangeUnit[] = unitsFromDiff(SAMPLE_DIFF).slice(0, 2);
	const valid = {
		version: ROUTER_VERSION,
		units: [
			{ id: "U1", check: [{ routes: ["locks", "async_runtime"], evidence: ["U1.after"], why: "await while holding the guard" }], need: [{ routes: ["remote_calls"], evidence: ["U1.after"], fetch: ["Definition of backend.fetch_all"], why: "fetch_all may be an RPC" }] },
		],
		unrouted: [{ id: "U2", reason: "test-only" }],
	};

	test("accepts a well-formed response, also when wrapped in prose or a fence", async () => {
		const map = await mapPromise;
		const response = validateRouterResponse(`Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, units, map);
		expect(response.units[0].check[0].routes).toEqual(["locks", "async_runtime"]);
		expect(response.units[0].need[0].fetch).toEqual(["Definition of backend.fetch_all"]);
		expect(response.unrouted).toEqual([{ id: "U2", reason: "test-only" }]);
	});

	test.each([
		["version", { ...valid, version: "v0" }, /version/],
		["unknown route", { ...valid, units: [{ id: "U1", check: [{ routes: ["mutexes"], evidence: [], why: "" }], need: [] }] }, /unknown route "mutexes"/],
		["baseline route emitted", { ...valid, units: [{ id: "U1", check: [{ routes: ["envy"], evidence: [], why: "" }], need: [] }] }, /baseline route/],
		["unit missing", { ...valid, unrouted: [] }, /not covered: U2/],
		["unit duplicated", { ...valid, unrouted: [{ id: "U1", reason: "" }, { id: "U2", reason: "" }] }, /more than once/],
		["unknown unit", { ...valid, unrouted: [{ id: "U9", reason: "" }] }, /unknown unit id "U9"/],
	])("rejects %s", async (_label, payload, message) => {
		const map = await mapPromise;
		expect(() => validateRouterResponse(JSON.stringify(payload), units, map)).toThrow(message);
	});

	test("rejects non-JSON output", async () => {
		const map = await mapPromise;
		expect(() => validateRouterResponse("I could not decide.", units, map)).toThrow(/not a JSON object/);
	});

	test("tolerates a route repeated in check and need: check wins, nothing is retried", async () => {
		const map = await mapPromise;
		const response = validateRouterResponse(
			JSON.stringify({ ...valid, units: [{ id: "U1", check: [{ routes: ["locks"], evidence: [], why: "" }, { routes: ["locks", "waiting"], evidence: [], why: "" }], need: [{ routes: ["locks"], evidence: [], fetch: ["x"], why: "" }, { routes: ["locks", "retries"], evidence: [], fetch: ["y"], why: "" }] }] }),
			units,
			map,
		);
		expect(response.units[0].check.map((c) => c.routes)).toEqual([["locks"], ["locks", "waiting"]]);
		expect(response.units[0].need.map((n) => n.routes)).toEqual([["retries"]]);
	});
});

describe("route selection", () => {
	test("unions sources, dedupes rules across routes, keeps map order and unresolved context", async () => {
		const map = await mapPromise;
		const units = unitsFromDiff(SAMPLE_DIFF);
		const selector = new RouteSelector(map);
		selector.addBaseline();
		selector.addHeuristics(units[0], heuristicRoutes(units[0]));
		selector.addRouterResponse(
			{
				version: ROUTER_VERSION,
				units: [{ id: "U1", check: [{ routes: ["locks"], evidence: [], why: "guard across await" }], need: [{ routes: ["remote_calls"], evidence: [], fetch: ["backend.fetch_all definition"], why: "" }] }],
				unrouted: [],
			},
			new Map(units.map((u) => [u.id, u])),
		);
		const routes = selector.routes();
		expect(routes.map((r) => r.route)).toEqual(["envy", "comments", "locks", "shared_state", "async_runtime", "remote_calls"]);
		const locks = routes.find((r) => r.route === "locks");
		expect([...(locks?.sources ?? [])].sort()).toEqual(["heuristic", "router"]);
		expect(routes.find((r) => r.route === "remote_calls")?.unresolved).toEqual(["U1 src/cache.rs: backend.fetch_all definition"]);

		const ids = selector.ruleIds();
		expect(new Set(ids.map((r) => r.id)).size).toBe(ids.length);
		const expected = new Set(routes.flatMap((r) => map.routes[r.route].rule_ids));
		expect(ids.length).toBe(expected.size);
		// rule 421 (lock held across await) belongs to both locks and async_runtime batches
		expect(ids.find((r) => r.id === 421)?.routes).toEqual(["locks", "async_runtime"]);
	});

	test("router input cites heuristics as facts and includes every unit once", async () => {
		const units = unitsFromDiff(SAMPLE_DIFF).slice(0, 2);
		const heuristics = new Map(units.map((u) => [u.id, heuristicRoutes(u)]));
		const input = buildRouterInput(units, heuristics, { scopeDescription: "diff vs main", deletedFiles: ["docs/old.md"], manifestComplete: true });
		const json = JSON.parse(input.slice(input.indexOf("```json") + 7, input.lastIndexOf("```")));
		expect(json.units.map((u: { id: string }) => u.id)).toEqual(["U1", "U2"]);
		expect(json.units[0].diff.ref).toBe("U1.after");
		expect(json.facts.some((f: { text: string }) => f.text.includes("Deleted files") && f.text.includes("docs/old.md"))).toBe(true);
		expect(json.facts.some((f: { units: string[]; text: string }) => f.units[0] === "U1" && f.text.includes("locks"))).toBe(true);
	});
});

describe("group planning and report", () => {
	const fakeRules = (ids: number[]): Rule[] => ids.map((id) => ({ id, title: `Rule ${id}`, category: "Cat", _path: `${id}.json` }));

	test("groups follow route order, keep each rule once, and append unmapped rules", async () => {
		const map = await mapPromise;
		const selector = new RouteSelector(map);
		selector.addBaseline();
		selector.add("locks", "router", "U1 x.rs: guard");
		const mappedIds = [...map.routes.envy.rule_ids, ...map.routes.comments.rule_ids, ...map.routes.locks.rule_ids];
		const rules = fakeRules([...new Set([...mappedIds, 5001, 5002])]);
		const groups = planGroups(rules, selector, map, 30);
		const all = groups.flatMap((g) => g.rules.map((r) => Number(r.id)));
		expect(new Set(all).size).toBe(all.length);
		expect(all.slice(0, map.routes.envy.rule_ids.length)).toEqual(map.routes.envy.rule_ids);
		expect(all.slice(-2)).toEqual([5001, 5002]);
		expect(groups[0].routes.map((r) => r.route)).toEqual(["envy", "comments"]);
		expect(groups.at(-1)?.routes.map((r) => r.route)).toContain("unmapped");
		expect(selector.routes().at(-1)?.ruleCount).toBe(2);
		expect(selector.routes().find((r) => r.route === "envy")?.ruleCount).toBe(map.routes.envy.rule_ids.length);
		// a rule shared by two selected routes counts for both
		expect(selector.routes().find((r) => r.route === "locks")?.ruleCount).toBe(map.routes.locks.rule_ids.length);
	});

	test("group prompt carries focus hints and diff scope", async () => {
		const map = await mapPromise;
		const selector = new RouteSelector(map);
		selector.add("locks", "router", "U1 src/cache.rs: guard held across await");
		const prompt = buildGroupPrompt(
			{ label: "group-1", rules: fakeRules([421]), routes: selector.routes() },
			{ kind: "diff", base: "main", files: ["src/cache.rs"], deletedFiles: ["docs/old.md"], diffText: SAMPLE_DIFF, embedDiff: true },
		);
		expect(prompt).toContain("- locks: U1 src/cache.rs: guard held across await");
		expect(prompt).toContain("Deleted files (no longer present): docs/old.md");
		expect(prompt).toContain("### Rule 421 [Cat]: Rule 421");
		expect(prompt).toContain('"severity":"high|medium|low"');
	});

	test("findings parse severity and tolerate prose around the JSON", () => {
		const findings = extractFindings('Done.\n{"findings":[{"rule_id":421,"file":"src/cache.rs","lines":"11-13","severity":"high","evidence":"guard","suggestion":"drop before await"},{"rule_id":1,"file":"x","suggestion":"y","severity":"urgent"}]}');
		expect(findings?.map((f) => f.severity)).toEqual(["high", undefined]);
		expect(extractFindings("no json here")).toBeUndefined();
	});

	test("report orders by severity within files, lists failed groups and routing", async () => {
		const map = await mapPromise;
		const selector = new RouteSelector(map);
		selector.addBaseline();
		selector.add("locks", "heuristic", "U1 src/cache.rs: matched .lock()");
		const report = buildReport({
			generatedAt: new Date("2026-01-01T00:00:00Z"),
			scope: { kind: "diff", base: "main", files: ["src/cache.rs"], deletedFiles: [], diffText: "", embedDiff: false },
			model: "eval-model",
			routerMode: "auto",
			routerModel: "router-model",
			rulesTotal: 1002,
			routes: selector.routes(),
			routerNotes: ["router-1: U2 left unrouted — test-only."],
			groups: [
				{ group: "group-1", ruleIds: [421, 1], routes: ["envy", "locks"], clean: false, findings: [
					{ rule_id: 1, file: "src/cache.rs", lines: "3", severity: "low", suggestion: "rename" },
					{ rule_id: 421, file: "src/cache.rs", lines: "11-13", severity: "high", evidence: "guard across await", suggestion: "drop the guard before awaiting" },
				] },
				{ group: "group-2", ruleIds: [2], routes: ["envy"], clean: false, findings: [], error: "timed out after 600s" },
			],
			rulesById: new Map([["421", { id: 421, title: "Lock Held Across Await", category: "Concurrency Hazards", why_bad: "Blocks the executor thread.", _path: "" }]]),
			runDir: "/tmp/run",
		});
		expect(report.indexOf("[HIGH] Rule 421 — Lock Held Across Await")).toBeLessThan(report.indexOf("[LOW] Rule 1"));
		expect(report).toContain("**2 findings** (1 high · 0 medium · 1 low) across 1 file");
		expect(report).toContain("Rules evaluated: 3 of 1002 (3 routes selected) in 2 groups; **1 group failed**");
		expect(report).toContain("## Incomplete coverage");
		expect(report).toContain("| `locks` | 23 | heuristic | U1 src/cache.rs: matched .lock() |");
		expect(report).toContain("router-1: U2 left unrouted");
		expect(report).toContain("**Why it matters:** Blocks the executor thread.");
	});
});
