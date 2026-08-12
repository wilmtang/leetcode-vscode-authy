import * as assert from "assert";
import { markdownEngine } from "../../webview/markdownEngine";

describe("selective markdown highlighting", () => {
    it("highlights a supported language", () => {
        const html: string = markdownEngine.render("```typescript\nconst answer: number = 42;\n```");
        assert.ok(html.indexOf("hljs-keyword") >= 0);
    });

    it("escapes unknown fenced languages as plaintext", () => {
        const html: string = markdownEngine.render("```unknown-language\n<script>alert(1)</script>\n```");
        assert.ok(html.indexOf("<script>") < 0);
        assert.ok(html.indexOf("&lt;script&gt;") >= 0);
    });
});
