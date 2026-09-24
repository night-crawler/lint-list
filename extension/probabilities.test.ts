import { describe, expect, test } from "bun:test";
import { labelProbabilities, readLogprobEvent } from "./probabilities";

function verdictPositions(token: string, logprob: number, alternatives: unknown[] = []): unknown[] {
	return [
		{ token: '{"violates":', logprob: -0.1, top_logprobs: [] },
		{ token, logprob, top_logprobs: alternatives },
		{ token: "}", logprob: -0.1, top_logprobs: [] },
	];
}

describe("structured verdict token probabilities", () => {
	test("combines valid whitespace variants at the boolean, not the JSON prefix", () => {
		const scores = labelProbabilities(
			verdictPositions("false", Math.log(0.65), [
				{ token: "false", logprob: Math.log(0.65) },
				{ token: " false", logprob: Math.log(0.1) },
				{ token: "true", logprob: Math.log(0.21) },
				{ token: "False", logprob: Math.log(0.02) },
				{ token: "\u00a0true", logprob: Math.log(0.02) },
			]),
			'{"violates":false}',
		);
		expect(scores.tokenProbabilities.a).toBeCloseTo(0.21);
		expect(scores.tokenProbabilities.b).toBeCloseTo(0.75);
		expect(scores.observedLabelMass).toBeCloseTo(0.96);
		expect(scores.probabilitiesGivenAOrB?.a).toBeCloseTo(0.21 / 0.96);
		expect(scores.probabilitiesGivenAOrB?.b).toBeCloseTo(0.75 / 0.96);
	});

	test("an absent alternative is unknown, not zero or the sampled label's complement", () => {
		const scores = labelProbabilities(verdictPositions("false", -0.01), '{"violates":false}');
		expect(scores.tokenProbabilities.a).toBeNull();
		expect(scores.tokenProbabilities.b).toBeCloseTo(Math.exp(-0.01));
		expect(scores.observedLabelMass).toBeCloseTo(Math.exp(-0.01));
		expect(scores.probabilitiesGivenAOrB).toBeNull();
		expect(scores.missingLabels).toEqual(["a"]);
	});

	test("does not turn tiny label mass into high conditional confidence", () => {
		const scores = labelProbabilities(
			verdictPositions("true", Math.log(0.000009), [
				{ token: "false", logprob: Math.log(0.000001) },
				{ token: '"', logprob: Math.log(0.99999) },
			]),
			'{"violates":true}',
		);
		expect(scores.observedLabelMass).toBeCloseTo(0.00001, 10);
		expect(scores.tokenProbabilities.a).toBeCloseTo(0.000009, 10);
		expect(scores.probabilitiesGivenAOrB).toBeNull();
	});

	test("underflow does not disguise negligible label mass", () => {
		const scores = labelProbabilities(verdictPositions("true", -1000, [{ token: "false", logprob: -1001 }]), '{"violates":true}');
		expect(scores.tokenProbabilities).toEqual({ a: 0, b: 0 });
		expect(scores.observedLabelMass).toBe(0);
		expect(scores.probabilitiesGivenAOrB).toBeNull();
	});

	test("rejects malformed or impossible probabilities", () => {
		expect(() => labelProbabilities(verdictPositions("true", -0.1, [{ token: "false", logprob: NaN }]), '{"violates":true}')).toThrow();
		expect(() =>
			labelProbabilities(verdictPositions("true", Math.log(0.8), [{ token: "false", logprob: Math.log(0.7) }]), '{"violates":true}'),
		).toThrow();
		expect(() =>
			labelProbabilities(
				verdictPositions("true", -0.1, [
					{ token: "true", logprob: -0.1 },
					{ token: "true", logprob: -0.1 },
				]),
				'{"violates":true}',
			),
		).toThrow();
	});

	test("split or punctuation-merged booleans are unscorable, not partial-word probabilities", () => {
		const split = [
			{ token: '{"violates":', logprob: -0.1, top_logprobs: [] },
			{ token: "tr", logprob: -0.1, top_logprobs: [] },
			{ token: "ue", logprob: -0.1, top_logprobs: [] },
			{ token: "}", logprob: -0.1, top_logprobs: [] },
		];
		expect(() => labelProbabilities(split, '{"violates":true}')).toThrow();
		expect(() => labelProbabilities([{ token: '{"violates":true}', logprob: -0.1, top_logprobs: [] }], '{"violates":true}')).toThrow();
	});

	test("scores must cover and match the actual verdict", () => {
		expect(() => labelProbabilities(verdictPositions("true", -0.1), '{"violates":false}')).toThrow();
		expect(() => labelProbabilities([{ token: "false", logprob: -0.1, top_logprobs: [] }], '{"violates":false}')).toThrow();
	});

	test("scores the final boolean, not tokens in reasoning", () => {
		const chunks = [
			{
				delta: { reasoning_content: "true" },
				logprobs: { content: [{ token: "true", logprob: Math.log(0.9), top_logprobs: [{ token: "false", logprob: Math.log(0.1) }] }] },
			},
			{
				delta: { content: '{"violates":false}' },
				logprobs: { content: verdictPositions("false", Math.log(0.75), [{ token: "true", logprob: Math.log(0.24) }]) },
			},
		];
		const positions = chunks.flatMap((choice) => readLogprobEvent(JSON.stringify({ choices: [choice] }))?.positions ?? []);
		const scores = labelProbabilities(positions, '{"violates":false}');
		expect(scores.tokenProbabilities.a).toBeCloseTo(0.24);
		expect(scores.tokenProbabilities.b).toBeCloseTo(0.75);
		expect(scores.probabilitiesGivenAOrB?.b).toBeCloseTo(0.75 / 0.99);
	});

	test("missing final-answer logprobs do not borrow a score from reasoning", () => {
		const chunks = [
			{
				delta: { reasoning_content: "true", content: '{"violates":false}' },
				logprobs: { content: verdictPositions("true", -0.1) },
			},
			{ delta: {}, finish_reason: "stop", logprobs: null },
		];
		const positions = chunks.flatMap((choice) => readLogprobEvent(JSON.stringify({ choices: [choice] }))?.positions ?? []);
		expect(() => labelProbabilities(positions, '{"violates":false}')).toThrow();
	});
});
