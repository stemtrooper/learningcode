import { homedir } from "node:os";
import { join } from "node:path";

/**
 * An error the user caused or can act on. The launcher prints these as a single
 * line instead of a stack trace, because a student mistyping a token should not
 * be shown a JavaScript call stack.
 */
export class UserError extends Error {}

/**
 * Spark exposes exactly one model. These identifiers must match
 * `inference.model_id` in the spark repo's spark.config.yaml.
 */
export const PROVIDER_ID = "tlc-spark";
export const MODEL_ID = "TLC-Spark";

/** Public Spark deployment. Override with --base-url or LEARNINGCODE_SPARK_BASE_URL. */
export const DEFAULT_BASE_URL = "https://spark.learning.com.my/v1";

/**
 * Mirrors the Spark machine profile. `default_context_tokens` is 16384 and
 * `max_context_tokens` is 32768 in spark.config.yaml; we advertise the ceiling
 * so Pi's compaction triggers before Spark rejects the request.
 */
export const CONTEXT_WINDOW = 32768;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Env var that makes Pi read its config, models.json and sessions from our agent dir. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Read by the provider config via `"apiKey": "$SPARK_API_KEY"`. */
export const TOKEN_ENV = "SPARK_API_KEY";

/** Where the personal `spark_live_` token is cached between runs. */
export const TOKEN_FILE = "spark-token";

/**
 * Pi's floor from its own package.json engines field. npm only warns when a
 * dependency wants a newer Node, then the install succeeds and the CLI fails
 * later with something unhelpful, so learningcode checks up front.
 */
export const REQUIRED_NODE = "22.19.0";

/**
 * Compare dotted versions numerically, so "22.9.0" is below "22.19.0".
 * A leading "v" is stripped because parseInt("v22") is NaN, which would silently
 * score such a version as 0.
 */
export function compareVersions(a, b) {
	const parse = (value) =>
		value
			.trim()
			.replace(/^v/i, "")
			.split(".")
			.map((part) => {
				const n = Number.parseInt(part, 10);
				return Number.isFinite(n) ? n : 0;
			});
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Pi resolves its agent directory from PI_CODING_AGENT_DIR when set, so
 * learningcode keeps its own config instead of sharing ~/.pi with a stock Pi
 * install on the same machine.
 */
export function agentDir() {
	const override = process.env.LEARNINGCODE_DIR;
	if (override) return override.replace(/^~(?=$|\/)/, homedir());
	return join(homedir(), ".learningcode", "agent");
}

export function sparkBaseUrl() {
	const raw = process.env.LEARNINGCODE_SPARK_BASE_URL || DEFAULT_BASE_URL;
	return raw.replace(/\/+$/, "");
}