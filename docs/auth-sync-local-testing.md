# LeetCode Browser Auth Sync Local Testing

This fork adds a browser-to-VS Code cookie sync path for local LeetCode auth.

The browser extension reads the current `leetcode.com` cookies from the browser and sends them to the VS Code extension over a loopback HTTP endpoint. The VS Code extension then reuses the existing cookie login path so both auth stores are updated:

- VS Code extension global state
- Bundled `vsc-leetcode-cli` session/cache used by test and submit

## What Changed

VS Code extension:

- Added `src/auth/authSyncServer.ts`.
- The server listens on `127.0.0.1` only.
- Default endpoint: `POST http://127.0.0.1:17899/auth/update`.
- Default secret behavior: no secret required.
- Optional secret header: `X-LeetCode-AuthSync-Secret`.
- Added settings:
  - `leetcode.authSync.enabled`
  - `leetcode.authSync.port`
  - `leetcode.authSync.secret`
- Added commands:
  - `LeetCode: Show Browser Auth Sync Status`
  - `LeetCode: Restart Browser Auth Sync Server`
- Refactored cookie login into `leetCodeManager.updateSessionFromCookie(cookie)` so manual cookie login, URI login, and browser sync all update the same session path.

Browser extension:

- Added `browser-extension/`.
- Automatic sync observes only LeetCode XHR/fetch request cookie headers.
- Sends the full LeetCode `Cookie` header to the local VS Code listener.
- Syncs on popup/options click or eligible LeetCode XHR/fetch requests.
- Applies a configurable cooldown after each successful sync. Default: 30 minutes.
- Exposes options for enabled state, port, optional shared secret, and cooldown.

## Quick Local Test

Install dependencies first:

```bash
npm ci --replace-registry-host=always
```

Start VS Code in extension-development mode:

```bash
npm run auth-sync:dev:vscode
```

Start Chrome with the unpacked browser extension loaded in a disposable test profile:

```bash
npm run auth-sync:dev:chrome
```

Then:

1. In the Chrome test profile, log in to `https://leetcode.com`.
2. Click the LeetCode Auth Sync browser extension icon.
3. Click `Sync Now`.
4. In VS Code, run `LeetCode: Show Browser Auth Sync Status`.
5. Confirm the LeetCode extension shows you as signed in.
6. Run a problem test or submit command to confirm the bundled CLI session was updated too.

## Start the VS Code Extension Listener

The auth sync listener starts automatically when the VS Code extension activates.

For local development, use:

```bash
npm run auth-sync:dev:vscode
```

That command compiles the extension and opens VS Code with this checkout as the extension-development path. The server listens on:

```text
http://127.0.0.1:17899
```

The receiver endpoint is:

```text
POST http://127.0.0.1:17899/auth/update
```

To inspect listener state, open the VS Code Command Palette and run:

```text
LeetCode: Show Browser Auth Sync Status
```

To restart it:

```text
LeetCode: Restart Browser Auth Sync Server
```

If you need another port, set `leetcode.authSync.port` in VS Code settings. The server restarts when the setting changes.

## Install the VS Code Extension Locally

For a real local install instead of an extension-development host, run:

```bash
npm run auth-sync:install:vscode
```

This script:

1. Compiles TypeScript.
2. Packages a VSIX into `dist/vscode-leetcode-auth-sync.vsix`.
3. Installs that VSIX using the `code --install-extension` CLI.

If the script cannot find the `code` command, install it from VS Code:

```text
Command Palette > Shell Command: Install 'code' command in PATH
```

You can also point the script at a custom VS Code CLI:

```bash
VSCODE_BIN=/absolute/path/to/code npm run auth-sync:install:vscode
```

After installation, reload VS Code and run:

```text
LeetCode: Show Browser Auth Sync Status
```

## Install the Browser Extension for Local Testing

### Automated Chrome Test Profile

Use:

```bash
npm run auth-sync:dev:chrome
```

This opens Chrome or Chromium with:

- a disposable profile under your temp directory
- the unpacked extension loaded from `browser-extension/`
- `https://leetcode.com` opened

If Chrome cannot be found, pass its path explicitly:

```bash
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run auth-sync:dev:chrome
```

### Automated Chrome Current Profile

For local convenience, you can launch Chrome with your existing user-data directory and the unpacked extension:

```bash
npm run auth-sync:dev:chrome:current
```

This uses Chrome's last-used profile from the local `Local State` file when possible. If Chrome is already running, quit Chrome first; Chrome may route the command to the existing process and ignore `--load-extension`.

This is not a silent permanent install. Chrome intentionally requires user action, enterprise policy, or startup flags for unpacked extensions in normal profiles.

### Manual Chrome Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:

```text
browser-extension/
```

To print the absolute path:

```bash
npm run auth-sync:paths
```

### Manual Firefox Install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on`.
3. Select `browser-extension/manifest.json`.

Firefox release builds do not provide a safe command for silently and permanently installing an unsigned unpacked extension into the current normal profile. Use the temporary add-on flow above for development, or package/sign the extension for a persistent install.

## Shared Secret Testing

By default, no secret is required.

To test secret-protected sync:

1. In VS Code settings, set `leetcode.authSync.secret` to a test value such as `abc123`.
2. In the browser extension options page, set the same optional shared secret.
3. Click `Sync Now`.

Expected result: sync succeeds.

To test failure:

1. Keep VS Code set to `abc123`.
2. Set the browser extension secret to `wrong`.
3. Click `Sync Now`.

Expected result: the browser extension reports `Invalid auth sync secret.` and VS Code does not update the cookie.

## Script Reference

```bash
npm run auth-sync:dev:vscode
```

Compile and open VS Code with this checkout as an extension-development host.

```bash
npm run auth-sync:install:vscode
```

Compile, package a VSIX, and install it into VS Code.

```bash
npm run auth-sync:dev:chrome
```

Open Chrome or Chromium with the unpacked browser extension loaded in a disposable profile.

```bash
npm run auth-sync:dev:chrome:current
```

Open Chrome or Chromium with the unpacked browser extension loaded against the current Chrome user-data directory. Quit Chrome first for the flag to take effect.

```bash
npm run auth-sync:paths
```

Print useful local paths, including the browser extension path and VSIX output path.

## Manual Endpoint Smoke Test

With the VS Code extension running, this should reach the local server but fail unless the fake cookie passes LeetCode's real session checks:

```bash
curl -i \
  -X POST \
  http://127.0.0.1:17899/auth/update \
  -H 'Content-Type: application/json' \
  --data '{"cookie":"LEETCODE_SESSION=fake; csrftoken=fake","reason":"manual-smoke-test"}'
```

Use the browser extension for an end-to-end test with real browser cookies.

## Privacy Notes

Cookie values are never intentionally logged by the VS Code extension or browser extension.

Automatic browser sync observes only `xmlhttprequest`/fetch requests to `https://leetcode.com/*`, sends only to `http://127.0.0.1:<port>/auth/update`, and will not send again until the configured cooldown has elapsed after the last successful sync.

The VS Code listener binds only to `127.0.0.1`, not `0.0.0.0`, so it is not reachable from other devices on the local network.
