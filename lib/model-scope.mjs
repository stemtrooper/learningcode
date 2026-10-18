import { parseModelTable, visibleModelPatterns } from "./auth.mjs";

/**
 * The `/model` picker's scope is the student's, once seeded: learningcode
 * seeds `enabledModels` from the providers logged in at first launch, and
 * after that never touches it — a model they unchecked in `/scoped-models`
 * must stay unchecked. The one gap is a provider signed into *after* the seed
 * (Pi's `/login`, or `--login-provider`), whose models would otherwise never
 * appear. This decides those two cases as a pure plan so they can be tested
 * without spawning Pi, and so the launcher only pays for `pi --list-models`
 * when there is actually a decision to make.
 */

/**
 * @typedef {object} ModelScopePlan
 * @property {boolean} seed - true when no scope exists yet and `enabledModels`
 *   should be written for the first time.
 * @property {string[]|null} enabledModels - the initial scope to seed, or null
 *   when extending an existing one.
 * @property {string[]} patterns - `provider/id` pairs newly folded in (the
 *   whole scope when seeding).
 * @property {string[]} providers - provider ids to record as considered.
 */

/**
 * Decide how the persisted model scope should change for the providers logged
 * in right now.
 *
 * @param {object} args
 * @param {string[]|null|undefined} args.enabledModels - the persisted scope, or
 *   a falsy value when it has never been seeded.
 * @param {Iterable<string>} [args.scopedProviders] - provider ids already folded
 *   into the scope by an earlier launch.
 * @param {Iterable<string>} args.loggedIn - provider ids logged in right now.
 * @param {() => string} args.listModels - lazily returns raw `pi --list-models`
 *   output; called only when a decision needs the model list.
 * @returns {ModelScopePlan|null} null when the scope needs no change.
 */
export function modelScopePlan({ enabledModels = null, scopedProviders = new Set(), loggedIn, listModels }) {
	const logged = new Set(loggedIn);
	const hasScope = Array.isArray(enabledModels) && enabledModels.length > 0;

	if (!hasScope) {
		const seeded = visibleModelPatterns(listModels(), logged);
		if (!seeded) return null;
		return { seed: true, enabledModels: seeded, patterns: seeded, providers: [...logged] };
	}

	const known = new Set(scopedProviders);
	// Before this bookkeeping existed, "folded in" can only be inferred from
	// what is already in the scope. Any provider with models present was
	// considered; one with none was never shown.
	const considered = known.size ? known : new Set(enabledModels.map((pair) => String(pair).split("/")[0]));
	const newly = [...logged].filter((id) => !considered.has(id));
	// A known provider that later logs in a different spelling, or a fresh
	// install where every provider is already represented, has nothing to add —
	// but the inferred baseline still has to be persisted once.
	if (!newly.length && known.size) return null;

	const patterns = newly.length
		? parseModelTable(listModels()).filter((pair) => newly.includes(pair.split("/")[0]))
		: [];
	return { seed: false, enabledModels: null, patterns, providers: [...considered, ...newly] };
}
