/**
 * Session usage harvest, shared by the footer and quota pacing so the two can
 * never disagree about what a session has spent.
 *
 * Usage arrives two ways: standalone `usage` entries (model-attributed,
 * non-LLM) and, for every turn, on the assistant message itself (`message`
 * entries, the actual per-turn source). Both are harvested; the two never
 * describe the same call.
 *
 * Dollars use each call's own model catalog price ($/M tokens); cache-read
 * tokens are billed at the cache rate, the rest of input at the input rate
 * (cacheWrite is a subset of input, already counted). `dollars` is null when
 * no call has numeric rates — tokens alone must never be mistaken for a price.
 *
 * `steps` counts assistant turns only, so pacing can divide session tokens by
 * the number of steps that produced them.
 */

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function sessionSpend(entries, findModel) {
	let tokens = 0;
	let dollars = 0;
	let steps = 0;
	let priced = false;
	const attribute = (provider, model, usage, countStep) => {
		const input = num(usage.input);
		const output = num(usage.output);
		const read = Math.min(num(usage.cacheRead), input);
		tokens += input + output;
		if (countStep) steps += 1;
		const cost = findModel?.(provider ?? "", model ?? "")?.cost;
		const rates = [cost?.input, cost?.output, cost?.cacheRead];
		if (cost && rates.some((r) => typeof r === "number")) {
			priced = true;
			dollars +=
				((input - read) * num(cost.input) + read * num(cost.cacheRead) + output * num(cost.output)) / 1_000_000;
		}
	};
	for (const entry of entries ?? []) {
		if (entry?.usage) {
			attribute(entry.provider, entry.model, entry.usage, false);
			continue;
		}
		const message = entry?.message;
		if (message?.role === "assistant" && message.usage) {
			attribute(message.provider, message.model, message.usage, true);
		}
	}
	return { tokens, dollars: priced ? dollars : null, steps };
}
