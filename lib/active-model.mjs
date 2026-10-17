/**
 * The model a session is actually running on.
 *
 * Shared by the footer (which prints it) and the sub-agent gate (which refuses
 * to fan out on Spark). Pi hands every extension a live `ctx.model`, so a
 * `/model` switch or `--model opencode-go/…` is seen immediately; nothing here
 * caches, which is what keeps the footer and the gate from disagreeing.
 *
 * The provider is read from the `provider` field, never parsed out of the model
 * id: `river/deepseek-ai/…` has more than one slash, so a split would be wrong.
 */

/** The active model as `provider/id`, or the bare id, or "no-model". */
export function activeModelId(ctx) {
	const model = ctx?.model;
	if (!model?.id) return "no-model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/** The active provider id (e.g. "tlc-spark"), or null when unknown. */
export function activeProviderId(ctx) {
	const provider = ctx?.model?.provider;
	return typeof provider === "string" && provider ? provider : null;
}
