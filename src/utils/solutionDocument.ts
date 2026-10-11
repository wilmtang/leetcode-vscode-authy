export const MAX_SOLUTION_HEADER_LINES: number = 200;

export interface ISolutionDocumentClassification {
    frontendId?: string;
    language?: string;
    startLine?: number;
    endLine?: number;
}

export function classifySolutionDocument(content: string): ISolutionDocumentClassification {
    const lines: string[] = content.split(/\r\n|\n|\r/);
    const headerLines: string[] = lines.slice(0, MAX_SOLUTION_HEADER_LINES);
    const metadata: RegExpMatchArray | null = headerLines.join("\n").match(/@lc\s+app=\S+\s+id=(\S+)\s+lang=(\S+)/);
    const startLine: number = lines.findIndex((line: string) => isMarkerLine(line, "start"));
    const endLine: number = startLine < 0
        ? -1
        : lines.findIndex((line: string, index: number) => index > startLine && isMarkerLine(line, "end"));
    return {
        frontendId: metadata && metadata[1] || undefined,
        language: metadata && metadata[2] || undefined,
        startLine: startLine >= 0 ? startLine : undefined,
        endLine: endLine >= 0 ? endLine : undefined,
    };
}

function isMarkerLine(line: string, marker: "start" | "end"): boolean {
    return new RegExp(`^\\s*(?://|#|--|/\\*)?\\s*@lc code=${marker}(?:\\s*\\*/)?\\s*$`).test(line);
}

export function extractSolutionCode(content: string): string {
    const classification: ISolutionDocumentClassification = classifySolutionDocument(content);
    if (classification.startLine === undefined || classification.endLine === undefined) {
        return content;
    }
    return content.split(/\r\n|\n|\r/).slice(classification.startLine + 1, classification.endLine).join("\n");
}
