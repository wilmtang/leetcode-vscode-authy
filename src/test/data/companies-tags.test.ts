import * as assert from "assert";
import { COMPANIES, TAGS } from "../../data/companiesTags";

// Guards the vendored static snapshot extracted from vsc-leetcode-cli's
// company.js. It is the data source that keeps the Company/Tag explorer trees
// alive after the CLI list path is removed, so a corrupted/truncated table
// should fail loudly here rather than silently emptying the trees.
describe("vendored companies/tags data", () => {
    it("exposes a large, frontend-id-keyed company table", () => {
        assert.ok(Object.keys(COMPANIES).length > 400, `expected a large company table, got ${Object.keys(COMPANIES).length}`);
        assert.deepStrictEqual(
            COMPANIES["1"],
            ["adobe", "airbnb", "amazon", "apple", "bloomberg", "dropbox", "facebook", "linkedin", "microsoft", "uber", "yahoo", "yelp"],
        );
    });

    it("exposes a large, frontend-id-keyed tag table", () => {
        assert.ok(Object.keys(TAGS).length > 900, `expected a large tag table, got ${Object.keys(TAGS).length}`);
        assert.deepStrictEqual(TAGS["1"], ["array", "hash-table"]);
        assert.deepStrictEqual(TAGS["2"], ["linked-list", "math"]);
    });
});
