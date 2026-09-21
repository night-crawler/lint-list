import type { AuditScope, Finding, GroupResult, PredictionResult, Rule, Severity } from "./types";

export interface ReportInput {
	generatedAt: Date;
	scope: AuditScope;
	predictorModel: string;
	validatorModel: string;
	rulesTotal: number;
	predictions: PredictionResult[];
	groups: GroupResult[];
	rulesById: Map<string, Rule>;
	runDir: string;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function describeScope(scope: AuditScope): string {
	return scope.kind === "diff"
		? `git diff \`${scope.base}\` at \`${scope.baseCommit.slice(0, 12)}\` (${scope.files.length} changed tracked file${scope.files.length === 1 ? "" : "s"}${scope.deletedFiles.length ? `, ${scope.deletedFiles.length} deleted` : ""})`
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
		if (!list) {
			list = [];
			byFile.set(finding.file, list);
		}
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
	const failedGroups = input.groups.filter((g) => g.error !== undefined);
	const failedPredictions: PredictionResult[] = [];
	let predictedViolations = 0;
	let predictorNegatives = 0;
	for (const prediction of input.predictions) {
		if (prediction.error !== undefined || (prediction.answer !== "a" && prediction.answer !== "b")) {
			failedPredictions.push(prediction);
		} else if (prediction.answer === "a") {
			predictedViolations++;
		} else {
			predictorNegatives++;
		}
	}
	const rulesSubmitted = new Set(input.groups.flatMap((g) => g.ruleIds.map(String))).size;
	const incomplete = failedPredictions.length > 0 || failedGroups.length > 0;
	const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
	for (const f of findings) bySeverity[f.severity ?? "medium"]++;
	const byFile = groupByFile(findings);

	const out: string[] = [];
	out.push("# Lint audit report");
	out.push("");
	out.push(
		`_${input.generatedAt.toISOString()}_ · scope: ${describeScope(input.scope)} · predictor: \`${input.predictorModel}\` · validator: \`${input.validatorModel}\``,
	);
	out.push("");
	out.push("## Summary");
	out.push("");
	out.push(
		`- **${findings.length} finding${findings.length === 1 ? "" : "s"}** (${bySeverity.high} high · ${bySeverity.medium} medium · ${bySeverity.low} low) across ${byFile.size} file${byFile.size === 1 ? "" : "s"}`,
	);
	out.push(`- Rules successfully predicted (a or b): ${predictedViolations + predictorNegatives} of ${input.rulesTotal}`);
	out.push(`- Predicted violations (a): ${predictedViolations} (candidates, not confirmed findings)`);
	out.push(`- Predictor negatives (b): ${predictorNegatives} (not validator-confirmed clean)`);
	out.push(`- Failed predictions: ${failedPredictions.length}${failedPredictions.length ? " (coverage incomplete, see below)" : ""}`);
	out.push(
		`- Rules submitted for grouped validation: ${rulesSubmitted} in ${input.groups.length} group${input.groups.length === 1 ? "" : "s"}${failedGroups.length ? `; **${failedGroups.length} validation group${failedGroups.length === 1 ? "" : "s"} failed** (coverage incomplete, see below)` : ""}`,
	);
	if (input.scope.kind === "diff")
		out.push(`- Only violations in code added by the diff are reported; pre-existing smells in untouched code are out of scope.`);
	out.push(`- Intermediate results: \`${input.runDir}\``);
	out.push("");

	out.push("## Findings");
	out.push("");
	if (findings.length === 0) {
		out.push(
			incomplete
				? "No validated findings were produced. Coverage is incomplete because some predictions or validation groups failed."
				: "No validated rule violations detected. Predictor negatives were not submitted for validation.",
		);
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

	if (incomplete) {
		out.push("## Incomplete coverage");
		out.push("");
		for (const prediction of failedPredictions) {
			out.push(
				`- Prediction failed for ${ruleLabel(prediction.ruleId, input.rulesById)}: ${prediction.error || "No valid a/b prediction returned."}`,
			);
		}
		for (const group of failedGroups) {
			out.push(`- Validation group \`${group.group}\` (${group.ruleIds.length} rules): ${group.error}`);
		}
		out.push("");
	}

	out.push("## Validation groups");
	out.push("");
	for (const g of input.groups) {
		const state =
			g.error !== undefined
				? `failed: ${g.error}`
				: g.findings.length
					? `${g.findings.length} finding${g.findings.length === 1 ? "" : "s"}`
					: "no violations confirmed";
		out.push(`- \`${g.group}\` — ${g.ruleIds.length} rules: ${state}`);
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
			lines.push(
				`- **Rule ${f.rule_id}${rule ? ` — ${rule.title}` : ""}**${f.lines ? ` (lines ${f.lines})` : ""}${f.severity ? ` [${f.severity}]` : ""}`,
			);
			if (f.evidence) lines.push(`  - Evidence: ${indent(f.evidence, "    ")}`);
			lines.push(`  - Change: ${indent(f.suggestion, "    ")}`);
			if (rule?.fix) lines.push(`  - Rule's fix approach: ${indent(rule.fix, "    ")}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
