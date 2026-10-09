import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { summariseTestOutput } from "../lib/testrun.mjs";

/**
 * Run tests: the agent runs the project's own `npm test`, then reads only the
 * failures. It takes no command from the model, so this tool cannot be used to
 * run arbitrary shell.
 *
 * On Windows, npm is a .cmd shim that cannot be spawned directly without a
 * shell, so the command goes through cmd.exe. A spawn that fails is reported as
 * an error, never as an empty result.
 */
let pi: ExtensionAPI;

const runTests = defineTool({
	name: "run_tests",
	label: "Run tests",
	description:
		"Run the project's test suite (npm test) and return only the failing tests with their error messages. Use after changing code to check what broke.",
	parameters: Type.Object({}),

	async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
		const result =
			process.platform === "win32"
				? await pi.exec("cmd.exe", ["/d", "/s", "/c", "npm", "test", "--silent"], { cwd: ctx.cwd, signal, timeout: 180_000 })
				: await pi.exec("npm", ["test", "--silent"], { cwd: ctx.cwd, signal, timeout: 180_000 });

		if (result.code === null || (result.code !== 0 && !result.stdout && !result.stderr)) {
			return {
				content: [{ type: "text", text: "The test command could not run. Check that npm is installed and the project has a test script." }],
				details: { passed: false, failureCount: 0, error: "spawn" },
			};
		}

		const summary = summariseTestOutput(`${result.stdout}\n${result.stderr}`, result.code);
		return {
			content: [{ type: "text", text: summary.report }],
			details: { passed: summary.passed, failureCount: summary.failureCount },
		};
	},
});

export default function (api: ExtensionAPI) {
	pi = api;
	pi.registerTool(runTests);
}