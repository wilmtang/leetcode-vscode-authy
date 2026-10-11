import * as assert from "assert";
import { collectMathStyles, renderDescriptionHtml, stripMarkdownHtmlComments } from "../../webview/textRenderer";

// textRenderer only depends on katex (no vscode), so it runs under the offline
// harness. These pin the two behaviours that matter: LaTeX gets rendered, and
// obvious script-injection vectors in the untrusted description are stripped.
describe("renderDescriptionHtml", () => {
    it("moves trusted math layout into CSP-compatible stylesheet rules", () => {
        const rendered = renderDescriptionHtml('<p style="color:red" data-lc-math-style="0">$$\\frac{a^2}{b} + \\sqrt{x} + \\begin{matrix}1&2\\\\3&4\\end{matrix}$$</p>');
        const result = collectMathStyles(rendered);
        assert.ok(result.css.includes("height:"));
        assert.ok(result.css.includes("vertical-align:"));
        assert.ok(!/ style=/.test(result.html));
        assert.ok(!result.css.includes("color:red"));
        assert.ok(!result.css.includes("</style>"));
        assert.ok(result.html.startsWith("<p>"), "untrusted private selectors must be removed");
    });
    it("renders inline $…$ math with KaTeX", () => {
        const html: string = renderDescriptionHtml("<p>Given $a^2 + b^2 = c^2$ holds.</p>");
        assert.ok(html.indexOf("katex") >= 0, "expected KaTeX output");
        assert.ok(html.indexOf("$a^2") < 0, "raw $-delimited source should be replaced");
    });

    it("leaves paired currency amounts as plain text (no false-positive math)", () => {
        const html: string = renderDescriptionHtml("<p>you have $5 and $3 left</p>");
        assert.ok(html.indexOf("katex") < 0, "currency should not be rendered as math");
        assert.ok(html.indexOf("$5 and $3") >= 0, "currency text should be preserved");
    });

    it("renders display $$…$$ math in display mode", () => {
        const html: string = renderDescriptionHtml("<p>$$\\sum_{i=1}^{n} i$$</p>");
        assert.ok(html.indexOf("katex-display") >= 0, "expected display-mode KaTeX output");
    });

    it("renders \\(…\\) and \\[…\\] delimiters too", () => {
        const inline: string = renderDescriptionHtml("text \\(x_i\\) text");
        assert.ok(inline.indexOf("katex") >= 0, "expected KaTeX for \\(…\\)");
        const display: string = renderDescriptionHtml("text \\[y_j\\] text");
        assert.ok(display.indexOf("katex-display") >= 0, "expected display KaTeX for \\[…\\]");
    });

    it("strips <script> tags from the description", () => {
        const html: string = renderDescriptionHtml("<p>ok</p><script>alert(1)</script>");
        assert.ok(html.indexOf("<script") < 0, "script tag should be removed");
        assert.ok(html.indexOf("alert(1)") < 0, "script body should be removed");
    });

    it("strips inline event handlers", () => {
        const html: string = renderDescriptionHtml(`<img src="https://x/y.png" onerror="alert(1)">`);
        assert.ok(html.indexOf("onerror") < 0, "event handler attribute should be removed");
    });

    it("removes dangerous quoted, unquoted, encoded, and command URL schemes", () => {
        const js: string = renderDescriptionHtml(`<a href="javascript:alert(1)">x</a>`);
        assert.ok(js.indexOf("javascript:") < 0, "javascript: URL should be neutralized");
        const file: string = renderDescriptionHtml(`<a href="file://attacker-host/share">x</a>`);
        assert.ok(file.indexOf("file:") < 0, "file: URL should be neutralized");
        const unquoted: string = renderDescriptionHtml(`<img src=javascript:alert(1)>`);
        assert.ok(unquoted.indexOf("javascript:") < 0, "unquoted javascript: URL should be removed");
        const encoded: string = renderDescriptionHtml(`<a href="javascript&#58;alert(1)">x</a>`);
        assert.ok(encoded.indexOf("javascript") < 0, "entity-encoded javascript: URL should be removed");
        const command: string = renderDescriptionHtml(`<a href="command:workbench.action.closeWindow">x</a>`);
        assert.ok(command.indexOf("command:") < 0, "command: URL should be removed");
    });

    it("drops active or navigation-capable markup", () => {
        const html: string = renderDescriptionHtml([
            `<iframe src="https://leetcode.com/playground/x/shared"></iframe>`,
            `<meta http-equiv="refresh" content="0;url=https://example.com">`,
            `<form action="https://example.com"><button>Go</button></form>`,
            `<p style="position:fixed">safe text</p>`,
        ].join(""));
        assert.ok(html.indexOf("<iframe") < 0, "iframes should be removed");
        assert.ok(html.indexOf("<meta") < 0, "meta navigation should be removed");
        assert.ok(html.indexOf("<form") < 0, "forms should be removed");
        assert.ok(html.indexOf("style=") < 0, "remote inline styles should be removed");
        assert.ok(html.indexOf("safe text") >= 0, "text inside allowed markup should remain");
    });

    it("does not restore KaTeX markup inside an HTML attribute", () => {
        const html: string = renderDescriptionHtml(`<a href="$x$">link</a>`);
        assert.ok(!/href="[^"]*<span/i.test(html), "KaTeX markup must not be injected into href");
        assert.ok(html.indexOf("katex") < 0, "attribute-delimited math should not render");
        assert.ok(html.indexOf('href="$x$"') >= 0, "attribute value should remain well-formed");
    });

    it("wraps <pre> blocks in <code> for highlighting", () => {
        const html: string = renderDescriptionHtml("<pre>nums = [2,7,11,15]</pre>");
        assert.ok(html.indexOf("<pre><code>") >= 0, "expected <pre><code> wrapping");
    });
});

describe("stripMarkdownHtmlComments", () => {
    it("drops standalone LeetCode editor-template comments", () => {
        const markdown: string = stripMarkdownHtmlComments([
            "# Intuition",
            "<!-- Describe your first thoughts on how to solve this problem. -->",
            "Use a hash map.",
        ].join("\n"));

        assert.ok(markdown.indexOf("Describe your first thoughts") < 0, "template comment should be removed");
        assert.ok(markdown.indexOf("Use a hash map.") >= 0, "solution text should be preserved");
    });
});
