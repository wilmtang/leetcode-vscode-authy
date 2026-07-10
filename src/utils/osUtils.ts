// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

export function isWindows(): boolean {
    return process.platform === "win32";
}

export function usingCmd(): boolean {
    const comSpec: string | undefined = process.env.ComSpec;
    // 'cmd.exe' is used as a fallback if process.env.ComSpec is unavailable.
    if (!comSpec) {
        return true;
    }

    if (comSpec.indexOf("cmd.exe") > -1) {
        return true;
    }
    return false;
}
