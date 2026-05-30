# LeetCode with Auth Sync

> Solve LeetCode problems in VS Code with browser auth sync

<p align="center">
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/resources/LeetCode.png" alt="">
</p>
<p align="center">
  <a href="https://github.com/LeetCode-OpenSource/vscode-leetcode/actions?query=workflow%3ACI+branch%3Amaster">
    <img src="https://img.shields.io/github/workflow/status/LeetCode-OpenSource/vscode-leetcode/CI/master?style=flat-square" alt="">
  </a>
  <a href="https://gitter.im/vscode-leetcode/Lobby">
    <img src="https://img.shields.io/gitter/room/LeetCode-OpenSource/vscode-leetcode.svg?style=flat-square" alt="">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=LeetCode.vscode-leetcode">
    <img src="https://img.shields.io/visual-studio-marketplace/d/LeetCode.vscode-leetcode.svg?style=flat-square" alt="">
  </a>
  <a href="https://github.com/LeetCode-OpenSource/vscode-leetcode/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/LeetCode-OpenSource/vscode-leetcode.svg?style=flat-square" alt="">
  </a>
</p>

- English Document | [中文文档](https://github.com/LeetCode-OpenSource/vscode-leetcode/blob/master/docs/README_zh-CN.md)

## ❗️ Attention ❗️- Workaround to login to LeetCode endpoint

> Note: If you are using `leetcode.cn`, you can just ignore this section.

Recently we observed that [the extension cannot login to leetcode.com endpoint anymore](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/478). The root cause of this issue is that leetcode.com changed its login mechanism and so far there is no ideal way to fix that issue.

This fork adds a browser auth sync workaround. Click the `Sign In` button and select `Auto Cookie Sync` to wait for the companion browser extension to send your signed-in `leetcode.com` session to VS Code. `Web Authorization` and manual `LeetCode Cookie` login remain available.

> Note: If you use `Web Authorization`, make sure your account has been connected to the authorization provider. If you want to use manual `LeetCode Cookie` login, click [here](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/478#issuecomment-564757098) to see the steps.

## Browser Auth Sync

This fork includes a local browser-to-VS Code cookie sync path for `leetcode.com`. A companion browser extension can send your current LeetCode cookie header to the VS Code extension on `127.0.0.1:17899`, where the existing cookie login flow updates both VS Code state and the bundled CLI session. Automatic sync observes only LeetCode XHR/fetch requests and is throttled by a configurable cooldown.

This is useful when the normal LeetCode login flow is blocked but your browser is already signed in to `leetcode.com`.

### How It Works

- The VS Code extension starts a local listener on `127.0.0.1:17899` by default.
- The companion browser extension sends the full LeetCode `Cookie` header to `POST http://127.0.0.1:17899/auth/update`.
- The VS Code extension reuses the existing cookie login path, updating VS Code state and the bundled `vsc-leetcode-cli` session/cache.
- Automatic browser sync only observes LeetCode XHR/fetch requests, not every page asset request.
- Automatic sync waits until its cooldown expires after a successful sync. The default cooldown is 30 minutes and is configurable in the browser extension options page.
- Manual `Sync now` from the popup or options page ignores the cooldown.
- The popup shows last/next sync timers at minute granularity.
- Cookie values are not intentionally logged by either extension.

### VS Code Setup

The auth sync listener starts automatically when the LeetCode extension activates. You can inspect or restart it from the Command Palette:

- **LeetCode: Show Browser Auth Sync Status**
- **LeetCode: Restart Browser Auth Sync Server**

Optional VS Code settings:

- `leetcode.authSync.enabled`: enable or disable the local listener.
- `leetcode.authSync.port`: local listener port. Default: `17899`.
- `leetcode.authSync.secret`: optional shared secret. If set, the browser extension must use the same value.

To sign in from VS Code, choose `Auto Cookie Sync` from the login picker. VS Code shows a waiting progress notification until the browser extension sends a valid cookie, then the LeetCode side bar refreshes automatically.

### Browser Extension Setup

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

### Firefox Add-ons Publishing

The browser extension can be validated, packaged, and submitted to addons.mozilla.org with Mozilla's `web-ext` tooling:

```bash
npm run auth-sync:lint:firefox
npm run auth-sync:build:firefox
```

Publication is handled by `.github/workflows/firefox-extension.yml`. Add these GitHub Actions secrets to the `firefox-addons` environment:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

Create those credentials from the addons.mozilla.org API credentials page, then publish a browser extension release by bumping `browser-extension/manifest.json` and pushing a matching tag:

```bash
git tag browser-extension-v0.1.1
git push origin browser-extension-v0.1.1
```

The workflow verifies that the tag matches the manifest version before uploading the listed add-on to Firefox Add-ons. It can also be run manually with `publish=true`.

Quit Chrome first when using the current-profile script; Chrome can ignore `--load-extension` if an existing Chrome process is already running. Firefox release builds do not support a safe silent permanent install of an unsigned unpacked extension into the current profile, so use the temporary add-on flow or package/sign the extension.

See [docs/auth-sync-local-testing.md](docs/auth-sync-local-testing.md) for the full local testing workflow and troubleshooting notes.

## Requirements

- [VS Code 1.30.1+](https://code.visualstudio.com/)
- [Node.js 10+](https://nodejs.org)
  > NOTE: Please make sure that `Node` is in your `PATH` environment variable. You can also use the setting `leetcode.nodePath` to specify the location of your `Node.js` executable.

## Quick Start

![demo](https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/gifs/demo.gif)

## Features

### Sign In/Out

<p align="center">
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/sign_in.png" alt="Sign in" />
</p>

- Simply click `Sign in to LeetCode` in the `LeetCode Explorer` will let you **sign in** with your LeetCode account.

- You can also use the following command to sign in/out:
  - **LeetCode: Sign in**
  - **LeetCode: Sign out**

---

### Switch Endpoint

<p align="center">
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/endpoint.png" alt="Switch Endpoint" />
</p>

- By clicking the button ![btn_endpoint](https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/btn_endpoint.png) at the **explorer's navigation bar**, you can switch between different endpoints.

- The supported endpoints are:

  - **leetcode.com**
  - **leetcode.cn**

  > Note: The accounts of different endpoints are **not** shared. Please make sure you are using the right endpoint. The extension will use `leetcode.com` by default.

---

### Pick a Problem

<p align="center">
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/pick_problem.png" alt="Pick a Problem" />
</p>

- Directly click on the problem or right click the problem in the `LeetCode Explorer` and select `Preview Problem` to see the problem description.
- Select `Show Problem` to directly open the file with the problem description.

  > Note：You can specify the path of the workspace folder to store the problem files by updating the setting `leetcode.workspaceFolder`. The default value is：**$HOME/.leetcode/**.

  > You can specify whether including the problem description in comments or not by updating the setting `leetcode.showCommentDescription`.

  > You can switch the default language by triggering the command: `LeetCode: Switch Default Language`.

---

### Editor Shortcuts

<p align="center">
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/shortcuts.png" alt="Editor Shortcuts" />
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
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/search.png" alt="Search problems by Keywords" />
</p>

- By clicking the button ![btn_search](https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/btn_search.png) at the **explorer's navigation bar**, you can search the problems by keywords.

---

### Manage Session

<p align="center">
  <img src="https://raw.githubusercontent.com/LeetCode-OpenSource/vscode-leetcode/master/docs/imgs/session.png" alt="Manage Session" />
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
| `leetcode.filePath`               | Specify the relative path under the workspace and the file name to save the problem files. More details can be found [here](https://github.com/LeetCode-OpenSource/vscode-leetcode/wiki/Customize-the-Relative-Folder-and-the-File-Name-of-the-Problem-File). |                    |
| `leetcode.enableStatusBar`        | Specify whether the LeetCode status bar will be shown or not.                                                                                                                                                                                                 | `true`             |
| `leetcode.editor.shortcuts`       | Specify the customized shortcuts in editors. Supported values are: `submit`, `test`, `star`, `solution` and `description`.                                                                                                                                    | `["submit, test"]` |
| `leetcode.enableSideMode`         | Specify whether `preview`, `solution` and `submission` tab should be grouped into the second editor column when solving a problem.                                                                                                                            | `true`             |
| `leetcode.nodePath`               | Specify the `Node.js` executable path. for example, C:\Program Files\nodejs\node.exe                                                                                                                                                                          | `node`             |
| `leetcode.showCommentDescription` | Specify whether to include the problem description in the comments                                                                                                                                                                                            | `false`            |
| `leetcode.useEndpointTranslation` | Use endpoint's translation (if available)                                                                                                                                                                                                                     | `true`             |
| `leetcode.colorizeProblems`       | Add difficulty badge and colorize problems files in explorer tree                                                                                                                                                                                             | `true`             |
| `leetcode.problems.sortStrategy`  | Specify sorting strategy for problems list                                                                                                                                                                                                                    | `None`             |
| `leetcode.allowReportData`        | Allow LeetCode to report anonymous usage data to improve the product. list                                                                                                                                                                                    | `true`             |
| `leetcode.authSync.enabled`       | Enable the local browser auth sync server on `127.0.0.1`.                                                                                                                                                                                                     | `true`             |
| `leetcode.authSync.port`          | Local port used by the browser auth sync server. The browser extension must use the same port.                                                                                                                                                                | `17899`            |
| `leetcode.authSync.secret`        | Optional shared secret for browser auth sync. If set, the browser extension must send the same secret.                                                                                                                                                        | `""`               |

## Want Help?

When you meet any problem, you can check out the [Troubleshooting](https://github.com/LeetCode-OpenSource/vscode-leetcode/wiki/Troubleshooting) and [FAQ](https://github.com/LeetCode-OpenSource/vscode-leetcode/wiki/FAQ) first.

If your problem still cannot be addressed, feel free to reach us in the [Gitter Channel](https://gitter.im/vscode-leetcode/Lobby) or [file an issue](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/new/choose).

## Release Notes

Refer to [CHANGELOG](https://github.com/LeetCode-OpenSource/vscode-leetcode/blob/master/CHANGELOG.md)

## Acknowledgement

- This extension is based on [@skygragon](https://github.com/skygragon)'s [leetcode-cli](https://github.com/skygragon/leetcode-cli) open source project.
- Special thanks to our [contributors](https://github.com/LeetCode-OpenSource/vscode-leetcode/blob/master/ACKNOWLEDGEMENTS.md).
