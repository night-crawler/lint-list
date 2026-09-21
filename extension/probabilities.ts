import type { LabelProbabilities } from "./types";

type TokenScore = { token: string; logprob: number };

function tokenScore(value: unknown): TokenScore {
	if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !("logprob" in value)) {
		throw new Error("Malformed token logprob");
	}
	if (typeof value.logprob !== "number" || !Number.isFinite(value.logprob) || value.logprob > 0) {
		throw new Error("Non-finite or invalid token logprob");
	}
	return { token: value.token, logprob: value.logprob };
}

/** Sum observed casing/whitespace variants in log space; missing labels are unknown, never complements. */
export function labelProbabilities(positions: unknown[]): LabelProbabilities {
	let labelPosition: (TokenScore & { top_logprobs: unknown[] }) | undefined;
	for (const position of positions) {
		const selected = tokenScore(position);
		const label = selected.token.trim().toLowerCase();
		if (label !== "a" && label !== "b") continue;
		if (labelPosition) throw new Error("Expected exactly one label-bearing token");
		if (!position || typeof position !== "object" || !("top_logprobs" in position) || !Array.isArray(position.top_logprobs)) {
			throw new Error("Provider did not return top token logprobs");
		}
		labelPosition = { ...selected, top_logprobs: position.top_logprobs };
	}
	if (!labelPosition) throw new Error("Provider did not return label token logprobs");
	const tokens = new Map<string, number>();
	for (const alternative of labelPosition.top_logprobs) {
		const score = tokenScore(alternative);
		if (tokens.has(score.token)) throw new Error("Duplicate token in top logprobs");
		tokens.set(score.token, score.logprob);
	}
	// The sampled label has a known score even if the provider omitted it from the alternatives.
	if (!tokens.has(labelPosition.token)) tokens.set(labelPosition.token, labelPosition.logprob);
	const values: Record<"a" | "b", number[]> = { a: [], b: [] };
	for (const [token, logprob] of tokens) {
		const label = token.trim().toLowerCase();
		if (label === "a" || label === "b") values[label].push(logprob);
	}
	const scores: Record<"a" | "b", number | null> = { a: null, b: null };
	for (const label of ["a", "b"] as const) {
		if (values[label].length === 0) continue;
		const maximum = Math.max(...values[label]);
		scores[label] = maximum + Math.log(values[label].reduce((sum, value) => sum + Math.exp(value - maximum), 0));
		if (scores[label] > 1e-12) throw new Error("Label probability exceeds one");
	}
	let conditional: LabelProbabilities["probabilitiesGivenAOrB"] = null;
	if (scores.a !== null && scores.b !== null) {
		const maximum = Math.max(scores.a, scores.b);
		const a = Math.exp(scores.a - maximum);
		const b = Math.exp(scores.b - maximum);
		conditional = { a: a / (a + b), b: b / (a + b) };
	}
	return {
		tokenProbabilities: { a: scores.a === null ? null : Math.exp(scores.a), b: scores.b === null ? null : Math.exp(scores.b) },
		probabilitiesGivenAOrB: conditional,
		missingLabels: (["a", "b"] as const).filter((label) => scores[label] === null),
	};
}

/** Chat Completions chunks and Responses text deltas carry the same token-score shape. */
export function readLogprobEvent(data: string): { positions: unknown[]; final: boolean } | undefined {
	if (!data || data === "[DONE]") return undefined;
	const event: unknown = JSON.parse(data);
	if (!event || typeof event !== "object") return undefined;
	if ("choices" in event && Array.isArray(event.choices)) {
		const choice = event.choices[0];
		const positions = choice?.logprobs?.content;
		return Array.isArray(positions) ? { positions, final: false } : undefined;
	}
	if ("type" in event && (event.type === "response.output_text.delta" || event.type === "response.output_text.done")) {
		const positions = "logprobs" in event ? event.logprobs : undefined;
		return Array.isArray(positions) ? { positions, final: event.type === "response.output_text.done" } : undefined;
	}
	return undefined;
}
