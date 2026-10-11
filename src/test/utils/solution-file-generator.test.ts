import * as assert from "assert";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { mapQuestionDetail } from "../../request/leetcode-api";
import { ISolutionFileMeta, parseSolutionFile } from "../../request/leetcode-http";
import { generateSolutionFileContent, htmlToCommentLines, htmlToPlainText } from "../../utils/solutionFileGenerator";
import { getNodeIdFromFile } from "../../utils/problemUtils";
import { extractSolutionCode } from "../../utils/solutionDocument";
import { questionDetailItem } from "../fixtures/leetcode-responses";

// The Phase 4 safety net: files this extension now generates itself must keep
// round-tripping the slug through the already-migrated submit/test parser, for
// BOTH the default <id>.<slug>.<ext> filename and arbitrary custom filenames.
// The slug-hardening fix (embedding the canonical URL in the @lc header) is what
// makes the custom-filename case work.
describe("generateSolutionFileContent", () => {
    it("extracts only the generated block for every supported comment style", () => {
        for (const language of ["c", "cpp", "csharp", "golang", "java", "javascript", "kotlin", "php", "rust", "scala", "swift", "typescript", "bash", "mysql", "python", "python3", "ruby"]) {
            const content = generateSolutionFileContent({
                detail: { ...mapQuestionDetail(questionDetailItem, false), codeSnippets: [{ lang: language, langSlug: language, code: "BODY" }] },
                language, frontendId: "1", showDescriptionInComment: false, endpointBase: "https://leetcode.com",
            });
            assert.strictEqual(extractSolutionCode(`${content}\nOUTSIDE`).trim(), "BODY", language);
        }
        assert.strictEqual(extractSolutionCode("SELECT 1;"), "SELECT 1;", "legacy markerless SQL is preserved");
        assert.strictEqual(extractSolutionCode("-- @lc code=end\n-- @lc code=start\nSELECT 1;\n-- @lc code=end\nDROP TABLE x;"), "SELECT 1;");
    });
    const detail = mapQuestionDetail(questionDetailItem, false);
    let tempDir: string;

    before(async () => {
        tempDir = await fse.mkdtemp(path.join(os.tmpdir(), "lc-gen-"));
    });

    after(async () => {
        await fse.remove(tempDir);
    });

    async function writeGenerated(fileName: string, showDescriptionInComment: boolean): Promise<string> {
        const content: string = generateSolutionFileContent({
            detail,
            language: "cpp",
            frontendId: "1",
            showDescriptionInComment,
            endpointBase: "https://leetcode.com",
        });
        const filePath: string = path.join(tempDir, fileName);
        await fse.outputFile(filePath, content);
        return filePath;
    }

    it("embeds the canonical problem URL and the right @lc header", async () => {
        const content: string = generateSolutionFileContent({
            detail,
            language: "cpp",
            frontendId: "1",
            showDescriptionInComment: false,
            endpointBase: "https://leetcode.com",
        });
        assert.ok(content.indexOf("@lc app=leetcode id=1 lang=cpp") >= 0, "missing @lc header");
        assert.ok(content.indexOf("https://leetcode.com/problems/two-sum/") >= 0, "missing canonical URL");
        assert.ok(content.indexOf("// @lc code=start") >= 0, "missing code start marker");
        assert.ok(content.indexOf("// @lc code=end") >= 0, "missing code end marker");
        assert.ok(content.indexOf("class Solution {};") >= 0, "missing the cpp code snippet");
    });

    it("round-trips the slug through parseSolutionFile for the default filename", async () => {
        const filePath: string = await writeGenerated("1.two-sum.cpp", false);
        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        assert.strictEqual(meta.frontendId, "1");
        assert.strictEqual(meta.lang, "cpp");
        assert.strictEqual(meta.slug, "two-sum");
        assert.strictEqual(meta.code, "class Solution {};");
    });

    it("round-trips the slug through parseSolutionFile for a custom filename (slug hardening)", async () => {
        // Without the embedded URL this would fail: a ${camelCaseName} filename
        // carries no <id>.<slug>.<ext> for parseSlug's filename fallback.
        const filePath: string = await writeGenerated("twoSum.cpp", false);
        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        assert.strictEqual(meta.slug, "two-sum");
        assert.strictEqual(meta.code, "class Solution {};");
    });

    it("keeps the slug round-trip when the description is embedded in the comment", async () => {
        const filePath: string = await writeGenerated("customName.cpp", true);
        const content: string = await fse.readFile(filePath, "utf8");
        assert.ok(content.indexOf("English content") >= 0, "expected the description text in the comment");
        assert.ok(content.indexOf("Testcase Example:") >= 0, "expected the testcase example line");
        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        assert.strictEqual(meta.slug, "two-sum");
        assert.strictEqual(meta.code, "class Solution {};");
    });

    it("produces a file whose frontend id is recoverable by getNodeIdFromFile", async () => {
        const filePath: string = await writeGenerated("1.two-sum.cpp", false);
        const id: string = await getNodeIdFromFile(filePath);
        assert.strictEqual(id, "1");
    });

    it("uses #-style comments for python3", () => {
        const content: string = generateSolutionFileContent({
            detail,
            language: "python3",
            frontendId: "1",
            showDescriptionInComment: false,
            endpointBase: "https://leetcode.com",
        });
        assert.ok(content.indexOf("# @lc app=leetcode id=1 lang=python3") >= 0, "missing #-style @lc header");
        assert.ok(content.indexOf("# @lc code=start") >= 0, "missing #-style code marker");
        assert.ok(content.indexOf("class Solution: pass") >= 0, "missing the python3 snippet");
    });
});

describe("htmlToPlainText", () => {
    it("strips tags, decodes entities and turns <sup> into ^", () => {
        const text: string = htmlToPlainText("<p>2<sup>31</sup> &lt;= x &amp; y &nbsp;&gt; 0</p>");
        assert.strictEqual(text, "2^31 <= x & y  > 0");
    });

    it("breaks block elements onto separate lines", () => {
        const text: string = htmlToPlainText("<p>line one</p><p>line two</p>");
        assert.deepStrictEqual(text.split("\n"), ["line one", "line two"]);
    });
});

describe("htmlToCommentLines", () => {
    it("word-wraps long paragraphs to the given width", () => {
        const html: string = `<p>${"word ".repeat(40).trim()}</p>`;
        const lines: string[] = htmlToCommentLines(html, 30);
        assert.ok(lines.length > 1, "expected the long paragraph to wrap");
        for (const line of lines) {
            assert.ok(line.length <= 30, `line exceeded width: "${line}"`);
        }
    });
});
