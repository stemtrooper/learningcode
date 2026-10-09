/**
 * Pull the failures out of a test run's output, so the agent can read the
 * useful part instead of a whole log. Understands Node's test runner (the
 * "not ok" lines), and pytest / Jest-style "FAIL" and "FAILED" lines. Anything
 * else falls back to the last lines of output, which usually hold the summary.
 */
const MAX_FAILURES = 8;
const MAX_CHARS = 2000;

export function summariseTestOutput(output, exitCode) {
	const text = String(output ?? "");
	const lines = text.split(/\r?\n/);
	const failures = [];

	for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i += 1) {
		const line = lines[i];
		// Node test runner: "not ok 3 - the name"
		const node = line.match(/^\s*not ok \d+ - (.+)$/);
		// pytest / Jest: "FAILED tests/x.py::name" or "FAIL src/x.test.js"
		const other = line.match(/^\s*(?:FAILED|FAIL)\s+(\S.*)$/);
		const name = node?.[1] ?? other?.[1];
		if (name) {
			// Keep the next few lines: the error message usually follows.
			const detail = lines.slice(i + 1, i + 6).filter((l) => l.trim()).join("\n");
			failures.push({ name: name.trim(), detail: detail.trim() });
		}
	}

	const passed = exitCode === 0 && failures.length === 0;
	const tail = lines.filter((l) => l.trim()).slice(-12).join("\n");

	let report;
	if (passed) {
		report = "All tests passed.";
	} else if (failures.length) {
		report = failures
			.map((f) => `FAILED: ${f.name}${f.detail ? `\n${f.detail}` : ""}`)
			.join("\n\n");
	} else {
		report = `Tests failed (exit ${exitCode ?? "?"}). Last lines of output:\n${tail}`;
	}

	return {
		passed,
		failureCount: failures.length,
		report: report.length > MAX_CHARS ? `${report.slice(0, MAX_CHARS)}\n[...trimmed]` : report,
	};
}