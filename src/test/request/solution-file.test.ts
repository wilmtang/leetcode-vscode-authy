import * as assert from "assert";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { DirectApiUnsupportedError, ISolutionFileMeta, parseSolutionFile } from "../../request/leetcode-http";

// These tests pin the current behavior of the solution-file parser that the
// already-migrated submit/test path relies on. They are the safety net for the
// Phase 4 template-generation work: when the extension starts generating files
// itself, the slug must keep round-tripping through this parser.
describe("parseSolutionFile", () => {
    let tempDir: string;

    before(async () => {
        tempDir = await fse.mkdtemp(path.join(os.tmpdir(), "lc-solution-"));
    });

    after(async () => {
        await fse.remove(tempDir);
    });

    async function writeSolution(fileName: string, lines: string[]): Promise<string> {
        const filePath: string = path.join(tempDir, fileName);
        await fse.outputFile(filePath, lines.join("\n"));
        return filePath;
    }

    it("recovers the slug from an embedded problem URL", async () => {
        const filePath: string = await writeSolution("1.two-sum.cpp", [
            "/*",
            " * @lc app=leetcode id=1 lang=cpp",
            " *",
            " * [1] Two Sum",
            " *",
            " * https://leetcode.com/problems/two-sum/",
            " */",
            "// @lc code=start",
            "class Solution {};",
            "// @lc code=end",
            "",
        ]);

        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        assert.strictEqual(meta.frontendId, "1");
        assert.strictEqual(meta.lang, "cpp");
        assert.strictEqual(meta.slug, "two-sum");
        assert.strictEqual(meta.code, "class Solution {};");
    });

    it("falls back to the <id>.<slug>.<ext> filename when no URL is present", async () => {
        const filePath: string = await writeSolution("1.two-sum.cpp", [
            "// @lc app=leetcode id=1 lang=cpp",
            "// @lc code=start",
            "class Solution {};",
            "// @lc code=end",
            "",
        ]);

        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        assert.strictEqual(meta.slug, "two-sum");
    });

    it("returns the whole file as code when @lc code markers are absent", async () => {
        const lines: string[] = [
            "// @lc app=leetcode id=1 lang=cpp",
            "// https://leetcode.com/problems/two-sum/",
            "class Solution {};",
            "",
        ];
        const filePath: string = await writeSolution("1.two-sum.cpp", lines);

        const meta: ISolutionFileMeta = await parseSolutionFile(filePath);
        assert.strictEqual(meta.code, lines.join("\n"));
    });

    it("throws when the slug cannot be inferred (no URL and a custom filename)", async () => {
        const filePath: string = await writeSolution("twoSum.cpp", [
            "// @lc app=leetcode id=1 lang=cpp",
            "// @lc code=start",
            "class Solution {};",
            "// @lc code=end",
            "",
        ]);

        await assert.rejects(parseSolutionFile(filePath), (error: unknown) => {
            assert.ok(error instanceof DirectApiUnsupportedError);
            assert.ok(/slug/i.test((error as Error).message));
            return true;
        });
    });

    it("throws when the @lc metadata header is missing", async () => {
        const filePath: string = await writeSolution("1.two-sum.cpp", [
            "class Solution {};",
            "",
        ]);

        await assert.rejects(parseSolutionFile(filePath), (error: unknown) => {
            assert.ok(error instanceof DirectApiUnsupportedError);
            assert.ok(/metadata/i.test((error as Error).message));
            return true;
        });
    });
});
