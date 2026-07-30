import * as assert from "assert";
import { decodeInlineTestcase, normalizeTestcase } from "../../utils/testcaseUtils";

describe("testcase normalization", () => {
    it("preserves JSON string escapes from API and file testcases", () => {
        assert.strictEqual(normalizeTestcase(`"line\\nfeed"`), `"line\\nfeed"`);
    });

    it("decodes the documented newline separator only at the input-box boundary", () => {
        assert.strictEqual(decodeInlineTestcase("[1,2]\\n3"), "[1,2]\n3");
    });
});
