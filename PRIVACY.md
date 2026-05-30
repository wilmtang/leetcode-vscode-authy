# Privacy Policy

This privacy policy applies to the **Unofficial LeetCode Auth Sync** VS Code
extension and its separately packaged companion browser extension.

## Data Collection and Usage
Unofficial LeetCode Auth Sync is designed to synchronize your LeetCode
authentication cookies between your browser and the VS Code extension running
locally on your machine.

**This fork does not collect, transmit, distribute, sell, or report telemetry or
usage analytics.**

Authentication data accessed by the companion browser extension is sent only to
the local listener created by the VS Code extension on `127.0.0.1` /
`localhost`. The VS Code extension then uses that session to make user-requested
requests to the selected LeetCode endpoint (`leetcode.com` or `leetcode.cn`) for
features such as listing problems, fetching problem content, running tests, and
submitting solutions.

## Permissions Required
To function correctly, the extension requires the following permissions:
- **Cookies**: To read the authentication cookies from `leetcode.com` so they can be synced with the local VS Code extension.
- **Storage**: To save the local state and settings of the extension.
- **Web Request**: To monitor requests to `leetcode.com` and trigger synchronization when login state changes.
- **Host Permissions**: To access `leetcode.com` for the cookies and `http://127.0.0.1/*` to send the authentication data to your local development environment.

## Changes to this Privacy Policy
We may update this Privacy Policy from time to time. Any changes will be reflected in this document within the GitHub repository.

## Contact
If you have any questions or concerns regarding this privacy policy, please open an issue in the [GitHub repository](https://github.com/wilmtang/vscode-leetcode).
