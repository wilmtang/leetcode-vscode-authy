import * as assert from "assert";
import { renderDescriptionHtml } from "../../webview/textRenderer";

// textRenderer only depends on katex (no vscode), so it runs under the offline
// harness. These pin the two behaviours that matter: LaTeX gets rendered, and
// obvious script-injection vectors in the untrusted description are stripped.
describe("renderDescriptionHtml", () => {
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

    it("keeps LeetCode iframes but drops foreign ones", () => {
        const kept: string = renderDescriptionHtml(`<iframe src="https://leetcode.com/playground/x/shared"></iframe>`);
        assert.ok(kept.indexOf("<iframe") >= 0, "LeetCode iframe should be preserved");
        const dropped: string = renderDescriptionHtml(`<iframe src="https://evil.example.com/x"></iframe>`);
        assert.ok(dropped.indexOf("<iframe") < 0, "foreign iframe should be removed");
    });

    it("wraps <pre> blocks in <code> for highlighting", () => {
        const html: string = renderDescriptionHtml("<pre>nums = [2,7,11,15]</pre>");
        assert.ok(html.indexOf("<pre><code>") >= 0, "expected <pre><code> wrapping");
    });
});
