// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as cp from "child_process";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";

interface IExecError extends Error {
    result?: string;
}

export async function executeCommand(command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
    return new Promise((resolve: (res: string) => void, reject: (e: Error) => void): void => {
        let result: string = "";

        const childProc: cp.ChildProcess = cp.spawn(command, args, { ...options, env: createEnvOption() });

        childProc.stdout?.on("data", (data: string | Buffer) => {
            data = data.toString();
            result = result.concat(data);
            leetCodeChannel.append(data);
        });

        childProc.stderr?.on("data", (data: string | Buffer) => leetCodeChannel.append(data.toString()));

        childProc.on("error", reject);

        childProc.on("close", (code: number) => {
            // leetcode-cli sometimes prints a "[ERROR] ..." line while exiting 0; match that marker
            // specifically instead of any "ERROR" substring, which can appear in problem content.
            if (code !== 0 || /\[ERROR\]/i.test(result)) {
                const error: IExecError = new Error(`Command "${command} ${args.toString()}" failed with exit code "${code}".`);
                if (result) {
                    error.result = result; // leetcode-cli may print useful content by exit with error code
                }
                reject(error);
            } else {
                resolve(result);
            }
        });
    });
}

export async function executeCommandWithProgress(message: string, command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
    let result: string = "";
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (p: vscode.Progress<{}>) => {
        return new Promise<void>(async (resolve: () => void, reject: (e: Error) => void): Promise<void> => {
            p.report({ message });
            try {
                result = await executeCommand(command, args, options);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
    return result;
}

// clone process.env and add http proxy
export function createEnvOption(): {} {
    const proxy: string | undefined = getHttpAgent();
    if (proxy) {
        const env: any = Object.create(process.env);
        env.http_proxy = proxy;
        return env;
    }
    return process.env;
}

function getHttpAgent(): string | undefined {
    return vscode.workspace.getConfiguration("http").get<string>("proxy");
}
