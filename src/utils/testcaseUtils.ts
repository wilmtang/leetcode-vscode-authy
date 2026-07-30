// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

export function normalizeTestcase(testcase: string): string {
    return testcase.replace(/\r\n|\r/g, "\n").trim();
}

// VS Code's single-line input box cannot contain literal newlines, so the
// direct-entry UI documents "\n" as a separator. Keep that decoding at the UI
// boundary; file/API testcases may legitimately contain a JSON string escape
// and must not be rewritten.
export function decodeInlineTestcase(testcase: string): string {
    return normalizeTestcase(testcase.replace(/\\n/g, "\n"));
}
