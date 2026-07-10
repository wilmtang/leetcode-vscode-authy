// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as vscode from "vscode";

class LeetCodeChannel implements vscode.Disposable {
    private readonly channel: vscode.OutputChannel = vscode.window.createOutputChannel("LeetCode");

    public appendLine(message: string): void {
        this.channel.appendLine(message);
    }

    public append(message: string): void {
        this.channel.append(message);
    }

    public show(): void {
        this.channel.show();
    }

    public dispose(): void {
        this.channel.dispose();
    }
}

export const leetCodeChannel: LeetCodeChannel = new LeetCodeChannel();
