// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as cp from "child_process";
import * as os from "os";

export interface IAuthSyncPortConflict {
    port: number;
    summary: string;
    details: string;
    inspectCommand: string;
    stopCommand?: string;
}

export async function describePortOwner(port: number): Promise<IAuthSyncPortConflict> {
    const platform: NodeJS.Platform = os.platform();
    if (platform === "win32") {
        return describeWindowsPortOwner(port);
    }

    return describeUnixPortOwner(port);
}

async function describeUnixPortOwner(port: number): Promise<IAuthSyncPortConflict> {
    const inspectCommand: string = `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
    const output: ICommandOutput = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    const parsed: IParsedProcess | undefined = parseLsofOutput(output.stdout);
    const summary: string = parsed
        ? `${parsed.command} (PID ${parsed.pid})`
        : "another program";
    const stopCommand: string | undefined = parsed ? `kill ${parsed.pid}` : "kill <PID>";
    const details: string = [
        `Port ${port} is already used by ${summary}.`,
        "",
        "Inspect command:",
        inspectCommand,
        "",
        "Stop command, after confirming the process is safe to stop:",
        stopCommand,
        "",
        "Detected listener:",
        output.stdout.trim() || output.stderr.trim() || output.errorMessage || "No process details were returned.",
    ].join("\n");

    return { port, summary, details, inspectCommand, stopCommand };
}

async function describeWindowsPortOwner(port: number): Promise<IAuthSyncPortConflict> {
    const inspectCommand: string = `netstat -ano | findstr ":${port}"`;
    const output: ICommandOutput = await runCommand("cmd.exe", ["/d", "/c", inspectCommand]);
    const pid: string | undefined = parseNetstatPid(output.stdout);
    const taskOutput: ICommandOutput | undefined = pid
        ? await runCommand("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "LIST"])
        : undefined;
    const imageName: string | undefined = taskOutput ? parseTasklistImageName(taskOutput.stdout) : undefined;
    const summary: string = pid
        ? `${imageName || "process"} (PID ${pid})`
        : "another program";
    const stopCommand: string | undefined = pid ? `taskkill /PID ${pid} /F` : "taskkill /PID <PID> /F";
    const details: string = [
        `Port ${port} is already used by ${summary}.`,
        "",
        "Inspect command:",
        inspectCommand,
        pid ? `tasklist /FI "PID eq ${pid}" /FO LIST` : "tasklist /FI \"PID eq <PID>\" /FO LIST",
        "",
        "Stop command, after confirming the process is safe to stop:",
        stopCommand,
        "",
        "Detected listener:",
        output.stdout.trim() || output.stderr.trim() || output.errorMessage || "No process details were returned.",
        taskOutput ? taskOutput.stdout.trim() : "",
    ].filter((line: string) => line !== "").join("\n");

    return { port, summary, details, inspectCommand, stopCommand };
}

function runCommand(command: string, args: string[]): Promise<ICommandOutput> {
    return new Promise<ICommandOutput>((resolve: (output: ICommandOutput) => void) => {
        cp.execFile(command, args, { timeout: 3000, maxBuffer: 64 * 1024 }, (error: cp.ExecException | null, stdout: string, stderr: string) => {
            resolve({
                stdout,
                stderr,
                errorMessage: error ? error.message : undefined,
            });
        });
    });
}

function parseLsofOutput(output: string): IParsedProcess | undefined {
    const lines: string[] = output.split(/\r?\n/).filter((line: string) => !!line.trim());
    if (lines.length < 2) {
        return undefined;
    }

    const fields: string[] = lines[1].trim().split(/\s+/);
    if (fields.length < 2) {
        return undefined;
    }

    return { command: fields[0], pid: fields[1] };
}

function parseNetstatPid(output: string): string | undefined {
    const line: string | undefined = output.split(/\r?\n/).find((candidate: string) => candidate.includes("LISTEN"));
    if (!line) {
        return undefined;
    }

    const fields: string[] = line.trim().split(/\s+/);
    return fields.length > 0 ? fields[fields.length - 1] : undefined;
}

function parseTasklistImageName(output: string): string | undefined {
    const match: RegExpMatchArray | null = output.match(/Image Name:\s*(.+)/i);
    return match && match[1] ? match[1].trim() : undefined;
}

interface ICommandOutput {
    stdout: string;
    stderr: string;
    errorMessage?: string;
}

interface IParsedProcess {
    command: string;
    pid: string;
}
