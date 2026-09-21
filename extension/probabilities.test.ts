import { describe, expect, test } from "bun:test";
import { labelProbabilities } from "./probabilities";

describe("label token probabilities", () => {
	test("combines casing/whitespace variants and normalizes only the observed a/b masses", () => {
		const scores = labelProbabilities([
			{ token: "\n", logprob: -0.1, top_logprobs: [] },
			{
				token: "B",
				logprob: Math.log(0.6),
				top_logprobs: [
					{ token: "B", logprob: Math.log(0.6) },
					{ token: " b", logprob: Math.log(0.1) },
					{ token: "a", logprob: Math.log(0.2) },
					{ token: "c", logprob: Math.log(0.1) },
				],
			},
		]);
		expect(scores.tokenProbabilities.a).toBeCloseTo(0.2);
		expect(scores.tokenProbabilities.b).toBeCloseTo(0.7);
		expect(scores.probabilitiesGivenAOrB?.a).toBeCloseTo(2 / 9);
		expect(scores.probabilitiesGivenAOrB?.b).toBeCloseTo(7 / 9);
	});

	test("an absent alternative is unknown, not zero or the sampled label's complement", () => {
		const scores = labelProbabilities([{ token: "b", logprob: -0.1, top_logprobs: [] }]);
		expect(scores.tokenProbabilities.a).toBeNull();
		expect(scores.tokenProbabilities.b).toBeCloseTo(Math.exp(-0.1));
		expect(scores.probabilitiesGivenAOrB).toBeNull();
		expect(scores.missingLabels).toEqual(["a"]);
	});

	test("conditional scores survive raw-probability underflow", () => {
		const scores = labelProbabilities([{ token: "a", logprob: -1000, top_logprobs: [{ token: "b", logprob: -1001 }] }]);
		expect(scores.tokenProbabilities).toEqual({ a: 0, b: 0 });
		expect(scores.probabilitiesGivenAOrB?.a).toBeCloseTo(0.7310585786300049);
	});

	test("rejects non-finite scores instead of printing manufactured probabilities", () => {
		expect(() => labelProbabilities([{ token: "a", logprob: -0.1, top_logprobs: [{ token: "b", logprob: NaN }] }])).toThrow();
	});

	test("rejects ambiguous multi-token labels and duplicate probability entries", () => {
		expect(() =>
			labelProbabilities([
				{ token: "a", logprob: -0.1, top_logprobs: [] },
				{ token: "b", logprob: -0.2, top_logprobs: [] },
			]),
		).toThrow();
		expect(() =>
			labelProbabilities([
				{
					token: "a",
					logprob: -0.1,
					top_logprobs: [
						{ token: "a", logprob: -0.1 },
						{ token: "a", logprob: -0.1 },
					],
				},
			]),
		).toThrow();
	});
});
