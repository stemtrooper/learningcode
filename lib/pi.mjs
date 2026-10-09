import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_AGENT_DIR_ENV, TOKEN_ENV, sparkBaseUrl } from "./config.mjs";

/**
 * Locating and launching the Pi runtime.
 *
 * Shared by the launcher and the remote bridge so both spawn *exactly* the same
 * agent with the same arguments and environment. Before this module existed the
 * knowledge lived inside bin/learningcode.mjs, and `learningcode remote` would
 * have grown a second, quietly different copy of it.
 */

/**
 * Pi's bundled CLI entry. Going through the resolved package entry keeps this
 * working on Windows, where the .bin shim is a .cmd file that cannot be spawned
 * directly without a shell.
 *
 * Must use `import.meta.resolve`: the published package declares only an
 * `import` condition in its exports map, so `require.resolve` fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
export function resolvePiEntry() {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [];

	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		candidates.push(join(dirname(entry), "bundle", "cli.js"));
	} catch {
		/* fall through to the node_modules walk below */
	}

	// Walk up from this file in case resolution was blocked (odd global layouts,
	// pnpm-style stores, a bundled single-file install).
	let dir = here;
	for (let depth = 0; depth < 8; depth += 1) {
		candidates.push(
			join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
		);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Where this package's extensions live, resolved from this file. */
export function extensionsDir() {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");
}

/** The extensions every launch loads, in order. */
export const PI_EXTENSIONS = [
	"spark-quota.ts",
	"footer.ts",
	"banner.ts",
	"orange-cat.ts",
	"whats-new.ts",
];

/**
 * The arguments every learningcode launch forces on Pi, whatever mode it runs
 * in. `theme: null` skips the theme flags, which is what remote mode wants:
 * there is no TUI to theme there, and RPC mode rejects theme switching.
 */
export function forcedPiArgs({ model, scope = null, theme = "tlc-dark", extraFlags = [] } = {}) {
	const args = [];
	if (model) args.push("--model", model);
	// Limit the picker to providers the student is logged in to (see auth.mjs).
	if (scope?.length) args.push("--models", scope.join(","));
	if (theme) args.push("--use-theme", theme);
	args.push("--no-skills");
	for (const extension of PI_EXTENSIONS) {
		args.push("--extension", join(extensionsDir(), extension));
	}
	args.push(...extraFlags.filter(Boolean));
	return args;
}

/**
 * The environment a Pi child needs. The Spark token rides in the environment
 * rather than a config file, exactly as the launcher does, so `~/.learningcode`
 * stays free of secrets.
 */
export function agentEnvironment({ dir, token }) {
	return {
		[PI_AGENT_DIR_ENV]: dir,
		SPARK_BASE_URL: sparkBaseUrl(),
		// Unset rather than empty when not on Spark: Pi treats an empty key as
		// configured for some providers, which would shadow the Go credential.
		...(token ? { [TOKEN_ENV]: token } : {}),
	};
}
