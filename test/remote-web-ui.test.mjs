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

test("the header names the product in plain text, not block art", () => {
	const html = remoteWebUi();
	assert.match(html, /<div class="logo"[^>]*>LEARNINGCODE<\/div>/);
	assert.doesNotMatch(html, /██/, "no block-character art in the header");
});

test("the page keeps its text plain: no transcript text is ever written as HTML", () => {
	// Messages from the agent and the phone go through textContent, so model
	// output cannot inject markup. A stray innerHTML on transcript text would
	// make the page an injection point.
	const html = remoteWebUi();
	const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
	assert.doesNotMatch(script, /\.innerHTML\s*=\s*(?!"")(?!'')[^;]*(entry|msg|text|event)/i);
});


test("the empty state is a narrow centred paragraph, not full-width type", () => {
	// A phone screenshot showed the no-link sentence stretched across the whole
	// width in ragged columns. The empty paragraph must cap its own measure
	// and centre, whatever the viewport does.
	const html = remoteWebUi();
	assert.match(html, /\.empty\s*\{[^}]*max-width:\s*34ch/);
	assert.match(html, /\.empty\s*\{[^}]*text-align:\s*center/);
	assert.match(html, /text-size-adjust:\s*100%/);
});

test("a project folder named learningcode does not repeat the brand", () => {
	// The header already says LEARNINGCODE; meta.name is often the checkout
	// folder, i.e. the same word again. The page must fall back to "remote".
	const html = remoteWebUi();
	assert.match(html, /learningcode.*remote|remote.*learningcode/i);
	assert.match(html, /\^learningcode\$/i);
});

test("the model button remembers its label across reloads", () => {
	// Until the first models frame arrives over a slow tunnel, "choose model"
	// reads as if nothing were selected. The label persists in localStorage.
	const html = remoteWebUi();
	assert.match(html, /lc-model-name/);
});

test("the composer shows when the computer cannot hear you", () => {
	const html = remoteWebUi();
	assert.match(html, /form\.offline #text/);
});
