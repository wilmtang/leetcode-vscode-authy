# Privacy Policy

This privacy policy applies to the **LeetCode with Auth Sync** VS Code
extension and its separately packaged **LeetCode VS Code Auth Sync** companion
browser extension.

This is an unofficial fork maintained by `wilmtang`. It is not affiliated with,
endorsed by, sponsored by, or published by LeetCode.

## VS Code Extension

The VS Code extension connects to the selected LeetCode endpoint
(`leetcode.com` or `leetcode.cn`) when you use extension features such as
signing in, listing problems, fetching problem content, running tests, or
submitting solutions.

The VS Code extension stores your LeetCode authentication cookie in VS Code
extension state so it can make those user-requested LeetCode requests.

Telemetry is disabled by default. If you explicitly enable
`leetcode.allowReportData`, the VS Code extension may send limited usage events
such as command names and problem identifiers to the configured telemetry
endpoint. Telemetry does not intentionally include LeetCode cookies, solution
source code, custom test input, or local file paths. Telemetry is also disabled
when VS Code's global telemetry setting is disabled.

## Browser Extension

The browser extension is designed to synchronize your LeetCode authentication
cookies between your browser and the VS Code extension running locally on your
machine.

**The browser extension does not collect, transmit, distribute, or sell your
data.**

All authentication data, such as session cookies and LeetCode request headers,
accessed by the browser extension is kept local and is only transmitted to the
local proxy server running on `127.0.0.1` / `localhost` created by the VS Code
extension. No browser extension data is sent to any external or third-party
servers by the browser extension.

## Browser Extension Permissions

To function correctly, the browser extension requires the following permissions:

- **Cookies**: To read authentication cookies from `leetcode.com` so they can be synced with the local VS Code extension.
- **Storage**: To save local browser extension state and settings.
- **Web Request**: To observe LeetCode request headers needed for authenticated VS Code test requests, and to monitor requests to `leetcode.com` to trigger synchronization.
- **Host Permissions**: To access `leetcode.com` for cookies/headers and `http://127.0.0.1/*` to send sync payload to your local VS Code extension listener.

## Changes to this Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be
reflected in this document within the GitHub repository.

## Contact

If you have any questions or concerns regarding this privacy policy, please open
an issue in the [GitHub repository](https://github.com/wilmtang/vscode-leetcode).
