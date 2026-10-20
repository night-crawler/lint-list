import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { GroupResult, PredictionResult, Rule } from "./types";

const MAX_WIDGET_ROWS = 9;
const MAX_RECENT_RESULTS = 3;

type ProgressUI = Pick<ExtensionUIContext, "notify" | "setStatus" | "setWidget" | "setWorkingMessage">;

function formatProbability(value: number | null | undefined): string {
	return value == null ? "unknown" : value.toPrecision(5);
}

function describePrediction(result: PredictionResult): string {
	const scores = result.probabilities;
	const verdict = result.error
		? `ERROR: ${result.error}`
		: `${result.answer} (${result.answer === "a" ? "violates" : "doesn't violate"})`;
	const conditional = scores?.probabilitiesGivenAOrB;
	return (
		`${verdict}; ` +
		`P(a)=${formatProbability(scores?.tokenProbabilities.a)} P(b)=${formatProbability(scores?.tokenProbabilities.b)}; ` +
		`label mass=${formatProbability(scores?.observedLabelMass)}; ` +
		`P(a|a/b)=${formatProbability(conditional?.a)} P(b|a/b)=${formatProbability(conditional?.b)}` +
		(result.probabilityError ? `; ${result.probabilityError}` : "")
	);
}

export class AuditProgress {
	private readonly activity = new Map<string, string>();
	private readonly recentResults: string[] = [];
	private phase: "predicting" | "validating" = "predicting";
	private completed = 0;
	private total = 0;
	private candidates = 0;
	private findings = 0;

	constructor(
		private readonly ui: ProgressUI,
		private readonly hasUI: boolean,
		private readonly concurrency: number,
	) {}

	announce(content: string): void {
		if (this.hasUI) this.ui.notify(content, "info");
		else process.stdout.write(`${content}\n`);
	}

	startPredictions(total: number): void {
		this.phase = "predicting";
		this.total = total;
		this.completed = 0;
		this.candidates = 0;
	}

	updateActivity(label: string, action: string): void {
		this.activity.set(label, action);
		this.render();
	}

	completePrediction(rule: Pick<Rule, "id" | "title">, result: PredictionResult): void {
		if (result.answer === "a") this.candidates++;
		this.completed++;
		const details = describePrediction(result);
		if (this.hasUI) {
			this.recentResults.unshift(`  done rule ${rule.id}: ${details} — ${rule.title}`);
			if (this.recentResults.length > MAX_RECENT_RESULTS) this.recentResults.pop();
		} else {
			process.stdout.write(`lint-audit [${this.completed}/${this.total}] rule ${rule.id} — ${rule.title}: ${details}\n`);
		}
		this.activity.delete(`rule-${rule.id}`);
		this.render();
	}

	startValidation(total: number): void {
		this.phase = "validating";
		this.total = total;
		this.completed = 0;
		this.findings = 0;
		this.render();
	}

	completeGroup(result: GroupResult): void {
		this.findings += result.findings.length;
		this.completed++;
		this.activity.delete(result.group);
		this.render();
	}

	clear(): void {
		this.ui.setStatus("lint-audit", undefined);
		this.ui.setWidget("lint-audit", undefined);
		this.ui.setWorkingMessage();
	}

	private render(): void {
		const count = this.phase === "predicting" ? `${this.candidates} candidates` : `${this.findings} findings`;
		const summary = `lint-audit ${this.phase} ${this.completed}/${this.total} | ${count} | c=${this.concurrency}`;
		const rows = [summary];
		for (const [label, action] of this.activity) {
			if (rows.length > MAX_WIDGET_ROWS - this.recentResults.length) break;
			rows.push(`  ${label}: ${action}`);
		}
		rows.push(...this.recentResults);
		this.ui.setStatus("lint-audit", summary);
		this.ui.setWorkingMessage(summary);
		this.ui.setWidget("lint-audit", rows, { placement: "belowEditor" });
	}
}
