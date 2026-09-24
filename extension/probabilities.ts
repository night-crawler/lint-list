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

export const MIN_LABEL_MASS = 0.95;
const BOOLEAN_TOKEN = /^[ \t\r\n]*(true|false)[ \t\r\n]*$/;

/** Score only a standalone boolean in an already-validated JSON verdict, never its JSON prefix or reasoning. */
export function labelProbabilities(positions: unknown[], verdictText: string): LabelProbabilities {
	if (positions.length === 0) throw new Error("Provider did not return final-answer token logprobs");
	let labelPosition: (TokenScore & { top_logprobs: unknown[] }) | undefined;
	let offset = 0;
	for (const position of positions) {
		const selected = tokenScore(position);
		if (!verdictText.startsWith(selected.token, offset)) throw new Error("Final-answer logprobs do not match verdict text");
		offset += selected.token.length;
		const label = BOOLEAN_TOKEN.exec(selected.token)?.[1];
		if (label !== "true" && label !== "false") continue;
		if (labelPosition) throw new Error("Expected exactly one boolean-bearing token");
		if (!position || typeof position !== "object" || !("top_logprobs" in position) || !Array.isArray(position.top_logprobs)) {
			throw new Error("Provider did not return top token logprobs");
		}
		labelPosition = { ...selected, top_logprobs: position.top_logprobs };
	}
	if (offset !== verdictText.length) throw new Error("Final-answer logprobs do not cover the complete verdict");
	if (!labelPosition) throw new Error("Provider did not return a standalone boolean token; split or merged verdicts cannot be scored");
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
		const label = BOOLEAN_TOKEN.exec(token)?.[1];
		if (label === "true") values.a.push(logprob);
		else if (label === "false") values.b.push(logprob);
	}
	const scores: Record<"a" | "b", number | null> = { a: null, b: null };
	for (const label of ["a", "b"] as const) {
		if (values[label].length === 0) continue;
		const maximum = Math.max(...values[label]);
		scores[label] = maximum + Math.log(values[label].reduce((sum, value) => sum + Math.exp(value - maximum), 0));
		if (scores[label] > 1e-12) throw new Error("Label probability exceeds one");
	}
	const tokenProbabilities = { a: scores.a === null ? null : Math.exp(scores.a), b: scores.b === null ? null : Math.exp(scores.b) };
	const observedLabelMass = (tokenProbabilities.a ?? 0) + (tokenProbabilities.b ?? 0);
	if (observedLabelMass > 1 + 1e-12) throw new Error("Combined label probability exceeds one");
	let conditional: LabelProbabilities["probabilitiesGivenAOrB"] = null;
	// Normalizing a tiny label mass can hide that almost all probability went elsewhere.
	// A constrained decoder can itself force mass near one; this is not a calibration test.
	if (scores.a !== null && scores.b !== null && observedLabelMass >= MIN_LABEL_MASS) {
		const maximum = Math.max(scores.a, scores.b);
		const a = Math.exp(scores.a - maximum);
		const b = Math.exp(scores.b - maximum);
		conditional = { a: a / (a + b), b: b / (a + b) };
	}
	return {
		tokenProbabilities,
		observedLabelMass,
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
		// Chat endpoints may attach thought-token scores to logprobs.content as well.
		// Mixed reasoning/text chunks cannot be scored unambiguously either.
		if (choice?.delta?.reasoning_content || choice?.delta?.reasoning || choice?.delta?.reasoning_text) return undefined;
		const positions = choice?.logprobs?.content;
		return Array.isArray(positions) ? { positions, final: false } : undefined;
	}
	if ("type" in event && (event.type === "response.output_text.delta" || event.type === "response.output_text.done")) {
		const positions = "logprobs" in event ? event.logprobs : undefined;
		return Array.isArray(positions) ? { positions, final: event.type === "response.output_text.done" } : undefined;
	}
	return undefined;
}
