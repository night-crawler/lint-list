import type { RouteSelection, RouteSource } from "./router";
import type { AuditScope, Finding, GroupResult, Rule, Severity } from "./types";

export interface ReportInput {
	generatedAt: Date;
	scope: AuditScope;
	model: string;
	routerMode: "auto" | "heuristic" | "all";
	routerModel?: string;
	rulesTotal: number;
	routes: RouteSelection[];
	/** Router-stage observations worth surfacing: unrouted units, retries, fallbacks. */
	routerNotes: string[];
	groups: GroupResult[];
	rulesById: Map<string, Rule>;
	runDir: string;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_LABEL: Record<RouteSource, string> = {
	baseline: "baseline",
	heuristic: "heuristic",
	router: "router",
	"router-need": "router (context unresolved)",
	fallback: "fallback",
	unmapped: "unmapped rules",
};

export function describeScope(scope: AuditScope): string {
	return scope.kind === "diff"
		? `diff vs \`${scope.base}\` (${scope.files.length} changed file${scope.files.length === 1 ? "" : "s"}${scope.deletedFiles.length ? `, ${scope.deletedFiles.length} deleted` : ""})`
		: `full tree (${scope.files.length} files)`;
}

function ruleLabel(id: number | string, rulesById: Map<string, Rule>): string {
	const rule = rulesById.get(String(id));
	return rule ? `Rule ${id} — ${rule.title} _(${rule.category})_` : `Rule ${id}`;
}

function sortFindings(findings: Finding[]): Finding[] {
	return [...findings].sort((a, b) => {
		const bySeverity = SEVERITY_RANK[a.severity ?? "medium"] - SEVERITY_RANK[b.severity ?? "medium"];
		if (bySeverity !== 0) return bySeverity;
		const byFile = a.file.localeCompare(b.file);
		if (byFile !== 0) return byFile;
		return Number(a.lines?.split(/\D/)[0] ?? 0) - Number(b.lines?.split(/\D/)[0] ?? 0);
	});
}

/** Findings grouped by file; files ordered by their most severe finding, findings within a file by severity then line. */
function groupByFile(findings: Finding[]): Map<string, Finding[]> {
	const byFile = new Map<string, Finding[]>();
	for (const finding of sortFindings(findings)) {
		let list = byFile.get(finding.file);
		if (!list) byFile.set(finding.file, (list = []));
		list.push(finding);
	}
	return byFile;
}

function indent(text: string, prefix: string): string {
	return text
		.trim()
		.split("\n")
		.map((line, i) => (i === 0 ? line : `${prefix}${line}`))
		.join("\n");
}

export function buildReport(input: ReportInput): string {
	const findings = input.groups.flatMap((g) => g.findings);
	const failed = input.groups.filter((g) => g.error);
	const rulesEvaluated = new Set(input.groups.flatMap((g) => g.ruleIds.map(String))).size;
	const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
	for (const f of findings) bySeverity[f.severity ?? "medium"]++;
	const byFile = groupByFile(findings);

	const out: string[] = [];
	out.push("# Lint audit report");
	out.push("");
	out.push(`_${input.generatedAt.toISOString()}_ · scope: ${describeScope(input.scope)} · evaluator: \`${input.model}\`${input.routerModel ? ` · router: \`${input.routerModel}\`` : ""} · routing: ${input.routerMode}`);
	out.push("");
	out.push("## Summary");
	out.push("");
	out.push(`- **${findings.length} finding${findings.length === 1 ? "" : "s"}** (${bySeverity.high} high · ${bySeverity.medium} medium · ${bySeverity.low} low) across ${byFile.size} file${byFile.size === 1 ? "" : "s"}`);
	out.push(`- Rules evaluated: ${rulesEvaluated} of ${input.rulesTotal} (${input.routes.length} routes selected) in ${input.groups.length} group${input.groups.length === 1 ? "" : "s"}${failed.length ? `; **${failed.length} group${failed.length === 1 ? "" : "s"} failed** (coverage incomplete, see below)` : ""}`);
	if (input.scope.kind === "diff") out.push(`- Only violations introduced or touched by the diff are reported; pre-existing smells in untouched code are out of scope.`);
	out.push(`- Intermediate results: \`${input.runDir}\``);
	out.push("");

	out.push("## Findings");
	out.push("");
	if (findings.length === 0) {
		out.push(failed.length ? "No findings from the groups that completed." : "No rule violations detected.");
		out.push("");
	}
	for (const [file, list] of byFile) {
		out.push(`### \`${file}\``);
		out.push("");
		for (const f of list) {
			const sev = f.severity ?? "medium";
			out.push(`#### [${sev.toUpperCase()}] ${ruleLabel(f.rule_id, input.rulesById)}`);
			out.push("");
			if (f.lines) out.push(`- **Lines:** ${f.lines}`);
			if (f.evidence) out.push(`- **Evidence:** ${indent(f.evidence, "  ")}`);
			out.push(`- **Suggestion:** ${indent(f.suggestion, "  ")}`);
			const rule = input.rulesById.get(String(f.rule_id));
			if (rule?.why_bad) out.push(`- **Why it matters:** ${indent(rule.why_bad, "  ")}`);
			out.push("");
		}
	}

	if (failed.length > 0) {
		out.push("## Incomplete coverage");
		out.push("");
		for (const g of failed) {
			out.push(`- \`${g.group}\` (${g.ruleIds.length} rules; routes: ${g.routes.join(", ") || "—"}): ${g.error}`);
		}
		out.push("");
	}

	out.push("## Routing");
	out.push("");
	out.push("A route is a batch of rules whose subject the change touches; selecting it means those rules were evaluated, not that they fired.");
	out.push("");
	out.push("| Route | Rules | Selected by | Trigger evidence |");
	out.push("|---|---:|---|---|");
	for (const r of input.routes) {
		const sources = [...r.sources].map((s) => SOURCE_LABEL[s]).join(", ");
		const evidence = r.evidence.slice(0, 3).map((e) => e.replace(/\|/g, "\\|")).join("<br>");
		out.push(`| \`${r.route}\` | ${r.ruleCount} | ${sources} | ${evidence}${r.evidence.length > 3 ? `<br>… ${r.evidence.length - 3} more` : ""} |`);
	}
	out.push("");
	const unresolved = input.routes.flatMap((r) => r.unresolved.map((u) => `\`${r.route}\`: ${u}`));
	if (unresolved.length > 0) {
		out.push("Context the router could not resolve (routes were evaluated anyway; the evaluator read the code directly):");
		out.push("");
		for (const u of unresolved) out.push(`- ${u}`);
		out.push("");
	}
	if (input.routerNotes.length > 0) {
		out.push("Router notes:");
		out.push("");
		for (const note of input.routerNotes) out.push(`- ${note}`);
		out.push("");
	}

	out.push("## Evaluation groups");
	out.push("");
	for (const g of input.groups) {
		const state = g.error ? `failed: ${g.error}` : g.findings.length ? `${g.findings.length} finding${g.findings.length === 1 ? "" : "s"}` : "clean";
		out.push(`- \`${g.group}\` — ${g.ruleIds.length} rules (${g.routes.join(", ") || "—"}): ${state}`);
	}
	out.push("");
	return out.join("\n");
}

/** Prompt for the main session when fix=true: apply the confirmed findings, nothing else. */
export function buildFixMessage(findings: Finding[], rulesById: Map<string, Rule>, reportPath: string): string {
	const lines = [
		"# Apply lint audit findings",
		`A rule-based audit produced the findings below (full report: \`${reportPath}\`).`,
		"Apply each suggestion to the code now. Keep changes minimal and behavior-preserving unless the suggestion says otherwise. Skip a finding only if the code has changed and it no longer applies, and say so explicitly. Do not fix anything the audit did not report.",
		"",
	];
	for (const [file, list] of groupByFile(findings)) {
		lines.push(`## \`${file}\``);
		for (const f of list) {
			const rule = rulesById.get(String(f.rule_id));
			lines.push(`- **Rule ${f.rule_id}${rule ? ` — ${rule.title}` : ""}**${f.lines ? ` (lines ${f.lines})` : ""}${f.severity ? ` [${f.severity}]` : ""}`);
			if (f.evidence) lines.push(`  - Evidence: ${indent(f.evidence, "    ")}`);
			lines.push(`  - Change: ${indent(f.suggestion, "    ")}`);
			if (rule?.fix) lines.push(`  - Rule's fix approach: ${indent(rule.fix, "    ")}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
