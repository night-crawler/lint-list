import type { Model } from "@oh-my-pi/pi-ai";

/** Preserve the model when enabled; otherwise allow an explicit thinking-off request to reach the provider. */
export function modelForThinking(model: Model, enabled: boolean): Model {
	if (enabled || !model.thinking?.requiresEffort) return model;
	// Catalog floors can be stricter than the endpoint (for example, OpenRouter Kimi K3).
	return { ...model, thinking: { ...model.thinking, requiresEffort: false } };
}
