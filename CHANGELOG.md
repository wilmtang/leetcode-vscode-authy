# Change Log
All notable changes to the "leetcode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.20.0]
### Fixed
- Fixed auth-sync cooldown being bypassed too eagerly for unchanged sessions. Automatic syncs now correctly respect the configured cooldown unless the login session fingerprint changes or headers are captured for the first time.
- Reduced log noise in the output channel: repeat syncs of an unchanged session now collapse to a single `session unchanged` line instead of printing three lines per sync. Browser request headers are still captured and stored on every sync.
- Browser extension updated to 0.1.6 with improved cooldown logic.

## [0.19.1]
### Added
- **Status bar profile panel**: clicking the `LeetCode: <username>` status bar
  item opens a personal-stats webview with total solved counts, Easy/Medium/Hard
  progress bars against the full catalog, "Beats %" per difficulty, global
  ranking, country/company/school, language breakdown, and the 10 most recent
  Accepted submissions. The same view is reachable via
  `LeetCode: Show User Profile`. When signed out, the status bar click opens the
  sign-in picker instead of being a dead-end.

### Security
- **Credentials moved to the OS keychain (audit 2 / A2-1).** The synced LeetCode
  session cookie, browser user-agent, and captured request headers are now stored
  in VS Code `SecretStorage` instead of plaintext `globalState`. Existing
  plaintext values are migrated into the keychain on first launch and the old
  copies deleted, so upgrades don't sign you out.
- **Constant-time secret comparison (A2-4).** The auth-sync shared secret and the
  port-release control token are now compared with `crypto.timingSafeEqual`.
- **curl fallback no longer leaks the cookie via argv (A2-5).** The Cloudflare
  curl fallback passes the cookie, auth headers, and request body through a config
  file on stdin (`curl -K -`) instead of command-line arguments, so they no longer
  appear in the host process list.
- **Untrusted-markup hardening (A2-6).** Dropped the `file:` link allowance from
  the markdown renderer and neutralize `javascript:`/`vbscript:`/`file:` URLs in
  rendered href/src — closes a phishing / NTLM-leak vector in community solutions.

### Fixed
- `Show Top Voted Solution` now fetches the overall top-voted community solution
  instead of filtering by the configured/default language, and hides LeetCode's
  markdown-template HTML comments from the rendered solution body.
- Cloudflare "Just a moment…" challenges served with a **200/503** status now
  correctly trigger the curl fallback instead of being parsed as real data (A2-9).
- The profile panel no longer blanks its already-loaded sections when a
  `markdown.*` setting changes while it's open (A2-7).
- Observer VS Code windows now refresh the status-bar tooltip and the open
  profile "Session Sync" card when another window performs an auth sync (A2-8).
- The auth-sync observer check now serializes its state writes with start/stop
  transitions, preventing a transient wrong status under concurrency (A2-11).
- `mapCnProblem` now carries the internal `questionId`, matching the other problem
  mappers (A2-10; `leetcode.cn` remains untested overall).

### Changed
- Removed the unused `leetcode.authSync.ownerStaleAfterSeconds` setting (A2-13).
- Documented intentional design decisions (open-by-default local sync endpoint,
  `vscode://?cookie=` sign-in) in `AGENTS.md` so future audits don't re-flag them.

## [0.19.0]
### Changed
- The extension now talks to LeetCode **directly over HTTP/GraphQL** using the synced browser cookie, instead of bundling and shelling out to `vsc-leetcode-cli`. **Node.js is no longer required** to run the extension.
- Problem list, problem descriptions, code-file generation, startup sign-in, favorites, and top-voted solutions are all fetched through the direct API. Descriptions and solutions now render LaTeX math via KaTeX.
- Generated solution files embed the canonical `https://leetcode.com/problems/<slug>/` URL in the `@lc` header, so Test/Submit recover the problem slug even with custom filename configurations.

### Removed
- The **Manage Sessions** feature — LeetCode retired the underlying session API.
- The bundled `vsc-leetcode-cli` (and `require-from-string`, `unescape-js`) dependencies and the `leetcode.nodePath` setting.

### Notes
- Validated against `leetcode.com`. `leetcode.cn` support is inherited from the upstream extension and has not been freshly tested by this fork.

## [0.18.12]
### Added
- Publish VS Code extension releases to the Open VSX Registry.

### Changed
- Render LeetCode run results with example testcase labels and the total testcase count.
- Clarify auth-sync, telemetry, and LeetCode testcase documentation.

## [0.18.11]
### Added
- Replay browser-captured LeetCode request headers, including Firefox headers, when running test cases so auth-sync requests better match the signed-in browser session.

### Changed
- Store browser sync data without forcing an immediate login-state refresh, allowing cookie-only sync updates to remain lightweight.

### Fixed
- Improve authenticated LeetCode test requests for the current judger flow.

## [0.18.10]
### Fixed
- Treat the auth sync `/health` endpoint as the source of truth for listener ownership so stale VS Code global state cannot block a reopened window from claiming a free port.

## [0.18.9]
### Fixed
- Restore LeetCode test execution through the auth-sync request flow when the standard CLI test path cannot complete with the current LeetCode auth behavior.

## [0.18.8]
### Fixed
- Keep multiline testcase examples fully commented in generated problem files.

## [0.18.7]
### Added
- Coordinate browser auth sync ownership across multiple VS Code windows with configurable heartbeat, observer check, and stale-owner timings.
- Add `LeetCode: Force Start Browser Auth Sync Server` to move listener ownership to the current VS Code window when the port is owned by this extension.

### Fixed
- Read auth cookies, user status, and sync timestamps from shared VS Code global state so observer windows do not keep stale in-memory auth state.

## [0.18.6]
### Added
- Show the last successful browser cookie sync time first in the auth sync status command.

## [0.18.4]
### Added
- change graphql path

## [0.18.3]
### Added
- re-add cookie-based login method  [PR#969](https://github.com/wilmtang/vscode-leetcode/pull/969)

## [0.18.2]
### Fixed
- fix login issue on VS Code Insiders  [PR#968](https://github.com/wilmtang/vscode-leetcode/pull/968)

## [0.18.1]
### Changed
- change login way and add tracking logic option [PR#944](https://github.com/wilmtang/vscode-leetcode/pull/944)

## [0.18.0]
### Added
- Add `star` command in shortcuts [PR#601](https://github.com/wilmtang/vscode-leetcode/pull/601)
- Add an option to disable endpoint translation [#389](https://github.com/wilmtang/vscode-leetcode/issues/389)

### Changed
- LeetCode actions are moved into sub-menu: `LeetCode` in the editor context menu. [PR#712](https://github.com/wilmtang/vscode-leetcode/pull/712)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.18.0+is%3Aclosed+label%3Abug)

## [0.17.0]
### Added
- Add TypeScript support [#560](https://github.com/wilmtang/vscode-leetcode/issues/560)

### Changed
- Update the UI resources [PR#561](https://github.com/wilmtang/vscode-leetcode/pull/561)

## [0.16.2]
### Added
- New Category: `Concurrency` [CLI#42](https://github.com/leetcode-tools/leetcode-cli/pull/42)
- New configuration to better configure how to show the description [#310](https://github.com/wilmtang/vscode-leetcode/issues/310)

### Removed
- Removed the deprecated setting `leetcode.enableShortcuts` [PR#520](https://github.com/wilmtang/vscode-leetcode/pull/520)
- Removed the deprecated setting `leetcode.outputFolder` [PR#521](https://github.com/wilmtang/vscode-leetcode/pull/521)

## [0.16.1]
### Added
- Can show the problem in current workspace even if it's not a LeetCode workspace [#373](https://github.com/wilmtang/vscode-leetcode/issues/373)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.16.1+is%3Aclosed+label%3Abug)

## [0.16.0]
### Added
- Support GitHub login and LinkedIn login [PR#496](https://github.com/wilmtang/vscode-leetcode/pull/496)

## [0.15.8]
### Added
- Add a new command `Sign In by Cookie` to workaround the issue that [users cannot login to LeetCode](https://github.com/wilmtang/vscode-leetcode/issues/478). Please check the [workaround steps](https://github.com/wilmtang/vscode-leetcode/tree/main#%EF%B8%8F-attention-%EF%B8%8F--workaround-to-login-to-leetcode-endpoint) for more details!

### Changed
- Update the explorer icons to be align with the VS Code design [#460](https://github.com/wilmtang/vscode-leetcode/issues/460)

## [0.15.7]
### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.7+is%3Aclosed+label%3Abug)

## [0.15.6]
### Added
- Add a link to the solution page [#424](https://github.com/wilmtang/vscode-leetcode/issues/424)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.6+is%3Aclosed+label%3Abug)

## [0.15.5]
### Added
- Add a link to the discussion page [#420](https://github.com/wilmtang/vscode-leetcode/issues/420)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.5+is%3Aclosed+label%3Abug)

## [0.15.4]
### Added
- Add a new setting `leetcode.filePath`. Now users can use this setting to dynamicly specify the relative folder name and file name. [#PR380](https://github.com/wilmtang/vscode-leetcode/pull/380)

### Fixed
- Missing language `Rust` in the supported language list. [#PR412](https://github.com/wilmtang/vscode-leetcode/pull/412)
- Cannot show output when the answer is wrong. [#414](https://github.com/wilmtang/vscode-leetcode/issues/414)

## [0.15.3]
### Added
- Support `Pick One` [#263](https://github.com/wilmtang/vscode-leetcode/issues/263)
- Support toggling the favorite problems [#378](https://github.com/wilmtang/vscode-leetcode/issues/378)

### Changed
- Update the activity bar icon [#395](https://github.com/wilmtang/vscode-leetcode/issues/263)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.3+is%3Aclosed+label%3Abug)

## [0.15.2]
### Added
- Prompt to open the workspace for LeetCode [#130](https://github.com/wilmtang/vscode-leetcode/issues/130)
- Support deleting sessions [#198](https://github.com/wilmtang/vscode-leetcode/issues/130)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.2+is%3Aclosed+label%3Abug)

## [0.15.1]
### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.1+is%3Aclosed+label%3Abug)

## [0.15.0]
### Added
- Auto refresh the explorer after submitting [#91](https://github.com/wilmtang/vscode-leetcode/issues/91)
- Add a editor shortcut `Description` to show the problem description [#286](https://github.com/wilmtang/vscode-leetcode/issues/286)
- Support customizing the shortcuts in editor [#335](https://github.com/wilmtang/vscode-leetcode/issues/335)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.0+is%3Aclosed+label%3Abug)

## [0.14.3]
### Added
- Support interpolation for `leetcode.outputFolder` settings [#151](https://github.com/wilmtang/vscode-leetcode/issues/151)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+is%3Aclosed+milestone%3A0.14.3+label%3Abug)

## [0.14.2]
### Added
- Add the `All` category in the LeetCode Explorer [#184](https://github.com/wilmtang/vscode-leetcode/issues/184)
- Add shortcuts for `Show top voted solution` [#269](https://github.com/wilmtang/vscode-leetcode/issues/269)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+is%3Aclosed+label%3Abug+milestone%3A0.14.2)

## [0.14.1]
### Added
- Add setting `leetcode.showCommentDescription` to specify whether including the problem description in comments or not [#287](https://github.com/wilmtang/vscode-leetcode/issues/287)

## [0.14.0]
### Added
- Add setting `leetcode.enableShortcuts` to specify whether to show the submit/test shortcuts in editor [#146](https://github.com/wilmtang/vscode-leetcode/issues/146)
- Add `Like` and `Dislike` counts in the problem description [#267](https://github.com/wilmtang/vscode-leetcode/issues/267)

### Changed
- Improve the `Preview`, `Result` and `Solution` views

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+label%3Abug+is%3Aclosed+milestone%3A0.14.0)

## [0.13.3]
### Fixed
- Fix the bug that the extension cannot be activated

## [0.13.2]
### Added
- Add a setting `leetcode.enableStatusBar` to specify whether the LeetCode status bar will be shown or not [#156](https://github.com/wilmtang/vscode-leetcode/issues/156)
- Add a setting `leetcode.nodePath` to specify the `Node.js` executable path [#227](https://github.com/wilmtang/vscode-leetcode/issues/227)

### Changed
- Update the activity bar icon, See: [#225](https://github.com/wilmtang/vscode-leetcode/pull/225)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.13.2+is%3Aclosed+label%3Abug)

## [0.13.1]
### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.13.1+is%3Aclosed+label%3Abug)

## [0.13.0]
### Added
- Preview the problem description [#131](https://github.com/wilmtang/vscode-leetcode/issues/131)
- Show top voted solution [#193](https://github.com/wilmtang/vscode-leetcode/pull/193)
- Add `collapse all` for the explorer [#197](https://github.com/wilmtang/vscode-leetcode/pull/197)

### Fixed
[Bugs fixed](https://github.com/wilmtang/vscode-leetcode/issues?q=is%3Aissue+is%3Aclosed+milestone%3A0.13.0+label%3Abug)

## [0.12.0]
### Added
- Add new command `LeetCode: Switch Default Language` to support switching the default language [#115](https://github.com/wilmtang/vscode-leetcode/issues/115)
- Support `PHP` and `Rust` ([#83](https://github.com/wilmtang/vscode-leetcode/issues/83), [#103](https://github.com/wilmtang/vscode-leetcode/issues/103))

### Fixed
- Cannot retrieve time and memory result [#105](https://github.com/wilmtang/vscode-leetcode/issues/105)
- Power operator displays in a wrong way [#74](https://github.com/wilmtang/vscode-leetcode/issues/74)

## [0.11.0]
### Added
- Add new setting: `leetcode.outputFolder` to customize the sub-directory to save the files generated by 'Show Problem' [#119](https://github.com/wilmtang/vscode-leetcode/issues/119)
- Add tooltips for sub-category nodes in LeetCode Explorer [#143](https://github.com/wilmtang/vscode-leetcode/pull/143)

### Changed
- Now when triggering 'Show Problem', the extension will not generate a new file if it already exists [#59](https://github.com/wilmtang/vscode-leetcode/issues/59)

### Fixed
- Log in timeout when proxy is enabled [#117](https://github.com/wilmtang/vscode-leetcode/issues/117)

## [0.10.2]
### Fixed
- Test cases cannot have double quotes [#60](https://github.com/wilmtang/vscode-leetcode/issues/60)

## [0.10.1]
### Changed
- Refine the README page.

## [0.10.0]
### Added
- Add an extension setting to hide solved problems [#95](https://github.com/wilmtang/vscode-leetcode/issues/95)
- Support categorize problems by company, tag, difficulty and favorite [#67](https://github.com/wilmtang/vscode-leetcode/issues/67)

## [0.9.0]
### Changed
- Improve the experience of switching endpoint [#85](https://github.com/wilmtang/vscode-leetcode/issues/85)
- Use web view to show the result page [#76](https://github.com/wilmtang/vscode-leetcode/issues/76)


## [0.8.2]
### Added
- Add Code Lens for submitting the answer to LeetCode

### Fixed
- Fix the bug that the extension could not automatically sign in [#72](https://github.com/wilmtang/vscode-leetcode/issues/72)

## [0.8.1]
### Changed
- Upgrade LeetCode CLI to v2.6.1

## [0.8.0]
### Added
- Support LeetCode CN [#50](https://github.com/wilmtang/vscode-leetcode/issues/50)
- Support Windows Subsystem for Linux [#47](https://github.com/wilmtang/vscode-leetcode/issues/47)

## [0.7.0]
### Added
- Add spinner when submitting code [#43](https://github.com/wilmtang/vscode-leetcode/issues/43)

## [0.6.1]
### Added
- Add Sign in action into LeetCode Explorer title area [#25](https://github.com/wilmtang/vscode-leetcode/issues/25)

## [0.6.0]
### Changed
- Move LeetCode explorer into activity bar [#39](https://github.com/wilmtang/vscode-leetcode/issues/39)

### Added
- Support trigger test & submit in the editor [#37](https://github.com/wilmtang/vscode-leetcode/issues/37)

### Fixed
- Fix the bug that cannot show problem [#41](https://github.com/wilmtang/vscode-leetcode/issues/41)

## [0.5.1]
### Fixed
- Fix the bug when user's path contains white spaces [#34](https://github.com/wilmtang/vscode-leetcode/issues/34)

## [0.5.0]
### Added
- Support submit and test solution files from the file explorer in VS Code ([#24](https://github.com/wilmtang/vscode-leetcode/issues/24), [#26](https://github.com/wilmtang/vscode-leetcode/issues/26))

## [0.4.0]
### Added
- Support locked problem [#20](https://github.com/wilmtang/vscode-leetcode/issues/20)

### Changed
- Simplify the command 'LeetCode: Test Current File' to 'LeetCode: Test' [#18](https://github.com/wilmtang/vscode-leetcode/issues/18)
- Will automatically save current file when 'LeetCode: Test' command is triggered [#17](https://github.com/wilmtang/vscode-leetcode/issues/17)

## [0.3.0]
### Added
- Test current solution file [#15](https://github.com/wilmtang/vscode-leetcode/issues/15)

## [0.2.1]
### Fixed
- Fix the wrong icon bug in LeetCode Explorer [#9](https://github.com/wilmtang/vscode-leetcode/issues/9)
- Fix the switch session bug when login session is expired [#12](https://github.com/wilmtang/vscode-leetcode/issues/12)

## [0.2.0]
### Added
- Support setting the default language to solve problems [#5](https://github.com/wilmtang/vscode-leetcode/issues/5)

### Fixed
- When user cancels login, no further actions will happen [#10](https://github.com/wilmtang/vscode-leetcode/issues/10)

## [0.1.2]
### Fixed
- Fix the duplicated nodes in LeetCode Explorer bug [#6](https://github.com/wilmtang/vscode-leetcode/issues/6)

## [0.1.1]
### Fixed
- Fix a bug in LeetCode Explorer [#3](https://github.com/wilmtang/vscode-leetcode/issues/3)
- Remove the show problem command from command palette [#4](https://github.com/wilmtang/vscode-leetcode/issues/4)

## [0.1.0]
### Added
- Sign in/out to LeetCode
- Switch and create session
- Show problems in explorer
- Search problems by keywords
- Submit solutions to LeetCode
