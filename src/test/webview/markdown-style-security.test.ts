// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as assert from "assert";
import { serializeCssFontFamily } from "../../webview/markdownEngine";

describe("Markdown style security", () => {
    it("keeps workspace font settings inside a CSS value", () => {
        const serialized: string = serializeCssFontFamily(`</style><img src="https://example.test/leak">;url(test)`);

        assert.strictEqual(serialized.includes("</style>"), false);
        assert.strictEqual(serialized.includes("https://"), false);
        assert.strictEqual(serialized.includes(";"), false);
        assert.strictEqual(serialized.includes("("), false);
    });

    it("preserves safe family names while CSS-escaping separators and quotes", () => {
        assert.strictEqual(
            serializeCssFontFamily(`Fira Code, 'SF Mono'`),
            `Fira Code\\2c  \\27 SF Mono\\27 `,
        );
    });
});
