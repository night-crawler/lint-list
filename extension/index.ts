/**
 * lint-audit — omp extension.
 *
 * /lint-audit [group=24] [c=4] [seed=1337] [model=<spec|@role>] [apply=true|false]
 *             [scope=auto|diff|full] [base=<ref>] [dir=<rules dir>]
 *
 * Flow:
 *  1. Load ALL rule JSON files from the bundled rules dir (`<pkg>/rules` or `<pkg>/../rules`).
 *  1b. Resolve the audit scope. Default `auto`: when the cwd is a git repo with a resolvable
 *      base branch (origin/HEAD -> main -> master, override with base=), audit ONLY the
 *      PR diff (merge-base..working tree, uncommitted included); auditing the whole tree is
 *      expensive. `full` forces a whole-tree audit; `diff` fails instead of falling back.
 *  2. Seeded full Fisher-Yates shuffle of the whole rule array (random draw with removal;
 *     same seed => same order). Shuffling de-biases group composition, nothing is skipped.
 *  3. Partition the shuffled array into groups of `groupSize`; EVERY group is evaluated in a
 *     headless read-only sub-session, with concurrency C, using the current or configured model.
 *     Grouping bounds per-evaluation context; concurrency bounds wall-clock time.
 *  4. Persist every group result to `.omp/lint-audit/<run>/` (intermediate store).
 *  5. Groups with zero findings report success only and stay out of the final context.
 *  6. Aggregate positive detections into one message sent to the main session,
 *     which applies the suggested changes to the code.
 *
 * Defaults can also be set in `<cwd>/.omp/lint-audit.json` or `<pkg>/lint-audit.json`
 * (command args win): {"groupSize":24,"concurrency":4,"seed":1337,"model":"","apply":true}
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface Rule {
	id: number | string;
	title: string;
	category: string;
	pattern?: string;
	why_bad?: string;
	detection?: string;
	counterexample?: string;
	fix?: string;
	/** relative path of the source JSON, for diagnostics */
	_path: string;
}

interface Finding {
	rule_id: number | string;
	file: string;
	lines?: string;
	evidence?: string;
	suggestion: string;
}

interface GroupResult {
	group: string;
	ruleIds: (number | string)[];
	findings: Finding[];
	clean: boolean;
	error?: string;
	raw?: string;
}

interface AuditConfig {
	groupSize: number;
	concurrency: number;
	seed: number;
	model: string;
	apply: boolean;
	rulesDir: string;
	evalTimeoutSec: number;
	scope: "auto" | "diff" | "full";
	base: string;
}

/** Whole-tree audit, or one bounded to the current branch's diff against a base ref. */
export type AuditScope =
	| { kind: "full" }
	| { kind: "diff"; base: string; files: string[]; diffText?: string };

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
	seed: 1337,
	model: "",
	apply: true,
	rulesDir: "",
	evalTimeoutSec: 600,
	scope: "auto",
	base: "",
};

/** Above this, the diff is not embedded per group; auditors get the file list and read on demand. */
const MAX_EMBEDDED_DIFF_CHARS = 48_000;

/** Deterministic PRNG. Not cryptographic; stability is the only requirement. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Full Fisher-Yates shuffle (random draw with removal) of the whole array.
 * Same sorted input + seed => same order. Every element survives.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const out = items.slice();
	const rand = mulberry32(seed);
	for (let i = 0; i < out.length - 1; i++) {
		const j = i + Math.floor(rand() * (out.length - i));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Partition into consecutive chunks of `size`; the last chunk may be smaller. */
export function partition<T>(items: readonly T[], size: number): T[][] {
	const chunkSize = Math.max(1, size);
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += chunkSize) {
		chunks.push(items.slice(i, i + chunkSize));
	}
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
				rules.push({ ...rule, _path: rel });
			}
		} catch {
			// malformed rule file: skip, never abort the audit
		}
	}
	return rules;
}

export function buildGroupPrompt(groupLabel: string, rules: Rule[], scope: AuditScope): string {
	const sections = rules.map((r) => {
		const parts = [`### Rule ${r.id} [${r.category || "uncategorized"}]: ${r.title}`];
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
					`You are a code-smell auditor. Audit the source code of the current working directory against every rule below (audit batch ${groupLabel}; the rules span multiple categories).`,
					`Use read/grep/glob to inspect the actual code. Skip vendored/generated/third-party code and the .omp directory.`,
				]
			: [
					`You are a code-smell auditor. Audit ONLY the current branch's changes against ${scope.base} (the PR diff) using every rule below (audit batch ${groupLabel}; the rules span multiple categories).`,
					`Changed files:`,
					...scope.files.map((f) => `- ${f}`),
					`Only report violations introduced or touched by these changes: the violating code must be in a changed file and involve changed lines or code directly connected to them. Pre-existing violations in untouched code are out of scope.`,
					`Use read/grep/glob for surrounding context where needed.`,
					...(scope.diffText ? [``, `## Diff vs ${scope.base}`, "```diff", scope.diffText, "```"] : []),
				];
	return [
		...scopeLines,
		`Only report a violation you can evidence with a specific file and location, and only when it clearly matches the rule's detection criteria (respect the counterexamples). When in doubt, do not report.`,
		``,
		`## Rules`,
		sections.join("\n\n"),
		``,
		`## Output`,
		`Your FINAL message must be ONLY a JSON object, no prose, no code fence:`,
		`{"findings":[{"rule_id":<id>,"file":"<relative path>","lines":"<N-M>","evidence":"<what you saw>","suggestion":"<concrete change to make>"}]}`,
		`If none of the rules are violated, output exactly {"findings":[]}.`,
	].join("\n");
}

function coerceFinding(value: unknown): Finding | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>; // narrowed to object above; fields re-checked below
	const file = typeof record.file === "string" ? record.file : "";
	const suggestion = typeof record.suggestion === "string" ? record.suggestion : "";
	if (!file || !suggestion) return undefined;
	return {
		rule_id: typeof record.rule_id === "number" || typeof record.rule_id === "string" ? record.rule_id : "?",
		file,
		suggestion,
		lines: record.lines === undefined ? undefined : String(record.lines),
		evidence: record.evidence === undefined ? undefined : String(record.evidence),
	};
}

/** Lenient JSON extraction: direct parse -> fenced block -> outermost brace slice. */
export function extractFindings(text: string): Finding[] | undefined {
	const candidates: string[] = [text.trim()];
	const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
	if (fenced.length > 0) candidates.push(fenced[fenced.length - 1][1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && "findings" in parsed && Array.isArray(parsed.findings)) {
				return parsed.findings.map(coerceFinding).filter((f): f is Finding => f !== undefined);
			}
		} catch {
			// try next candidate
		}
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

function parseArgs(args: string): Partial<AuditConfig> {
	const out: Partial<AuditConfig> = {};
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		const eq = token.indexOf("=");
		if (eq === -1) continue;
		const key = token.slice(0, eq).toLowerCase();
		const value = token.slice(eq + 1);
		if (key === "group" || key === "groupsize" || key === "n") out.groupSize = Number(value) || DEFAULTS.groupSize;
		else if (key === "c" || key === "concurrency") out.concurrency = Number(value) || DEFAULTS.concurrency;
		else if (key === "seed") out.seed = Number(value) || DEFAULTS.seed;
		else if (key === "model") out.model = value;
		else if (key === "apply") out.apply = value !== "false" && value !== "0";
		else if (key === "dir") out.rulesDir = value;
		else if (key === "timeout") out.evalTimeoutSec = Number(value) || DEFAULTS.evalTimeoutSec;
		else if (key === "scope" && (value === "auto" || value === "diff" || value === "full")) out.scope = value;
		else if (key === "base") out.base = value;
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
		if (typeof record.seed === "number") out.seed = record.seed;
		if (typeof record.model === "string") out.model = record.model;
		if (typeof record.apply === "boolean") out.apply = record.apply;
		if (typeof record.rulesDir === "string") out.rulesDir = record.rulesDir;
		if (typeof record.evalTimeoutSec === "number") out.evalTimeoutSec = record.evalTimeoutSec;
		if (record.scope === "auto" || record.scope === "diff" || record.scope === "full") out.scope = record.scope;
		if (typeof record.base === "string") out.base = record.base;
		return out;
	} catch {
		return {};
	}
}

function resolveRulesDir(configured: string, cwd: string): string | undefined {
	const candidates = configured
		? [configured, join(cwd, configured)]
		: [join(import.meta.dir, "rules"), join(import.meta.dir, "..", "rules")];
	return candidates.find((c) => existsSync(c));
}

type GitExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; code: number }>;

/**
 * Resolve the PR-diff scope: merge-base of HEAD and a base ref, diffed against the
 * working tree (uncommitted changes included, deleted files excluded).
 * Returns undefined when cwd is not a git repo, no base ref resolves, or the diff is empty.
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
	const nameList = await git("diff", "--name-only", "--diff-filter=d", mergeBase);
	const files = nameList ? nameList.split("\n").filter(Boolean) : [];
	if (files.length === 0) return undefined;

	const diffText = await git("diff", "--unified=3", "--diff-filter=d", mergeBase);
	return {
		kind: "diff",
		base,
		files,
		diffText: diffText && diffText.length <= MAX_EMBEDDED_DIFF_CHARS ? diffText : undefined,
	};
}

function buildApplyMessage(results: GroupResult[]): string {
	const lines = [
		"# Lint audit findings",
		"A rule-based audit of this codebase produced the confirmed findings below.",
		"Apply each suggestion to the code now. Keep changes minimal and behavior-preserving unless the suggestion says otherwise; skip a finding only if the code has changed and it no longer applies (say so explicitly).",
		"",
		"## Findings",
	];
	const findings = results.flatMap((r) => r.findings);
	findings.sort((a, b) => a.file.localeCompare(b.file));
	for (const f of findings) {
		lines.push(`- **Rule ${f.rule_id}** — \`${f.file}\`${f.lines ? ` (lines ${f.lines})` : ""}`);
		if (f.evidence) lines.push(`  - Evidence: ${f.evidence}`);
		lines.push(`  - Change: ${f.suggestion}`);
	}
	return lines.join("\n");
}

export default function lintAudit(pi: ExtensionAPI) {
	pi.setLabel("Lint Audit");

	pi.registerCommand("lint-audit", {
		description: "Run ALL rules: seeded shuffle, partition into groups, evaluate in parallel, apply findings",
		handler: async (args, ctx) => {
			// pi.pi is the untyped package-export bag; structural cast at this boundary only.
			const sdk = pi.pi as unknown as Partial<SdkExports>;
			const { createAgentSession, SessionManager, AgentRegistry } = sdk;
			if (!createAgentSession || !SessionManager) {
				ctx.ui.notify("lint-audit: SDK exports unavailable (createAgentSession/SessionManager)", "error");
				return;
			}

			const cfg: AuditConfig = {
				...DEFAULTS,
				...(await readConfigFile(join(import.meta.dir, "lint-audit.json"))),
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

			const model = cfg.model ? ctx.models.resolve(cfg.model) : ctx.models.current();
			if (!model) {
				ctx.ui.notify(`lint-audit: cannot resolve model "${cfg.model || "<current>"}"`, "error");
				return;
			}

			let scope: AuditScope = { kind: "full" };
			if (cfg.scope !== "full") {
				const diffScope = await resolveDiffScope(pi.exec.bind(pi), ctx.cwd, cfg.base);
				if (diffScope) {
					scope = diffScope;
				} else if (cfg.scope === "diff") {
					ctx.ui.notify(
						"lint-audit: scope=diff but no PR diff found (not a git repo, no base ref, or no changes vs base)",
						"error",
					);
					return;
				} else {
					ctx.ui.notify("lint-audit: no PR diff detected; falling back to a full-tree audit", "warning");
				}
			}

			// Every rule runs exactly once: shuffle de-biases group composition,
			// partition bounds per-evaluation context, the pool bounds wall time.
			const shuffled = seededShuffle(allRules, cfg.seed);
			const groups = partition(shuffled, cfg.groupSize);
			const pad = String(groups.length).length;
			const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-seed${cfg.seed}-g${cfg.groupSize}`;
			const runDir = join(ctx.cwd, ".omp", "lint-audit", runId);
			await mkdir(runDir, { recursive: true });

			const scopeDesc =
				scope.kind === "diff"
					? `diff vs ${scope.base} (${scope.files.length} files${scope.diffText ? "" : ", diff too large to embed"})`
					: "full tree";
			ctx.ui.notify(
				`lint-audit: ${allRules.length} rules in ${groups.length} groups of <=${cfg.groupSize}, c=${cfg.concurrency}, seed=${cfg.seed}, model=${model.id}, scope=${scopeDesc}`,
				"info",
			);

			// Live progress: one line per in-flight group (widget capped at 10 lines),
			// plus a compact status-bar line. All of it is a no-op without a UI.
			const activity = new Map<string, string>(); // label -> latest sub-agent action
			let done = 0;
			let findingsSoFar = 0;
			const renderProgress = () => {
				const summary = `lint-audit ${done}/${groups.length} groups | ${findingsSoFar} findings | c=${cfg.concurrency} seed=${cfg.seed}`;
				const running = [...activity.entries()].map(([label, action]) => `  ▶ ${label}: ${action}`);
				ctx.ui.setStatus("lint-audit", summary);
				ctx.ui.setWorkingMessage(summary);
				ctx.ui.setWidget("lint-audit", [summary, ...running.slice(0, 9)], { placement: "belowEditor" });
			};
			renderProgress();

			const results = await pool(groups, cfg.concurrency, async (rules, index): Promise<GroupResult> => {
				const label = `group-${String(index + 1).padStart(pad, "0")}`;
				const base: GroupResult = { group: label, ruleIds: rules.map((r) => r.id), findings: [], clean: true };
				activity.set(label, `starting (${rules.length} rules)`);
				renderProgress();
				let session: SdkSession | undefined;
				try {
					const created = await createAgentSession({
						model,
						modelRegistry: ctx.modelRegistry,
						// modelRegistry.authStorage must be the same instance passed as authStorage.
						authStorage:
							"authStorage" in ctx.modelRegistry ? ctx.modelRegistry.authStorage : undefined,
						sessionManager: SessionManager.inMemory(),
						// Private registry: the process-global one admits a single "Main" identity.
						...(AgentRegistry ? { agentRegistry: new AgentRegistry() } : {}),
						toolNames: ["read", "grep", "glob"],
						restrictToolNames: true, // read-only; also disables ambient MCP/extensions/LSP
						enableMCP: false,
						enableLsp: false,
						disableExtensionDiscovery: true,
						cwd: ctx.cwd,
					});
					session = created.session;

					let lastAssistantText = "";
					const unsubscribe = session.subscribe((event) => {
						if (event.type === "tool_execution_start" && event.toolName) {
							activity.set(label, `${event.toolName}${event.intent ? ` — ${event.intent}` : ""}`);
							renderProgress();
						} else if (event.type === "message_end" && event.message?.role === "assistant") {
							const text = (event.message.content ?? [])
								.filter((block) => block.type === "text")
								.map((block) => block.text ?? "")
								.join("\n");
							if (text.trim()) lastAssistantText = text;
						}
					});

					const activeSession = session;
					const watchdog = Promise.withResolvers<never>();
					const timer = setTimeout(() => {
						try {
							activeSession.abort();
						} catch {}
						watchdog.reject(new Error(`evaluation timed out after ${cfg.evalTimeoutSec}s`));
					}, cfg.evalTimeoutSec * 1000);
					if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
						timer.unref(); // never keep the process alive for the watchdog
					}
					try {
						await Promise.race([session.prompt(buildGroupPrompt(label, rules, scope)), watchdog.promise]);
					} finally {
						clearTimeout(timer);
					}
					unsubscribe();

					const findings = extractFindings(lastAssistantText);
					if (findings === undefined) {
						base.error = "unparseable evaluation output";
						base.raw = lastAssistantText.slice(0, 4000);
						base.clean = false;
					} else {
						base.findings = findings;
						base.clean = findings.length === 0;
						findingsSoFar += findings.length;
					}
				} catch (error) {
					base.error = error instanceof Error ? error.message : String(error);
					base.clean = false;
				} finally {
					try {
						await session?.dispose();
					} catch {}
				}
				await writeFile(join(runDir, `${label}.json`), JSON.stringify(base, null, 2));
				done++;
				activity.delete(label);
				renderProgress();
				return base;
			});

			const positive = results.filter((r) => r.findings.length > 0);
			const clean = results.filter((r) => r.clean);
			const failed = results.filter((r) => r.error);
			const totalFindings = positive.reduce((sum, r) => sum + r.findings.length, 0);

			await writeFile(
				join(runDir, "summary.json"),
				JSON.stringify(
					{
						seed: cfg.seed,
						groupSize: cfg.groupSize,
						totalRules: allRules.length,
						model: model.id,
						scope: scope.kind === "diff" ? { kind: "diff", base: scope.base, files: scope.files } : { kind: "full" },
						groups: results.map((r) => ({
							group: r.group,
							ruleIds: r.ruleIds,
							findings: r.findings.length,
							clean: r.clean,
							error: r.error,
						})),
					},
					null,
					2,
				),
			);

			ctx.ui.setStatus("lint-audit", undefined);
			ctx.ui.setWidget("lint-audit", undefined);
			ctx.ui.setWorkingMessage();
			ctx.ui.notify(
				`lint-audit: ${totalFindings} findings in ${positive.length}/${groups.length} groups; ${clean.length} clean; ${failed.length} failed. Results: ${runDir}`,
				totalFindings > 0 ? "warning" : "info",
			);

			// Clean groups reported success above; only positive detections reach the model context.
			if (totalFindings === 0) return;
			if (!cfg.apply) return;
			await ctx.waitForIdle();
			pi.sendUserMessage(buildApplyMessage(positive));
			// Keep the handler alive until the apply turn has started and finished;
			// otherwise print mode exits before the message is ever processed.
			const applyStart = Date.now();
			while (ctx.isIdle() && Date.now() - applyStart < 15_000) {
				const tick = Promise.withResolvers<void>();
				setTimeout(tick.resolve, 100);
				await tick.promise;
			}
			await ctx.waitForIdle();
		},
	});
}
