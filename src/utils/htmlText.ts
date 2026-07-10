// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal HTML-entity decoder. LeetCode descriptions use a small, stable set of
// named entities plus numeric character references; decoding them keeps the
// in-comment description readable without pulling in a heavyweight `he`-style
// dependency (which used to come transitively from the CLI).
const NAMED_ENTITIES: { [name: string]: string } = {
    amp: "&",
    apos: "'",
    copy: "©",
    deg: "°",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    le: "≤",
    ge: "≥",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    quot: "\"",
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
    lsquo: "‘",
    times: "×",
    minus: "−",
    infin: "∞",
};

export function decodeHtmlEntities(input: string): string {
    if (!input || input.indexOf("&") < 0) {
        return input;
    }

    return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match: string, body: string): string => {
        if (body.charAt(0) === "#") {
            const isHex: boolean = body.charAt(1) === "x" || body.charAt(1) === "X";
            const codePoint: number = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
            if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
                try {
                    return String.fromCodePoint(codePoint);
                } catch (error) {
                    return match;
                }
            }
            return match;
        }

        const named: string | undefined = NAMED_ENTITIES[body.toLowerCase()];
        return named !== undefined ? named : match;
    });
}
