import type { Model } from "@oh-my-pi/pi-ai";

/** Let the provider accept or reject explicit off, rather than silently upgrading it to low effort. */
export function modelForThinking(model: Model, enabled: boolean): Model {
	if (enabled || !model.thinking?.requiresEffort) return model;
	// Catalog floors can be stricter than the endpoint (for example, OpenRouter Kimi K3).
	return { ...model, thinking: { ...model.thinking, requiresEffort: false } };
}
