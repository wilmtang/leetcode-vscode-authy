import * as assert from "assert";
import * as path from "path";
import { resolvePathWithinRoot, sanitizePathSegment } from "../../utils/workspaceUtils";

describe("workspace path safety", () => {
    it("keeps a generated path inside the selected workspace", () => {
        const root: string = path.resolve("/tmp/leetcode-workspace");
        const result: string = resolvePathWithinRoot(root, path.join(root, "src", "1.two-sum.ts"));
        assert.strictEqual(result, path.join(root, "src", "1.two-sum.ts"));
    });

    it("rejects configured parent traversal", () => {
        const root: string = path.resolve("/tmp/leetcode-workspace");
        assert.throws(
            () => resolvePathWithinRoot(root, path.join(root, "..", "outside.ts")),
            /escapes the selected LeetCode workspace/,
        );
    });

    it("allows an in-workspace segment whose name merely starts with two dots", () => {
        const root: string = path.resolve("/tmp/leetcode-workspace");
        assert.strictEqual(
            resolvePathWithinRoot(root, path.join(root, "..notes", "solution.ts")),
            path.join(root, "..notes", "solution.ts"),
        );
    });

    it("turns remote path separators and reserved characters into one segment", () => {
        const sanitized: string = sanitizePathSegment("../Two/Sum:<draft>?");
        assert.ok(sanitized.indexOf("/") < 0);
        assert.ok(sanitized.indexOf("\\") < 0);
        assert.ok(sanitized.indexOf(":") < 0);
        assert.notStrictEqual(sanitized, "..");
    });
});
