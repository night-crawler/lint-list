/**
 * lint-audit — omp extension.
 *
 * /lint-audit [router=auto|heuristic|all] [router_model=@smol] [model=<spec|@role>] [group=24] [c=4]
 *             [scope=auto|diff|full] [base=<ref>] [dir=<rules dir>] [out=<report path>] [fix=false]
 *
 * Flow:
 *  1. Resolve the scope. Default `auto`: PR diff (merge-base of HEAD and the base branch, diffed
 *     against the working tree) when detectable, else the full tree. `diff` fails instead of
 *     falling back; `full` forces a whole-tree audit.
 *  2. Route. The scope is split into change units (one per file). Baseline routes are always
 *     scheduled; host heuristics add routes from strong lexical/path signals; a cheap router model
 *     judges semantic applicability per unit (routing-prompt.md) and adds the rest. Routes only
 *     ever accumulate. A router failure falls back to every route for that batch, never to none.
 *  3. Evaluate. Selected routes expand to rule ids (routing-map.json); rules are ordered by route,
 *     partitioned into groups, and each group is reviewed by a read-only sub-session that gets the
 *     routing evidence as focus hints.
 *  4. Report. A markdown report (findings by file, routing table, coverage) is written to the run
 *     dir, echoed into the chat, and nothing is changed in the code.
 *  5. fix=true additionally hands the findings to the main session to apply.
 *
 * Defaults can also be set in `<cwd>/.omp/lint-audit.json` or `<pkg>/lint-audit.json` (command args win).
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildFixMessage, buildReport, describeScope } from "./report";
import {
	type ChangeUnit,
	type RouteSelection,
	type RouterResponse,
	RouteSelector,
	type RoutingMap,
	batchUnits,
	buildRouterInput,
	extractJsonObject,
	heuristicRoutes,
	loadRoutingMap,
	unitFromFile,
	unitsFromDiff,
	validateRouterResponse,
} from "./router";
import type { AuditScope, Finding, GroupResult, Rule, Severity } from "./types";

type RouterMode = "auto" | "heuristic" | "all";

interface AuditConfig {
	groupSize: number;
	concurrency: number;
	model: string;
	routerModel: string;
	router: RouterMode;
	fix: boolean;
	rulesDir: string;
	evalTimeoutSec: number;
	routerTimeoutSec: number;
	scope: "auto" | "diff" | "full";
	base: string;
	out: string;
}

/** Minimal structural view of the untyped `pi.pi` SDK export bag. */
interface SdkMessageBlock {
	type: string;
	text?: string;
}
interface SdkSessionEvent {
	type: string;
	message?: { role?: string; content?: SdkMessageBlock[] };
	toolName?: string;
	intent?: string;
}
interface SdkSession {
	subscribe(listener: (event: SdkSessionEvent) => void): () => void;
	prompt(text: string): Promise<unknown>;
	abort(): unknown;
	dispose(): Promise<void>;
}
interface SdkExports {
	createAgentSession(options: Record<string, unknown>): Promise<{ session: SdkSession }>;
	SessionManager: { inMemory(): unknown };
	AgentRegistry?: new () => unknown;
}

const DEFAULTS: AuditConfig = {
	groupSize: 24,
	concurrency: 4,
	model: "",
	routerModel: "@smol",
	router: "auto",
	fix: false,
	rulesDir: "",
	evalTimeoutSec: 600,
	routerTimeoutSec: 300,
	scope: "auto",
	base: "",
	out: "",
};

/** Above this, the diff is not embedded per group; auditors get the file list and read on demand. */
const MAX_EMBEDDED_DIFF_CHARS = 48_000;
/** Full-tree scope: files above this size are listed but not excerpted for the router. */
const MAX_FULL_SCOPE_FILE_BYTES = 512 * 1024;
const SKIPPED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "out", "vendor", "third_party", ".omp", ".idea", ".vscode", "__pycache__", ".venv", "venv", ".next", ".turbo", "coverage"]);
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|class|o|a|so|dll|dylib|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|lockb|sqlite|db|parquet)$/i;

/** Partition into consecutive chunks of `size`; the last chunk may be smaller. */
export function partition<T>(items: readonly T[], size: number): T[][] {
	const step = Math.max(1, Math.floor(size));
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += step) chunks.push(items.slice(i, i + step));
	return chunks;
}

export async function loadRules(dir: string): Promise<Rule[]> {
	const entries = await readdir(dir, { recursive: true });
	const files = entries.filter((f) => f.endsWith(".json")).sort();
	const rules: Rule[] = [];
	for (const rel of files) {
		try {
			const parsed: unknown = JSON.parse(await readFile(join(dir, rel), "utf8"));
			if (parsed && typeof parsed === "object" && "title" in parsed && parsed.title) {
				// Trusted local rule file; shape re-validated field-by-field at prompt build.
				const rule = parsed as Omit<Rule, "_path">;
				rules.push({ ...rule, category: rule.category || dirname(rel).split("/").pop() || "uncategorized", _path: rel });
			}
		} catch {
			// malformed rule file: skip, never abort the audit
		}
	}
	return rules;
}

export interface GroupSpec {
	label: string;
	rules: Rule[];
	/** Selected routes whose rules are in this group, in route order. */
	routes: RouteSelection[];
}

export function buildGroupPrompt(group: GroupSpec, scope: AuditScope): string {
	const sections = group.rules.map((r) => {
		const parts = [`### Rule ${r.id} [${r.category}]: ${r.title}`];
		if (r.pattern) parts.push(`Pattern: ${r.pattern}`);
		if (r.detection) parts.push(`Detection: ${r.detection}`);
		if (r.why_bad) parts.push(`Why bad: ${r.why_bad}`);
		if (r.counterexample) parts.push(`Counterexample (do NOT flag): ${r.counterexample}`);
		if (r.fix) parts.push(`Fix approach: ${r.fix}`);
		return parts.join("\n");
	});
	const scopeLines =
		scope.kind === "full"
			? [
					`You are a code-smell auditor. Audit the source code of the current working directory against every rule below (audit batch ${group.label}).`,
					`Use read/grep/glob to inspect the actual code. Skip vendored/generated/third-party code and the .omp directory.`,
				]
			: [
					`You are a code-smell auditor. Audit ONLY the current branch's changes against ${scope.base} (the PR diff) using every rule below (audit batch ${group.label}).`,
					`Changed files:`,
					...scope.files.map((f) => `- ${f}`),
					...(scope.deletedFiles.length ? [`Deleted files (no longer present): ${scope.deletedFiles.join(", ")}`] : []),
					`Only report violations introduced or touched by these changes: the violating code must be in a changed file and involve changed lines or code directly connected to them. Pre-existing violations in untouched code are out of scope.`,
					`Use read/grep/glob for surrounding context where needed.`,
					...(scope.embedDiff ? [``, `## Diff vs ${scope.base}`, "```diff", scope.diffText, "```"] : []),
				];
	const focus = group.routes.flatMap((r) => r.evidence.map((e) => `- ${r.route}: ${e}`));
	return [
		...scopeLines,
		`Only report a violation you can evidence with a specific file and location, and only when it clearly matches the rule's detection criteria (respect the counterexamples). When in doubt, do not report.`,
		``,
		`## Why these rules were selected`,
		`A routing pass judged the rules' subjects to be touched by the change. Start from the cited locations, but check each rule against the whole scope; selection is applicability, not a predicted violation.`,
		...focus,
		``,
		`## Rules`,
		sections.join("\n\n"),
		``,
		`## Output`,
		`Your FINAL message must be ONLY a JSON object, no prose, no code fence:`,
		`{"findings":[{"rule_id":<id>,"file":"<relative path>","lines":"<N-M>","severity":"high|medium|low","evidence":"<what you saw>","suggestion":"<concrete change to make>"}]}`,
		`severity: high = correctness/safety/security impact; medium = maintainability or performance smell; low = cosmetic/consistency.`,
		`If none of the rules are violated, output exactly {"findings":[]}.`,
	].join("\n");
}

function coerceFinding(value: unknown): Finding | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>; // narrowed to object above; fields re-checked below
	const file = typeof record.file === "string" ? record.file : "";
	const suggestion = typeof record.suggestion === "string" ? record.suggestion : "";
	if (!file || !suggestion) return undefined;
	const severity = record.severity === "high" || record.severity === "medium" || record.severity === "low" ? (record.severity as Severity) : undefined;
	return {
		rule_id: typeof record.rule_id === "number" || typeof record.rule_id === "string" ? record.rule_id : "?",
		file,
		suggestion,
		severity,
		lines: record.lines === undefined ? undefined : String(record.lines),
		evidence: record.evidence === undefined ? undefined : String(record.evidence),
	};
}

export function extractFindings(text: string): Finding[] | undefined {
	const parsed = extractJsonObject(text);
	if (parsed && typeof parsed === "object" && "findings" in parsed && Array.isArray(parsed.findings)) {
		return parsed.findings.map(coerceFinding).filter((f): f is Finding => f !== undefined);
	}
	return undefined;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

const isRouterMode = (value: unknown): value is RouterMode => value === "auto" || value === "heuristic" || value === "all";
const isScopeMode = (value: unknown): value is AuditConfig["scope"] => value === "auto" || value === "diff" || value === "full";
const parseBool = (value: string): boolean => value !== "false" && value !== "0" && value !== "no";

function parseArgs(args: string): Partial<AuditConfig> {
	const out: Partial<AuditConfig> = {};
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		const eq = token.indexOf("=");
		if (eq === -1) continue;
		const key = token.slice(0, eq).toLowerCase().replace(/[-_]/g, "");
		const value = token.slice(eq + 1);
		if (key === "group" || key === "groupsize" || key === "n") out.groupSize = Number(value) || DEFAULTS.groupSize;
		else if (key === "c" || key === "concurrency") out.concurrency = Number(value) || DEFAULTS.concurrency;
		else if (key === "model") out.model = value;
		else if (key === "routermodel") out.routerModel = value;
		else if (key === "router" && isRouterMode(value)) out.router = value;
		else if (key === "fix") out.fix = parseBool(value);
		else if (key === "dir") out.rulesDir = value;
		else if (key === "timeout") out.evalTimeoutSec = Number(value) || DEFAULTS.evalTimeoutSec;
		else if (key === "routertimeout") out.routerTimeoutSec = Number(value) || DEFAULTS.routerTimeoutSec;
		else if (key === "scope" && isScopeMode(value)) out.scope = value;
		else if (key === "base") out.base = value;
		else if (key === "out") out.out = value;
	}
	return out;
}

async function readConfigFile(path: string): Promise<Partial<AuditConfig>> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		const record = parsed as Record<string, unknown>; // narrowed to object; fields checked below
		const out: Partial<AuditConfig> = {};
		if (typeof record.groupSize === "number") out.groupSize = record.groupSize;
		if (typeof record.concurrency === "number") out.concurrency = record.concurrency;
		if (typeof record.model === "string") out.model = record.model;
		if (typeof record.routerModel === "string") out.routerModel = record.routerModel;
		if (isRouterMode(record.router)) out.router = record.router;
		if (typeof record.fix === "boolean") out.fix = record.fix;
		if (typeof record.rulesDir === "string") out.rulesDir = record.rulesDir;
		if (typeof record.evalTimeoutSec === "number") out.evalTimeoutSec = record.evalTimeoutSec;
		if (typeof record.routerTimeoutSec === "number") out.routerTimeoutSec = record.routerTimeoutSec;
		if (isScopeMode(record.scope)) out.scope = record.scope;
		if (typeof record.base === "string") out.base = record.base;
		if (typeof record.out === "string") out.out = record.out;
		return out;
	} catch {
		return {};
	}
}

/** Resolve a path relative to the extension, following a symlinked install to the real package dir. */
function packagePath(...segments: string[]): string {
	let real = import.meta.dir;
	try {
		real = realpathSync(import.meta.dir);
	} catch {}
	return [join(import.meta.dir, ...segments), join(real, ...segments)].find((c) => existsSync(c)) ?? join(real, ...segments);
}

export function resolveRulesDir(configured: string, cwd: string): string | undefined {
	if (configured) return [configured, join(cwd, configured)].find((c) => existsSync(c));
	// import.meta.dir keeps a symlinked install path, and join() collapses ".."
	// lexically — check the realpath too so "<repo>/rules" is found when the
	// extension is symlinked into an .omp/extensions directory.
	return [packagePath("rules"), packagePath("..", "rules")].find((c) => existsSync(c));
}

type GitExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; code: number }>;

/**
 * Resolve the PR-diff scope: merge-base of HEAD and a base ref, diffed against the working tree
 * (uncommitted changes included). Returns undefined when cwd is not a git repo, no base ref
 * resolves, or the diff is empty.
 */
async function resolveDiffScope(exec: GitExec, cwd: string, baseArg: string): Promise<AuditScope | undefined> {
	const git = async (...args: string[]) => {
		const result = await exec("git", args, { cwd, timeout: 15_000 });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};
	if ((await git("rev-parse", "--is-inside-work-tree")) !== "true") return undefined;

	const originHead = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
	const candidates = baseArg ? [baseArg] : [originHead, "origin/main", "origin/master", "main", "master"];
	let base: string | undefined;
	for (const candidate of candidates) {
		if (candidate && (await git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`)) !== undefined) {
			base = candidate;
			break;
		}
	}
	if (!base) return undefined;

	const mergeBase = await git("merge-base", base, "HEAD");
	if (!mergeBase) return undefined;

	// Diff merge-base against the working tree: committed + staged + unstaged PR work.
	const nameStatus = await git("diff", "--name-status", "-M", mergeBase);
	const files: string[] = [];
	const deletedFiles: string[] = [];
	for (const line of (nameStatus ?? "").split("\n").filter(Boolean)) {
		const [status, ...paths] = line.split("\t");
		if (status.startsWith("D")) deletedFiles.push(paths[0]);
		else files.push(paths[paths.length - 1]);
	}

	// Untracked files are PR work too, but `git diff` never shows them. Synthesize an
	// added-file diff for each text file so units, embedding, and evaluators see them uniformly.
	let diffText = (await git("diff", "--unified=3", "-M", mergeBase)) ?? "";
	const untracked = ((await git("ls-files", "-z", "--others", "--exclude-standard")) ?? "").split("\0").filter(Boolean);
	for (const file of untracked) {
		if (BINARY_EXTENSIONS.test(file) || file.split("/").some((seg) => SKIPPED_DIRS.has(seg))) continue;
		const abs = join(cwd, file);
		try {
			if ((await stat(abs)).size > MAX_FULL_SCOPE_FILE_BYTES) continue;
			const lines = (await readFile(abs, "utf8")).split("\n");
			if (lines.at(-1) === "") lines.pop();
			files.push(file);
			diffText += `${diffText && !diffText.endsWith("\n") ? "\n" : ""}diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
		} catch {
			// unreadable: leave it out of the scope
		}
	}
	if (files.length === 0 && deletedFiles.length === 0) return undefined;
	return { kind: "diff", base, files, deletedFiles, diffText, embedDiff: diffText.length > 0 && diffText.length <= MAX_EMBEDDED_DIFF_CHARS };
}

/** Text files of the working tree (git-tracked when available), excluding build/vendor/VCS dirs. */
async function listTreeFiles(exec: GitExec, cwd: string): Promise<string[]> {
	const tracked = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, timeout: 15_000 });
	const files: string[] = [];
	if (tracked.code === 0) {
		files.push(...tracked.stdout.split("\0").filter(Boolean));
	} else {
		const walk = async (dir: string) => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					if (!SKIPPED_DIRS.has(entry.name)) await walk(join(dir, entry.name));
				} else if (entry.isFile()) files.push(relative(cwd, join(dir, entry.name)));
			}
		};
		await walk(cwd);
	}
	return files.filter((f) => !BINARY_EXTENSIONS.test(f) && !f.split("/").some((seg) => SKIPPED_DIRS.has(seg))).sort();
}

interface OpenSessionOptions {
	sdk: SdkExports;
	model: unknown;
	modelRegistry: unknown;
	cwd: string;
	tools: string[];
	systemPrompt?: string;
	timeoutSec: number;
	onActivity: (action: string) => void;
}

interface SubSession {
	/** Send one prompt; resolves to the final assistant text, watchdog-bounded. */
	ask(prompt: string): Promise<string>;
	dispose(): Promise<void>;
}

/** A headless, tool-restricted sub-session on a private in-memory session manager. */
async function openSession(options: OpenSessionOptions): Promise<SubSession> {
	const { createAgentSession, SessionManager, AgentRegistry } = options.sdk;
	const registry = options.modelRegistry as { authStorage?: unknown };
	const { session } = await createAgentSession({
		model: options.model,
		modelRegistry: options.modelRegistry,
		// modelRegistry.authStorage must be the same instance passed as authStorage.
		authStorage: registry.authStorage,
		sessionManager: SessionManager.inMemory(),
		// Private registry: the process-global one admits a single "Main" identity.
		...(AgentRegistry ? { agentRegistry: new AgentRegistry() } : {}),
		...(options.systemPrompt ? { systemPrompt: [options.systemPrompt] } : {}),
		toolNames: options.tools,
		restrictToolNames: true, // also disables ambient MCP/extensions/LSP
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		cwd: options.cwd,
	});
	let lastAssistantText = "";
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName) {
			options.onActivity(`${event.toolName}${event.intent ? ` — ${event.intent}` : ""}`);
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = (event.message.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");
			if (text.trim()) lastAssistantText = text;
		}
	});
	return {
		async ask(prompt: string): Promise<string> {
			lastAssistantText = "";
			const watchdog = Promise.withResolvers<never>();
			const timer = setTimeout(() => {
				try {
					session.abort();
				} catch {}
				watchdog.reject(new Error(`timed out after ${options.timeoutSec}s`));
			}, options.timeoutSec * 1000);
			if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
				timer.unref(); // never keep the process alive for the watchdog
			}
			try {
				await Promise.race([session.prompt(prompt), watchdog.promise]);
			} finally {
				clearTimeout(timer);
			}
			return lastAssistantText;
		},
		async dispose() {
			unsubscribe();
			try {
				await session.dispose();
			} catch {}
		},
	};
}

/** Rules ordered by selected route, each once; rules absent from the map are appended as always-on. */
export function planGroups(rules: Rule[], selector: RouteSelector, map: RoutingMap, groupSize: number): GroupSpec[] {
	const rulesById = new Map(rules.map((r) => [String(r.id), r]));
	const mapped = new Set(Object.values(map.routes).flatMap((r) => r.rule_ids.map(String)));
	const unmapped = rules.filter((r) => !mapped.has(String(r.id)));
	selector.addUnmapped(unmapped.length);

	const selectedRoutes = selector.routes();
	const ordered: { rule: Rule; routes: string[] }[] = [];
	for (const { id, routes } of selector.ruleIds()) {
		const rule = rulesById.get(String(id));
		if (rule) ordered.push({ rule, routes });
	}
	for (const rule of unmapped) ordered.push({ rule, routes: ["unmapped"] });
	// The map's membership size is meaningless with a curated rules dir; report what is actually evaluated.
	for (const selection of selectedRoutes) selection.ruleCount = ordered.filter((e) => e.routes.includes(selection.route)).length;

	const groups = partition(ordered, groupSize);
	const pad = String(groups.length).length;
	return groups.map((entries, index) => {
		const routeNames = new Set(entries.flatMap((e) => e.routes));
		return {
			label: `group-${String(index + 1).padStart(pad, "0")}`,
			rules: entries.map((e) => e.rule),
			routes: selectedRoutes.filter((r) => routeNames.has(r.route)),
		};
	}).filter((g) => g.rules.length > 0);
}

export default function lintAudit(pi: ExtensionAPI) {
	pi.setLabel("Lint Audit");

	pi.registerCommand("lint-audit", {
		description: "Route the change set to applicable rule batches, evaluate them in parallel, report (fix=true to apply)",
		handler: async (args, ctx) => {
			// pi.pi is the untyped package-export bag; structural cast at this boundary only.
			const sdk = pi.pi as unknown as Partial<SdkExports>;
			if (!sdk.createAgentSession || !sdk.SessionManager) {
				ctx.ui.notify("lint-audit: SDK exports unavailable (createAgentSession/SessionManager)", "error");
				return;
			}
			const fullSdk = sdk as SdkExports;

			const cfg: AuditConfig = {
				...DEFAULTS,
				...(await readConfigFile(packagePath("lint-audit.json"))),
				...(await readConfigFile(join(ctx.cwd, ".omp", "lint-audit.json"))),
				...parseArgs(args),
			};

			const rulesDir = resolveRulesDir(cfg.rulesDir, ctx.cwd);
			if (!rulesDir) {
				ctx.ui.notify("lint-audit: rules directory not found (dir=... or bundle rules/ next to the extension)", "error");
				return;
			}
			const allRules = await loadRules(rulesDir);
			if (allRules.length === 0) {
				ctx.ui.notify(`lint-audit: no valid rule JSON files in ${rulesDir}`, "error");
				return;
			}
			const rulesById = new Map(allRules.map((r) => [String(r.id), r]));

			let map: RoutingMap;
			try {
				map = await loadRoutingMap(packagePath("routing-map.json"));
			} catch (error) {
				ctx.ui.notify(`lint-audit: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const model = cfg.model ? ctx.models.resolve(cfg.model) : ctx.models.current();
			if (!model) {
				ctx.ui.notify(`lint-audit: cannot resolve model "${cfg.model || "<current>"}"`, "error");
				return;
			}
			let routerModel = model;
			if (cfg.router === "auto") {
				const resolved = cfg.routerModel ? ctx.models.resolve(cfg.routerModel) : undefined;
				if (resolved) routerModel = resolved;
				else if (cfg.routerModel) ctx.ui.notify(`lint-audit: router model "${cfg.routerModel}" not resolvable; routing with ${model.id}`, "warning");
			}

			const exec = pi.exec.bind(pi);
			let scope: AuditScope | undefined;
			if (cfg.scope !== "full") {
				scope = await resolveDiffScope(exec, ctx.cwd, cfg.base);
				if (!scope && cfg.scope === "diff") {
					ctx.ui.notify("lint-audit: scope=diff but no PR diff found (not a git repo, no base ref, or no changes vs base)", "error");
					return;
				}
				if (!scope) ctx.ui.notify("lint-audit: no PR diff detected; falling back to a full-tree audit", "warning");
			}
			if (!scope) scope = { kind: "full", files: await listTreeFiles(exec, ctx.cwd) };

			const runId = new Date().toISOString().replace(/[:.]/g, "-");
			const runDir = join(ctx.cwd, ".omp", "lint-audit", runId);
			await mkdir(runDir, { recursive: true });
			const reportPath = cfg.out ? (cfg.out.startsWith("/") ? cfg.out : join(ctx.cwd, cfg.out)) : join(runDir, "report.md");

			// Live progress: one line per in-flight sub-session (widget capped at 10 lines),
			// plus a compact status-bar line. All of it is a no-op without a UI.
			const activity = new Map<string, string>();
			let phase = "routing";
			let done = 0;
			let total = 0;
			let findingsSoFar = 0;
			const renderProgress = () => {
				const summary = `lint-audit ${phase} ${done}/${total}${phase === "evaluating" ? ` groups | ${findingsSoFar} findings` : " batches"} | c=${cfg.concurrency}`;
				const running = [...activity.entries()].map(([label, action]) => `  ▶ ${label}: ${action}`);
				ctx.ui.setStatus("lint-audit", summary);
				ctx.ui.setWorkingMessage(summary);
				ctx.ui.setWidget("lint-audit", [summary, ...running.slice(0, 9)], { placement: "belowEditor" });
			};
			const clearProgress = () => {
				ctx.ui.setStatus("lint-audit", undefined);
				ctx.ui.setWidget("lint-audit", undefined);
				ctx.ui.setWorkingMessage();
			};

			// ---- Stage 1: routing -------------------------------------------------------------
			const selector = new RouteSelector(map);
			selector.addBaseline();
			const routerNotes: string[] = [];
			const scopeDesc = describeScope(scope).replace(/`/g, "");

			if (cfg.router === "all") {
				selector.addAll("fallback", "router=all: every rule evaluated");
			} else {
				let units: ChangeUnit[];
				if (scope.kind === "diff") {
					units = unitsFromDiff(scope.diffText);
				} else {
					units = [];
					for (const file of scope.files) {
						const abs = join(ctx.cwd, file);
						try {
							const info = await stat(abs);
							if (info.size > MAX_FULL_SCOPE_FILE_BYTES) {
								units.push({ id: `U${units.length + 1}`, path: file, status: "file", language: "unknown", text: `(${info.size} bytes; too large to excerpt)`, truncated: true, signalLines: [] });
								continue;
							}
							units.push(unitFromFile(`U${units.length + 1}`, file, await readFile(abs, "utf8")));
						} catch {
							// unreadable file: nothing to route
						}
					}
				}
				const unitsById = new Map(units.map((u) => [u.id, u]));
				const heuristics = new Map<string, Map<string, string[]>>();
				for (const unit of units) {
					const hits = heuristicRoutes(unit);
					heuristics.set(unit.id, hits);
					selector.addHeuristics(unit, hits);
				}

				if (cfg.router === "auto" && units.length > 0) {
					const routingPrompt = await readFile(packagePath("routing-prompt.md"), "utf8");
					const batches = batchUnits(units);
					total = batches.length;
					renderProgress();
					await pool(batches, cfg.concurrency, async (batch, index) => {
						const label = `router-${index + 1}`;
						activity.set(label, `routing ${batch.length} unit${batch.length === 1 ? "" : "s"}`);
						renderProgress();
						const input = buildRouterInput(batch, heuristics, { scopeDescription: scopeDesc, deletedFiles: scope.kind === "diff" ? scope.deletedFiles : undefined, manifestComplete: batches.length === 1 });
						let session: SubSession | undefined;
						let raw = "";
						try {
							session = await openSession({ sdk: fullSdk, model: routerModel, modelRegistry: ctx.modelRegistry, cwd: ctx.cwd, tools: [], systemPrompt: routingPrompt, timeoutSec: cfg.routerTimeoutSec, onActivity: (a) => { activity.set(label, a); renderProgress(); } });
							raw = await session.ask(input);
							let response: RouterResponse;
							try {
								response = validateRouterResponse(raw, batch, map);
							} catch (first) {
								const reason = first instanceof Error ? first.message : String(first);
								activity.set(label, `retrying: ${reason}`);
								renderProgress();
								raw = await session.ask(`Your previous output was invalid: ${reason}. Return only the corrected JSON object, covering every unit exactly once.`);
								response = validateRouterResponse(raw, batch, map);
								routerNotes.push(`${label}: first response rejected (${reason}); retry accepted.`);
							}
							selector.addRouterResponse(response, unitsById);
							for (const u of response.unrouted) routerNotes.push(`${label}: ${u.id} ${unitsById.get(u.id)?.path ?? ""} left unrouted — ${u.reason || "no reason given"}. Baseline and heuristic routes still apply.`);
							await writeFile(join(runDir, `${label}.json`), JSON.stringify({ units: batch.map((u) => ({ id: u.id, path: u.path, status: u.status })), response }, null, 2));
						} catch (error) {
							const reason = error instanceof Error ? error.message : String(error);
							selector.addAll("fallback", `${label} failed (${reason}); every route scheduled for its ${batch.length} units`);
							routerNotes.push(`${label} failed after retry (${reason}); fell back to evaluating every route for units ${batch.map((u) => u.id).join(", ")}.`);
							await writeFile(join(runDir, `${label}.json`), JSON.stringify({ units: batch.map((u) => ({ id: u.id, path: u.path })), error: reason, raw: raw.slice(0, 4000) }, null, 2));
						} finally {
							await session?.dispose();
						}
						done++;
						activity.delete(label);
						renderProgress();
					});
				}
			}

			// ---- Stage 2: evaluation ----------------------------------------------------------
			const groups = planGroups(allRules, selector, map, cfg.groupSize);
			const selectedRoutes = selector.routes();
			const ruleCount = groups.reduce((n, g) => n + g.rules.length, 0);
			phase = "evaluating";
			done = 0;
			total = groups.length;
			renderProgress();
			ctx.ui.notify(
				`lint-audit: ${scopeDesc}; ${selectedRoutes.length} routes → ${ruleCount}/${allRules.length} rules in ${groups.length} groups of <=${cfg.groupSize}; evaluator ${model.id}${cfg.router === "auto" ? `, router ${routerModel.id}` : ""}`,
				"info",
			);

			const results = await pool(groups, cfg.concurrency, async (group): Promise<GroupResult> => {
				const result: GroupResult = { group: group.label, ruleIds: group.rules.map((r) => r.id), routes: group.routes.map((r) => r.route), findings: [], clean: true };
				activity.set(group.label, `starting (${group.rules.length} rules)`);
				renderProgress();
				let session: SubSession | undefined;
				try {
					session = await openSession({ sdk: fullSdk, model, modelRegistry: ctx.modelRegistry, cwd: ctx.cwd, tools: ["read", "grep", "glob"], timeoutSec: cfg.evalTimeoutSec, onActivity: (a) => { activity.set(group.label, a); renderProgress(); } });
					const text = await session.ask(buildGroupPrompt(group, scope));
					const findings = extractFindings(text);
					if (findings === undefined) {
						result.error = "unparseable evaluation output";
						result.raw = text.slice(0, 4000);
						result.clean = false;
					} else {
						result.findings = findings;
						result.clean = findings.length === 0;
						findingsSoFar += findings.length;
					}
				} catch (error) {
					result.error = error instanceof Error ? error.message : String(error);
					result.clean = false;
				} finally {
					await session?.dispose();
				}
				await writeFile(join(runDir, `${group.label}.json`), JSON.stringify(result, null, 2));
				done++;
				activity.delete(group.label);
				renderProgress();
				return result;
			});

			// ---- Stage 3: report ----------------------------------------------------------------
			const findings = results.flatMap((r) => r.findings);
			const failed = results.filter((r) => r.error);
			const report = buildReport({
				generatedAt: new Date(),
				scope,
				model: model.id,
				routerMode: cfg.router,
				routerModel: cfg.router === "auto" ? routerModel.id : undefined,
				rulesTotal: allRules.length,
				routes: selectedRoutes,
				routerNotes,
				groups: results,
				rulesById,
				runDir,
			});
			await mkdir(dirname(reportPath), { recursive: true });
			await writeFile(reportPath, report);
			await writeFile(
				join(runDir, "summary.json"),
				JSON.stringify(
					{
						config: { ...cfg, model: model.id, routerModel: cfg.router === "auto" ? routerModel.id : undefined },
						scope: scope.kind === "diff" ? { kind: "diff", base: scope.base, files: scope.files, deletedFiles: scope.deletedFiles } : { kind: "full", files: scope.files.length },
						totalRules: allRules.length,
						evaluatedRules: ruleCount,
						routes: selectedRoutes.map((r) => ({ route: r.route, sources: [...r.sources], evidence: r.evidence, unresolved: r.unresolved })),
						routerNotes,
						groups: results.map((r) => ({ group: r.group, routes: r.routes, ruleIds: r.ruleIds, findings: r.findings.length, clean: r.clean, error: r.error })),
						reportPath,
					},
					null,
					2,
				),
			);

			clearProgress();
			ctx.ui.notify(
				`lint-audit: ${findings.length} findings; ${ruleCount}/${allRules.length} rules in ${groups.length} groups, ${failed.length} failed. Report: ${reportPath}`,
				findings.length > 0 || failed.length > 0 ? "warning" : "info",
			);
			pi.sendMessage({ customType: "lint-audit.report", content: report, display: true }, { triggerTurn: false });
			if (!ctx.hasUI) process.stdout.write(`${report}\n`);

			// ---- Stage 4: fix (opt-in) ----------------------------------------------------------
			if (!cfg.fix || findings.length === 0) return;
			await ctx.waitForIdle();
			pi.sendUserMessage(buildFixMessage(findings, rulesById, reportPath));
			// Keep the handler alive until the fix turn has started and finished;
			// otherwise print mode exits before the message is ever processed.
			const fixStart = Date.now();
			while (ctx.isIdle() && Date.now() - fixStart < 15_000) {
				const tick = Promise.withResolvers<void>();
				setTimeout(tick.resolve, 100);
				await tick.promise;
			}
			await ctx.waitForIdle();
		},
	});
}
