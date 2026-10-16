import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	CONTEXT_WINDOW,
	DEFAULT_MAX_OUTPUT_TOKENS,
	PROVIDER_ID,
	MODEL_ID,
	UserError,
	sparkBaseUrl,
} from "./config.mjs";

export function modelsPath(agentDir) {
	return join(agentDir, "models.json");
}

/**
 * The TLC-Spark provider definition.
 *
 * Every `compat` flag here is load-bearing. They are not defensive padding --
 * each one corresponds to a field that Spark's OpenAI-compatible layer either
 * rejects or silently drops:
 *
 *   - `supportsDeveloperRole: false`  Spark's message union is
 *     `system | user | assistant | tool`. There is no `developer` variant, so a
 *     reasoning-capable client must send `system` instead or the turn is lost.
 *   - `maxTokensField: "max_tokens"`  Spark reads `body.max_tokens` only, so
 *     `max_completion_tokens` would be ignored and the server default used.
 *   - `supportsReasoningEffort: false`  `reasoning_effort` is not forwarded to
 *     the runtime, so sending it is a no-op that misleads Pi's level mapping.
 *   - `supportsStore: false`  `store` is not implemented.
 *
 * `reasoning: false` because Spark bills chain-of-thought tokens but never
 * forwards them to the client (`src/http/v1.ts` drops `chunk.reasoning`), so
 * Pi would expose thinking controls that can never produce output.
 */
export function providerDefinition() {
	return {
		name: "TLC Spark",
		baseUrl: sparkBaseUrl(),
		api: "openai-completions",
		// Resolved by Pi from the environment, which the launcher sets from the
		// cached personal token. Avoids writing the token into a config file.
		apiKey: "$SPARK_API_KEY",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStore: false,
		},
		models: [
			{
				id: MODEL_ID,
				name: "TLC-Spark (Qwen3.8-27B)",
				reasoning: false,
				input: ["text"],
				contextWindow: CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
}

/**
 * Read models.json as a JSON object, treating a missing file as {}. Throws a
 * UserError naming the path when it exists but is not a JSON object, so the
 * launcher can say which file is broken instead of dumping a stack.
 */
export async function readModelsJson(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") {
			throw new UserError(
				`Could not parse ${path}: ${error.message}\nFix or delete the file, then rerun.`,
			);
		}
	}
	return {};
}

/**
 * Add or refresh a provider entry in models.json. An existing entry is merged:
 * catalog models missing from an older install are appended without removing or
 * reordering the student's own entries. A student's edit always wins.
 *
 * Shared by every provider module so the merge rule lives in one place.
 */
export async function ensureProviderEntry(agentDir, providerId, definition) {
	const path = modelsPath(agentDir);
	const models = await readModelsJson(path);
	const existing = models.providers?.[providerId];
	if (existing) {
		const have = new Set((existing.models ?? []).map((m) => m?.id));
		const missing = definition.models.filter((m) => !have.has(m.id));
		if (!missing.length) return { path, created: false, added: 0 };
		existing.models = [...(existing.models ?? []), ...missing];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
		return { path, created: false, added: missing.length };
	}
	models.providers = { ...models.providers, [providerId]: definition };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return { path, created: true, added: definition.models.length };
}

/**
 * Ensure `models.json` describes TLC-Spark, without discarding edits a student
 * may have made. An existing provider entry always wins; we only fill in the
 * provider when it is absent, so a local experiment survives upgrades.
 *
 * Exception: the output cap. Installs seeded when DEFAULT_MAX_OUTPUT_TOKENS was
 * 4096 hit Pi's "Response was truncated before completion" (stopReason length)
 * on long answers. A stored value below the current default is stale, not a
 * student choice, so it is raised in place; baseUrl and any extra providers or
 * models are left alone. A value already at or above the default is kept.
 */
export async function ensureSparkProvider(agentDir) {
	const path = modelsPath(agentDir);
	const models = await readModelsJson(path);

	if (models.providers?.[PROVIDER_ID]) {
		const provider = models.providers[PROVIDER_ID];
		const model = (provider.models ?? []).find((m) => m?.id === MODEL_ID) ?? provider.models?.[0];
		let migrated = false;
		if (model) {
			if (typeof model.maxTokens !== "number" || model.maxTokens < DEFAULT_MAX_OUTPUT_TOKENS) {
				model.maxTokens = DEFAULT_MAX_OUTPUT_TOKENS;
				migrated = true;
			}
			if (typeof model.contextWindow !== "number" || model.contextWindow < CONTEXT_WINDOW) {
				model.contextWindow = CONTEXT_WINDOW;
				migrated = true;
			}
		}
		if (migrated) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
		}
		return { path, created: false, migrated };
	}

	models.providers = { ...models.providers, [PROVIDER_ID]: providerDefinition() };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return { path, created: true, migrated: false };
}

/**
 * Point an existing provider entry at a new Spark host. Used when a student
 * moves between the local bench and the public deployment.
 */
export async function retargetProvider(agentDir, baseUrl) {
	const path = modelsPath(agentDir);
	const models = await readModelsJson(path);
	const provider = models.providers?.[PROVIDER_ID];
	if (!provider) throw new UserError(`${PROVIDER_ID} is not configured in ${path}`);
	provider.baseUrl = baseUrl.replace(/\/+$/, "");
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return provider.baseUrl;
}