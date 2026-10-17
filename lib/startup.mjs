/**
 * Startup latency budget.
 *
 * Cold start is part of the experience: a student waiting on a prompt that has
 * not appeared yet has no idea whether the tool is thinking or broken. The
 * launcher may do file work before it hands off to Pi, but it must not wait on
 * the network. The one piece of networking on that path is a Spark
 * reachability probe, and it earns a warning, not a delay — so it is given a
 * small budget instead of the request's full timeout.
 *
 * These numbers are asserted by test/startup.test.mjs the way installer.test.mjs
 * asserts the Node floor: a budget in code, checked by test.
 */

/** Ceiling for the launcher's own cold start (module load, parse, config), in ms. */
export const STARTUP_BUDGET_MS = 2000;

/**
 * How long the Spark preflight may hold up startup, in ms. Deliberately far
 * below CHECK_TIMEOUT_MS (5s): a healthy probe answers in tens of ms, and a
 * slow one is abandoned rather than shown. The first request, plus the /quota
 * and /seats errors, already report a real outage in plain words.
 */
export const STARTUP_HEALTH_BUDGET_MS = 350;

/** The probe's own request timeout, so the two numbers can be compared. */
export const CHECK_TIMEOUT_MS = 5000;

/**
 * Resolve to `promise`'s value only if it settles within `ms`; otherwise null.
 * A rejection is treated the same as a slow answer: nothing here is worth
 * delaying a prompt for.
 */
export function withinBudget(promise, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}
