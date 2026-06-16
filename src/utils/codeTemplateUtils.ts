// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

const cStyleCommentLanguages: Set<string> = new Set([
    "c",
    "cpp",
    "csharp",
    "golang",
    "java",
    "javascript",
    "kotlin",
    "php",
    "rust",
    "scala",
    "swift",
    "typescript",
]);

const singleLineCommentByLanguage: Map<string, string> = new Map([
    ["bash", "#"],
    ["mysql", "--"],
    ["python", "#"],
    ["python3", "#"],
    ["ruby", "#"],
]);

export interface ICommentStyle {
    start: string;
    line: string;
    end: string;
    singleLine: string;
}

// Mirrors vsc-leetcode-cli's helper.langToCommentStyle so the files this
// extension now generates itself keep the exact comment framing the CLI used
// (and that parseSolutionFile / getNodeIdFromFile still parse).
export function getCommentStyle(language: string): ICommentStyle {
    if (cStyleCommentLanguages.has(language)) {
        return { start: "/*", line: " *", end: " */", singleLine: "//" };
    }

    const marker: string = singleLineCommentByLanguage.get(language) || "#";
    return { start: marker, line: marker, end: marker, singleLine: marker };
}

