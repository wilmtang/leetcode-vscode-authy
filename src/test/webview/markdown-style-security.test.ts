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

    it("keeps commas as real separators so the font list still applies", () => {
        // Escaped separators made the whole list one unknown family, so the
        // description webview fell back to the default serif font.
        assert.strictEqual(
            serializeCssFontFamily(`-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif`),
            `-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif`,
        );
        assert.strictEqual(serializeCssFontFamily(`Fira Code, "SF Mono"`), `Fira Code, "SF Mono"`);
        assert.strictEqual(serializeCssFontFamily(`Fira Code, 'SF Mono', 'Microsoft Yahei UI'`), `Fira Code, "SF Mono", "Microsoft Yahei UI"`);
    });

    it("quotes and escapes names that are not plain identifiers", () => {
        assert.strictEqual(serializeCssFontFamily(`'Font, With Comma'`), `"Font\\2c  With Comma"`);
        assert.strictEqual(serializeCssFontFamily(`3Dumb`), `"3Dumb"`);
        assert.strictEqual(serializeCssFontFamily(`微软雅黑`), `"\\5fae \\8f6f \\96c5 \\9ed1 "`);
        assert.strictEqual(serializeCssFontFamily(`Emoji 😀`), `"Emoji \\1f600 "`);
        assert.strictEqual(serializeCssFontFamily(` , ,`), ``);
    });

    it("cannot break out of the string through quotes or an unbalanced quote", () => {
        for (const value of [`'a"; } body { color: red'`, `'unterminated; } </style>`, `"x\\"; y`]) {
            const serialized: string = serializeCssFontFamily(value);
            assert.strictEqual(/[;{}<>]/.test(serialized), false, serialized);
            // Every double quote is a string delimiter we emitted, never input.
            assert.strictEqual((serialized.match(/"/g) || []).length % 2, 0, serialized);
        }
    });
});
