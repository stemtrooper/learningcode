import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the opt-in end-to-end suites: remote parity and sub-agents.
 *
 * Both are gated because they spawn a real Pi process. This wrapper sets the
 * gates in a way that works on Windows too: npm scripts run through cmd.exe
 * there, where a `VAR=value command` prefix is a syntax error rather than an
 * assignment.
 */
const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
	process.execPath,
	[
		"--test",
		join(here, "..", "test", "remote-e2e.test.mjs"),
		join(here, "..", "test", "subagent-e2e.test.mjs"),
	],
	{
		stdio: "inherit",
		env: {
			...process.env,
			LEARNINGCODE_REMOTE_E2E: "1",
			LEARNINGCODE_SUBAGENT_E2E: "1",
		},
	},
);
process.exit(result.status ?? 1);
