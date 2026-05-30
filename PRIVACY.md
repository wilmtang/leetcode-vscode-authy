# Privacy Policy

This privacy policy applies to the **LeetCode VS Code Auth Sync** browser extension.

## Data Collection and Usage
The LeetCode VS Code Auth Sync extension is designed to synchronize your LeetCode authentication cookies securely between your browser and the VS Code LeetCode extension running locally on your machine.

**We do not collect, transmit, distribute, or sell your data.** 

All authentication data (such as session cookies) accessed by the extension is strictly kept locally and is only transmitted to the local proxy server (running on `127.0.0.1` / `localhost`) created by the VS Code extension. No data is sent to any external or third-party servers.

## Permissions Required
To function correctly, the extension requires the following permissions:
- **Cookies**: To read the authentication cookies from `leetcode.com` so they can be synced with the local VS Code extension.
- **Storage**: To save the local state and settings of the extension.
- **Web Request**: To monitor requests to `leetcode.com` and trigger synchronization when login state changes.
- **Host Permissions**: To access `leetcode.com` for the cookies and `http://127.0.0.1/*` to send the authentication data to your local development environment.

## Changes to this Privacy Policy
We may update this Privacy Policy from time to time. Any changes will be reflected in this document within the GitHub repository.

## Contact
If you have any questions or concerns regarding this privacy policy, please open an issue in the [GitHub repository](https://github.com/LeetCode-OpenSource/vscode-leetcode).
