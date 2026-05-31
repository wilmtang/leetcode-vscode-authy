# LeetCode with Auth Sync

[![VS Code Marketplace Version](https://vsmarketplacebadges.dev/version/wilmtang.vscode-leetcode-auth-sync.svg)](https://marketplace.visualstudio.com/items?itemName=wilmtang.vscode-leetcode-auth-sync)
[![VS Code Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/wilmtang.vscode-leetcode-auth-sync.svg)](https://marketplace.visualstudio.com/items?itemName=wilmtang.vscode-leetcode-auth-sync)
[![VS Code Marketplace Downloads](https://vsmarketplacebadges.dev/downloads-short/wilmtang.vscode-leetcode-auth-sync.svg)](https://marketplace.visualstudio.com/items?itemName=wilmtang.vscode-leetcode-auth-sync)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-review%20pending-orange?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/leetcode-vs-code-auth-syn/elbnajbjhllgodibfhbfiigfmcfpbnck)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox%20Add--ons-review%20pending-orange?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/leetcode-vs-code-auth-sync/)
[![Build](https://img.shields.io/github/actions/workflow/status/wilmtang/vscode-leetcode/build.yml?branch=master&label=build)](https://github.com/wilmtang/vscode-leetcode/actions/workflows/build.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> Solve LeetCode problems in VS Code with browser auth sync.

**Unofficial fork notice:** this extension is maintained by `wilmtang` at
[wilmtang/vscode-leetcode](https://github.com/wilmtang/vscode-leetcode).
It is not affiliated with, endorsed by, sponsored by, or published by LeetCode.
The original project's MIT license and copyright notices are preserved in
[LICENSE](LICENSE), with additional fork attribution in [NOTICE.md](NOTICE.md).

## Login Workaround for leetcode.com

> Note: If you are using `leetcode.cn`, you can ignore this section.

Recently we observed that [the extension cannot login to leetcode.com endpoint anymore](https://github.com/wilmtang/vscode-leetcode/issues/478). The root cause of this issue is that leetcode.com changed its login mechanism and so far there is no ideal way to fix that issue.

This fork adds a browser auth sync workaround. Click the `Sign In` button and select `Auto Cookie Sync` to wait for the companion browser extension to send your signed-in `leetcode.com` session to VS Code. `Web Authorization` and manual `LeetCode Cookie` login remain available.

> Note: If you use `Web Authorization`, make sure your account has been connected to the authorization provider. If you want to use manual `LeetCode Cookie` login, click [here](https://github.com/wilmtang/vscode-leetcode/issues/478#issuecomment-564757098) to see the steps.

## Browser Auth Sync

This fork includes a local browser-to-VS Code cookie sync path for `leetcode.com`. It is useful when the normal VS Code login flow is blocked but your browser is already signed in to LeetCode.

### Install

Install both pieces on the same machine:

1. Install the VS Code extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=wilmtang.vscode-leetcode-auth-sync).
2. Install one browser extension:
   - Firefox: [LeetCode VS Code Auth Sync on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/leetcode-vs-code-auth-sync/) (review may still be pending).
   - Chrome: after Chrome Web Store approval, the public listing should be [LeetCode VS Code Auth Sync on Chrome Web Store](https://chromewebstore.google.com/detail/leetcode-vs-code-auth-syn/elbnajbjhllgodibfhbfiigfmcfpbnck). Until then, use the local unpacked install steps below if you are testing from this repository.
3. Sign in to [leetcode.com](https://leetcode.com/) in the same browser.
4. In VS Code, open the LeetCode side bar, click `Sign In`, and choose `Auto Cookie Sync`.
5. Click `Sync now` in the browser extension popup, or use LeetCode normally and wait for automatic sync.

When sync succeeds, VS Code refreshes the LeetCode side bar and uses the same signed-in session as your browser.

### How It Works

- The VS Code extension starts a local listener on `127.0.0.1:17899` by default.
- The companion browser extension reads your `leetcode.com` cookies and sends the LeetCode `Cookie` header to `POST http://127.0.0.1:17899/auth/update`.
- The VS Code extension reuses its existing cookie login path, updating VS Code state and the bundled `vsc-leetcode-cli` session/cache.
- Automatic browser sync only observes LeetCode XHR/fetch requests, not every page asset request, and waits for a configurable cooldown after a successful sync. The default cooldown is 30 minutes.
- Manual `Sync now` from the popup or options page ignores the cooldown.
- Cookie values are sent only to the local VS Code listener and are not intentionally logged by either extension.

### VS Code Setup

Install [LeetCode with Auth Sync from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=wilmtang.vscode-leetcode-auth-sync). The auth sync listener starts automatically when the extension activates. You can inspect or restart it from the Command Palette:

- **LeetCode: Show Browser Auth Sync Status**
- **LeetCode: Restart Browser Auth Sync Server**

Optional VS Code settings:

- `leetcode.authSync.enabled`: enable or disable the local listener.
- `leetcode.authSync.port`: local listener port. Default: `17899`.
- `leetcode.authSync.secret`: optional shared secret. If set, the browser extension must use the same value.

To sign in from VS Code, choose `Auto Cookie Sync` from the login picker. VS Code shows a waiting progress notification until the browser extension sends a valid cookie, then the LeetCode side bar refreshes automatically.

### Browser Extension Setup

The companion browser extension is packaged separately and is intentionally excluded from the VS Code Marketplace VSIX package.

Store links:

- Firefox: [https://addons.mozilla.org/en-US/firefox/addon/leetcode-vs-code-auth-sync/](https://addons.mozilla.org/en-US/firefox/addon/leetcode-vs-code-auth-sync/) (review may still be pending).
- Chrome: [https://chromewebstore.google.com/detail/leetcode-vs-code-auth-syn/elbnajbjhllgodibfhbfiigfmcfpbnck](https://chromewebstore.google.com/detail/leetcode-vs-code-auth-syn/elbnajbjhllgodibfhbfiigfmcfpbnck) once Chrome Web Store approval is complete.

Load the unpacked extension from:

```text
browser-extension/
```

Chrome:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `browser-extension/` folder.

Chrome loads `browser-extension/manifest.json` and uses its MV3 service-worker background.

Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on`.
3. Select `browser-extension/manifest.json`.

Firefox uses the `background.scripts` declaration from the same MV3 manifest. The Chrome-only `background.service_worker` declaration is ignored by Firefox.

The browser extension options page controls:

- Enable/disable auth sync.
- Local server port.
- Optional shared secret.
- Automatic sync cooldown in minutes.

### Helper Scripts

For local testing:

```bash
npm run auth-sync:dev:vscode
npm run auth-sync:dev:chrome
```

To launch Chrome with your current Chrome user-data directory and the unpacked extension:

```bash
npm run auth-sync:dev:chrome:current
```

To regenerate the browser extension icons:

```bash
npm run auth-sync:icons
```

### VS Code Marketplace Publishing

Publication of the VS Code extension is handled by `.github/workflows/vscode-extension.yml`. It uses `vscode-extension-v*` release tags so it is independent from the browser extension release lane:

```bash
git tag vscode-extension-v0.18.5
git push origin vscode-extension-v0.18.5
```

The workflow verifies that the tag matches `package.json` before publishing. Add `VSCE_PAT` to the `vscode-marketplace` GitHub Actions environment; the token must be an Azure DevOps Personal Access Token with Marketplace `Manage` scope for the publisher in `package.json`.

See [docs/vscode-marketplace-publishing.md](docs/vscode-marketplace-publishing.md) for the full publisher, token, GitHub environment, and release-tag setup.

### Firefox Add-ons Publishing

The browser extension can be validated, packaged, and submitted to addons.mozilla.org with Mozilla's `web-ext` tooling:

```bash
npm run auth-sync:lint:firefox
npm run auth-sync:build:firefox
```

Publication is handled by `.github/workflows/firefox-extension.yml`. Browser extension releases use `browser-extension-v*` tags, intentionally separate from the VS Code Marketplace `vscode-extension-v*` tags. Add these GitHub Actions secrets to the `firefox-addons` environment:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

Create those credentials from the addons.mozilla.org API credentials page, then publish a browser extension release by bumping `browser-extension/manifest.json` and pushing a matching tag:

```bash
git tag browser-extension-v0.1.2
git push origin browser-extension-v0.1.2
```

The workflow verifies that the tag matches the manifest version before uploading the listed add-on to Firefox Add-ons. It can also be run manually with `publish=true`.

### Chrome Web Store Publishing

Build the Chrome Web Store package with:

```bash
npm run auth-sync:build:chrome
```

This creates a Chrome-specific ZIP that removes Firefox-only manifest fields before upload.

Publication is handled by `.github/workflows/chrome-extension.yml` and uses the same `browser-extension-v*` tags as the Firefox workflow. These tags are intentionally separate from the VS Code Marketplace `vscode-extension-v*` tags. Add these GitHub Actions secrets to the `chrome-web-store` environment:

- `CHROME_WEBSTORE_CLIENT_ID`
- `CHROME_WEBSTORE_CLIENT_SECRET`
- `CHROME_WEBSTORE_REFRESH_TOKEN`
- `CHROME_WEBSTORE_PUBLISHER_ID`
- `CHROME_WEBSTORE_EXTENSION_ID`

Chrome Web Store API credentials are created from a Google Cloud OAuth client with the `https://www.googleapis.com/auth/chromewebstore` scope. The first Chrome Web Store submission also needs the Store Listing, Privacy, and Distribution tabs completed in the Chrome Developer Dashboard before API publishing can succeed.

Quit Chrome first when using the current-profile script; Chrome can ignore `--load-extension` if an existing Chrome process is already running. Firefox release builds do not support a safe silent permanent install of an unsigned unpacked extension into the current profile, so use the temporary add-on flow or package/sign the extension.

See [docs/auth-sync-local-testing.md](docs/auth-sync-local-testing.md) for the full local testing workflow and troubleshooting notes.

## Requirements

- [VS Code 1.30.1+](https://code.visualstudio.com/)
- [Node.js 10+](https://nodejs.org)
  > NOTE: Please make sure that `Node` is in your `PATH` environment variable. You can also use the setting `leetcode.nodePath` to specify the location of your `Node.js` executable.

## Quick Start

![demo](https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/gifs/demo.gif)

## Features

### Sign In/Out

<p align="center">
  <img src="https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/sign_in.png" alt="Sign in" />
</p>

- Simply click `Sign in to LeetCode` in the `LeetCode Explorer` will let you **sign in** with your LeetCode account.

- You can also use the following command to sign in/out:
  - **LeetCode: Sign in**
  - **LeetCode: Sign out**

---

### Switch Endpoint

<p align="center">
  <img src="https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/endpoint.png" alt="Switch Endpoint" />
</p>

- By clicking the button ![btn_endpoint](https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/btn_endpoint.png) at the **explorer's navigation bar**, you can switch between different endpoints.

- The supported endpoints are:

  - **leetcode.com**
  - **leetcode.cn**

  > Note: The accounts of different endpoints are **not** shared. Please make sure you are using the right endpoint. The extension will use `leetcode.com` by default.

---

### Pick a Problem

<p align="center">
  <img src="https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/pick_problem.png" alt="Pick a Problem" />
</p>

- Directly click on the problem or right click the problem in the `LeetCode Explorer` and select `Preview Problem` to see the problem description.
- Select `Show Problem` to directly open the file with the problem description.

  > Note：You can specify the path of the workspace folder to store the problem files by updating the setting `leetcode.workspaceFolder`. The default value is：**$HOME/.leetcode/**.

  > You can specify whether including the problem description in comments or not by updating the setting `leetcode.showCommentDescription`.

  > You can switch the default language by triggering the command: `LeetCode: Switch Default Language`.

---

### Editor Shortcuts

<p align="center">
  <img src="https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/shortcuts.png" alt="Editor Shortcuts" />
</p>

- The extension supports 5 editor shortcuts (aka Code Lens):

  - `Submit`: Submit your answer to LeetCode.
  - `Test`: Test your answer with customized test cases.
  - `Star/Unstar`: Star or unstar the current problem.
  - `Solution`: Show the top voted solution for the current problem.
  - `Description`: Show the problem description page.

  > Note: You can customize the shortcuts using the setting: `leetcode.editor.shortcuts`. By default, only `Submit` and `Test` shortcuts are enabled.

---

### Search problems by Keywords

<p align="center">
  <img src="https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/search.png" alt="Search problems by Keywords" />
</p>

- By clicking the button ![btn_search](https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/btn_search.png) at the **explorer's navigation bar**, you can search the problems by keywords.

---

### Manage Session

<p align="center">
  <img src="https://raw.githubusercontent.com/wilmtang/vscode-leetcode/master/docs/imgs/session.png" alt="Manage Session" />
</p>

- To manage your LeetCode sessions, just clicking the `LeetCode: ***` at the bottom of the status bar. You can **switch** between sessions or **create**, **delete** a session.

## Settings

| Setting Name                      | Description                                                                                                                                                                                                                                                   | Default Value      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `leetcode.hideSolved`             | Specify to hide the solved problems or not                                                                                                                                                                                                                    | `false`            |
| `leetcode.defaultLanguage`        | Specify the default language used to solve the problem. Supported languages are: `bash`, `c`, `cpp`, `csharp`, `golang`, `java`, `javascript`, `kotlin`, `mysql`, `php`, `python`,`python3`,`ruby`,`rust`, `scala`, `swift`, `typescript`                     | `N/A`              |
| `leetcode.useWsl`                 | Specify whether to use WSL or not                                                                                                                                                                                                                             | `false`            |
| `leetcode.endpoint`               | Specify the active endpoint. Supported endpoints are: `leetcode`, `leetcode-cn`                                                                                                                                                                               | `leetcode`         |
| `leetcode.workspaceFolder`        | Specify the path of the workspace folder to store the problem files.                                                                                                                                                                                          | `""`               |
| `leetcode.filePath`               | Specify the relative path under the workspace and the file name to save the problem files. More details can be found [here](https://github.com/wilmtang/vscode-leetcode/wiki/Customize-the-Relative-Folder-and-the-File-Name-of-the-Problem-File). |                    |
| `leetcode.enableStatusBar`        | Specify whether the LeetCode status bar will be shown or not.                                                                                                                                                                                                 | `true`             |
| `leetcode.editor.shortcuts`       | Specify the customized shortcuts in editors. Supported values are: `submit`, `test`, `star`, `solution` and `description`.                                                                                                                                    | `["submit, test"]` |
| `leetcode.enableSideMode`         | Specify whether `preview`, `solution` and `submission` tab should be grouped into the second editor column when solving a problem.                                                                                                                            | `true`             |
| `leetcode.nodePath`               | Specify the `Node.js` executable path. for example, C:\Program Files\nodejs\node.exe                                                                                                                                                                          | `node`             |
| `leetcode.showCommentDescription` | Specify whether to include the problem description in the comments                                                                                                                                                                                            | `false`            |
| `leetcode.useEndpointTranslation` | Use endpoint's translation (if available)                                                                                                                                                                                                                     | `true`             |
| `leetcode.colorizeProblems`       | Add difficulty badge and colorize problems files in explorer tree                                                                                                                                                                                             | `true`             |
| `leetcode.problems.sortStrategy`  | Specify sorting strategy for problems list                                                                                                                                                                                                                    | `None`             |
| `leetcode.allowReportData`        | Opt in to anonymous usage telemetry for this unofficial fork. Telemetry is disabled by default.                                                                                                                                                               | `false`            |
| `leetcode.authSync.enabled`       | Enable the local browser auth sync server on `127.0.0.1`.                                                                                                                                                                                                     | `true`             |
| `leetcode.authSync.port`          | Local port used by the browser auth sync server. The browser extension must use the same port.                                                                                                                                                                | `17899`            |
| `leetcode.authSync.secret`        | Optional shared secret for browser auth sync. If set, the browser extension must send the same secret.                                                                                                                                                        | `""`               |

## Want Help?

When you meet any problem, you can check out the [Troubleshooting](https://github.com/wilmtang/vscode-leetcode/wiki/Troubleshooting) and [FAQ](https://github.com/wilmtang/vscode-leetcode/wiki/FAQ) first.

If your problem still cannot be addressed, please [file an issue](https://github.com/wilmtang/vscode-leetcode/issues/new/choose).

## Release Notes

Refer to [CHANGELOG](https://github.com/wilmtang/vscode-leetcode/blob/master/CHANGELOG.md)

## Acknowledgement

- This extension is based on [@skygragon](https://github.com/skygragon)'s [leetcode-cli](https://github.com/skygragon/leetcode-cli) open source project.
- Special thanks to our [contributors](https://github.com/wilmtang/vscode-leetcode/blob/master/ACKNOWLEDGEMENTS.md).
