import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { readPaceReserve } from "../lib/settings.mjs";

const jiti = createJiti(import.meta.url);

/** A quota endpoint stub; counts calls so we can prove the single-flight fetch. */
function stubFetch(body, { fail = false } = {}) {
	const state = { calls: 0 };
	globalThis.fetch = async () => {
		state.calls += 1;
		if (fail) throw new Error("network down");
		return { ok: true, json: async () => body };
	};
	return state;
}

/** Build the extension against a stub pi API and a mock session. */
function start(mod, { entries = [], provider = "tlc-spark" } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		model: { provider, id: provider === "tlc-spark" ? "TLC-Spark" : "muse-spark" },
		ui: { notify: (m, type) => notices.push({ m, type }) },
		sessionManager: { getEntries: () => entries },
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
	};
	mod.default(pi);
	return { handlers, commands, notices, ctx, text: () => notices.map((n) => n.m) };
}

async function withEnv(dir, pin, fn) {
	const saved = { dir: process.env.LEARNINGCODE_DIR, pin: process.env.LEARNINGCODE_PACE_RESERVE, key: process.env.SPARK_API_KEY };
	process.env.LEARNINGCODE_DIR = dir;
	process.env.SPARK_API_KEY = "spark_live_test";
	if (pin === undefined) delete process.env.LEARNINGCODE_PACE_RESERVE;
	else process.env.LEARNINGCODE_PACE_RESERVE = pin;
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries({ LEARNINGCODE_DIR: saved.dir, LEARNINGCODE_PACE_RESERVE: saved.pin, SPARK_API_KEY: saved.key })) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function scratch() {
	return mkdtemp(join(tmpdir(), "lc-pace-"));
}

test("/pace shows about how many steps are left, rounded down", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 40000, dailyTokenLimit: 250000 });
		await withEnv(dir, undefined, async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			await app.commands.get("pace").handler("", app.ctx);
			assert.match(app.text().at(-1), /about 17 more steps today/, "210000 / 12000 = 17.5 -> 17");
			assert.doesNotMatch(app.text().at(-1), /17\.5/);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the reserve round-trips: set, shown held back, then lifted", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 40000, dailyTokenLimit: 250000 });
		await withEnv(dir, undefined, async () => {
			const app = start(mod);
			const pace = app.commands.get("pace").handler;
			await app.handlers.get("session_start")({}, app.ctx);

			await pace("reserve 3", app.ctx);
			assert.match(app.text().at(-1), /Saving the last 3 steps/);
			assert.equal(await readPaceReserve(dir), 3, "persisted");

			await pace("", app.ctx);
			assert.match(app.text().at(-1), /about 14 more steps today/, "17 minus 3 kept back");
			assert.match(app.text().at(-1), /keeping the last 3 steps for later/);

			await pace("reserve off", app.ctx);
			assert.match(app.text().at(-1), /Reserve off/);
			assert.equal(await readPaceReserve(dir), 0);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a lab pin is a floor: off is refused, raising is allowed", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ paceReserve: 1 }), "utf-8");
		stubFetch({ tokensUsed: 40000, dailyTokenLimit: 250000 });
		await withEnv(dir, "3", async () => {
			const app = start(mod);
			const pace = app.commands.get("pace").handler;
			await app.handlers.get("session_start")({}, app.ctx);

			await pace("reserve off", app.ctx);
			assert.match(app.text().at(-1), /minimum of 3 steps/);
			assert.equal(await readPaceReserve(dir), 1, "off did not take");

			await pace("reserve 5", app.ctx);
			assert.equal(await readPaceReserve(dir), 5, "the student may raise it");
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("at the reserve the agent is stopped before changing files but may still read", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		const state = stubFetch({ tokensUsed: 249000, dailyTokenLimit: 250000 });
		await withEnv(dir, "3", async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			const toolCall = app.handlers.get("tool_call");

			for (const toolName of ["edit", "write", "bash"]) {
				const result = await toolCall({ toolName, input: {} }, app.ctx);
				assert.equal(result.block, true, `${toolName} is stopped`);
				assert.match(result.reason, /Stop now/, "the model is told to stop");
				assert.match(result.reason, /\/pace reserve off/);
			}
			assert.equal(await toolCall({ toolName: "read", input: {} }, app.ctx), undefined, "readers still run");
			assert.equal(state.calls, 1, "the ceiling is fetched once, not per tool");
			assert.equal(app.text().filter((m) => /stopped before changing files/.test(m)).length, 1, "told once");
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("no reserve means no stop, even with the quota nearly gone", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 249000, dailyTokenLimit: 250000 });
		await withEnv(dir, undefined, async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			assert.equal(await app.handlers.get("tool_call")({ toolName: "edit", input: {} }, app.ctx), undefined);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("at the reserve a read-only shell still runs, a destructive one does not", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 249000, dailyTokenLimit: 250000 });
		await withEnv(dir, "3", async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			const toolCall = app.handlers.get("tool_call");
			assert.equal(
				await toolCall({ toolName: "bash", input: { command: "git status" } }, app.ctx),
				undefined,
				"read-only wrap-up is allowed",
			);
			assert.equal((await toolCall({ toolName: "bash", input: { command: "rm -rf build" } }, app.ctx)).block, true);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("off Spark there is no daily quota to pace, so nothing is blocked", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 249000, dailyTokenLimit: 250000 });
		await withEnv(dir, "3", async () => {
			const app = start(mod, { provider: "opencode-go" });
			await app.handlers.get("session_start")({}, app.ctx);
			assert.equal(
				await app.handlers.get("tool_call")({ toolName: "edit", input: {} }, app.ctx),
				undefined,
				"another provider has no Spark daily limit",
			);
			await app.commands.get("pace").handler("", app.ctx);
			assert.match(app.text().at(-1), /No daily limit/);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the reserve block survives alongside plan mode, and each reason stays its own", async () => {
	const dir = await scratch();
	const pace = await jiti.import("../extensions/pace.ts");
	const planMode = await jiti.import("../extensions/plan-mode.ts");
	try {
		stubFetch({ tokensUsed: 249000, dailyTokenLimit: 250000 });
		await withEnv(dir, "3", async () => {
			const handlers = new Map();
			const commands = new Map();
			const statuses = new Map();
			const ctx = {
				hasUI: true,
				mode: "tui",
				model: { provider: "tlc-spark", id: "TLC-Spark" },
				sessionManager: { getEntries: () => [] },
				ui: {
					notify: () => {},
					setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
					setWidget: () => {},
				},
			};
			const pi = {
				on: (event, fn) => {
					if (!handlers.has(event)) handlers.set(event, []);
					handlers.get(event).push(fn);
				},
				registerCommand: (name, opts) => commands.set(name, opts),
				registerShortcut: () => {},
				getActiveTools: () => ["read", "edit", "write", "bash"],
				setActiveTools: () => {},
			};
			// Registration order matches PI_EXTENSIONS: plan mode's handler runs first.
			planMode.default(pi);
			pace.default(pi);
			// Pi runs every tool_call handler and the first block wins.
			const dispatch = async (payload) => {
				for (const fn of handlers.get("tool_call") ?? []) {
					const result = await fn(payload, ctx);
					if (result?.block) return result;
				}
				return undefined;
			};
			for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);

			// Build mode, reserve hit: plan mode allows, so the reserve must block.
			const blocked = await dispatch({ toolName: "edit", input: {} });
			assert.match(blocked.reason, /\/pace reserve off/, "the reserve reason is not swallowed");
			assert.match(blocked.reason, /Stop now/);

			// Plan mode on: its own reason wins, still never a stack or a crash.
			await commands.get("plan").handler("", ctx);
			const planned = await dispatch({ toolName: "edit", input: {} });
			assert.match(planned.reason, /Plan mode is on/);
			assert.doesNotMatch(planned.reason, /reserve/);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the reserve stop is not confused with plan mode's (distinct reason, distinct escape hatch)", async () => {
	const { stopReason } = await import("../lib/pace.mjs");
	const { STRICT_PLAN_REASON } = await import("../lib/plan-mode.mjs");
	assert.notEqual(stopReason(3), STRICT_PLAN_REASON, "the two blocks must read differently");
	assert.match(stopReason(3), /\/pace reserve off/);
	assert.match(STRICT_PLAN_REASON, /\/plan strict off/);
});

test("no daily limit reads as text, and a dead network fails open", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 1000, dailyTokenLimit: null });
		await withEnv(dir, undefined, async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			await app.commands.get("pace").handler("", app.ctx);
			assert.match(app.text().at(-1), /No daily limit/);
		});

		stubFetch(null, { fail: true });
		await withEnv(dir, "3", async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			assert.equal(
				await app.handlers.get("tool_call")({ toolName: "edit", input: {} }, app.ctx),
				undefined,
				"a failed fetch must never block work",
			);
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pace never leaks a stack, a price, or raw JSON", async () => {
	const dir = await scratch();
	const mod = await jiti.import("../extensions/pace.ts");
	try {
		stubFetch({ tokensUsed: 40000, dailyTokenLimit: 250000 });
		await withEnv(dir, "3", async () => {
			const app = start(mod);
			await app.handlers.get("session_start")({}, app.ctx);
			for (const args of ["", "reserve 4", "reserve off", "banana", "reserve -2"]) {
				await app.commands.get("pace").handler(args, app.ctx);
			}
			await app.handlers.get("tool_call")({ toolName: "edit", input: {} }, app.ctx);
			for (const message of app.text()) {
				assert.doesNotMatch(message, /\$|dollars|cost/i, message);
				assert.doesNotMatch(message, / at .*:\d+|Error:|tokensUsed|dailyTokenLimit/, message);
			}
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
