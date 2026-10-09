import assert from "node:assert/strict";
import test from "node:test";
import { remoteWebUi } from "../lib/remote/web-ui.mjs";

/**
 * The phone page parses its own link in browser JavaScript, which Node tests
 * cannot run directly. Pull the parser out of the served HTML and run it
 * against real fragments, the way a phone's address bar would present them.
 */
function parserFromPage() {
	const html = remoteWebUi();
	const start = html.indexOf("function parseLink()");
	const end = html.indexOf("\n  }\n", start) + "\n  }\n".length;
	const source = html.slice(start, end);
	return new Function("location", "URLSearchParams", `${source}; return parseLink();`);
}

const parse = (hash) =>
	parserFromPage()({ hash }, URLSearchParams);

test("the phone page reads the session and token from a real printed link", () => {
	const link = parse("#/s/__ukTHitFKBtIBJI2H9Ojg?t=tgAXmDFiO6u_8dDNFk-YoR_kMsj7lvMXLEDbR7fSTJw");
	assert.deepEqual(link, {
		sessionId: "__ukTHitFKBtIBJI2H9Ojg",
		token: "tgAXmDFiO6u_8dDNFk-YoR_kMsj7lvMXLEDbR7fSTJw",
	});
});

test("a bare server address, with no session, is still refused", () => {
	assert.equal(parse(""), null);
	assert.equal(parse("#/"), null);
});

test("a session link without a token parses to an empty token, so the server refuses it", () => {
	assert.deepEqual(parse("#/s/abc"), { sessionId: "abc", token: "" });
});

test("the logo scales with the screen, so the 47-column banner fits every phone", () => {
	// The banner is 47 columns, sized in vw so it stays on one line. The browser
	// check measured it fitting at 390, 360 and 320 CSS pixels.
	const html = remoteWebUi();
	assert.match(html, /font-size: min\(12px, 3\.1vw\)/);
});

test("the page keeps its text plain: no transcript text is ever written as HTML", () => {
	// Messages from the agent and the phone go through textContent, so model
	// output cannot inject markup. A stray innerHTML on transcript text would
	// make the page an injection point.
	const html = remoteWebUi();
	const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
	assert.doesNotMatch(script, /\.innerHTML\s*=\s*(?!"")(?!'')[^;]*(entry|msg|text|event)/i);
});

