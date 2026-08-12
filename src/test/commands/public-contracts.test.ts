// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as assert from "assert";
import { deleteCache } from "../../commands/cache";
import { redactDiagnostic } from "../../utils/uiUtils";

describe("public command and diagnostic contracts", () => {
    it("Delete Cache invalidates and force-refreshes the catalog", async () => {
        const calls: string[] = [];
        await deleteCache(
            { invalidate: () => calls.push("invalidate") },
            { refresh: async (force?: boolean) => { calls.push(`refresh:${force}`); } },
        );
        assert.deepStrictEqual(calls, ["invalidate", "refresh:true"]);
    });

    it("redacts credential-bearing diagnostics while retaining useful context", () => {
        const diagnostic: string = redactDiagnostic(new Error(
            `request failed cookie="LEETCODE_SESSION=session-value; csrftoken=csrf-value" authorization=Bearer token-value`,
        ));
        assert.match(diagnostic, /request failed/);
        assert.strictEqual(diagnostic.includes("session-value"), false);
        assert.strictEqual(diagnostic.includes("csrf-value"), false);
        assert.strictEqual(diagnostic.includes("token-value"), false);
        assert.match(diagnostic, /\[REDACTED\]/);
    });
});
