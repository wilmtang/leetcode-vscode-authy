// Copyright (c) wilmtang. All rights reserved.
// Licensed under the MIT license.

const os = require("os");
const path = require("path");
const {
    browserExtensionPath,
    findChromeBinary,
    getDefaultChromeUserDataDir,
    getLastUsedChromeProfileDirectory,
    run,
} = require("./auth-sync-utils");

const chromeBinary = findChromeBinary();
const args = new Set(process.argv.slice(2));
const useCurrentProfile = args.has("--profile=current") || process.env.AUTH_SYNC_CHROME_PROFILE === "current";

if (!chromeBinary) {
    console.error("Could not find Google Chrome or Chromium.");
    console.error("Set CHROME_BIN=/absolute/path/to/chrome and run this script again.");
    console.error(`You can also manually load this unpacked extension: ${browserExtensionPath}`);
    process.exit(1);
}

const userDataDir = useCurrentProfile
    ? getDefaultChromeUserDataDir()
    : path.join(os.tmpdir(), "leetcode-auth-sync-chrome-profile");
const profileDirectory = useCurrentProfile ? getLastUsedChromeProfileDirectory(userDataDir) : undefined;

console.log(`Opening Chrome with ${useCurrentProfile ? "your current profile" : "a disposable profile"} and the unpacked auth-sync extension loaded.`);
console.log(`Extension path: ${browserExtensionPath}`);
console.log(`Profile path: ${userDataDir}`);
if (profileDirectory) {
    console.log(`Chrome profile directory: ${profileDirectory}`);
}
if (useCurrentProfile) {
    console.log("If Chrome is already running, quit Chrome first; existing Chrome instances can ignore --load-extension.");
}
console.log("Open or log in to https://leetcode.com in this profile. To force a fresh sync, click Expire now in the extension popup, then refresh a leetcode.com page.");

const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${browserExtensionPath}`,
    "https://leetcode.com",
];

if (profileDirectory) {
    chromeArgs.splice(1, 0, `--profile-directory=${profileDirectory}`);
}

run(chromeBinary, chromeArgs);
