# Status bar session sync item

Status: implemented 2026-11-10. Design approved after 3 independent review rounds; code approved after 2. Checked in a real Extension Development Host (see Verification results).
Drafted 2026-11-10.

Interactive mock: [mocks/status-bar-sync.html](mocks/status-bar-sync.html)
(open it in a browser; hover and click the status bar items, switch states on the right).

## Problem

The only status bar surface is `LeetCode: <user>`. Its click opens the profile
panel, and session-sync health is visible only in its hover tooltip. A user
whose sync stopped, lost the port to another program, or is not owned by any
window gets no visible signal, and needs the profile panel or a command-palette
search to find the fix. The tooltip also ends with "Click to open your profile
& session sync", but the click does nothing sync-specific.

## Decision

Add a second, adjacent status bar item that owns session sync. Leave the
profile item's click and text unchanged.

| | Profile item (existing) | Sync item (new) |
| --- | --- | --- |
| id / name | `leetcode.status.account` / "LeetCode Account" | `leetcode.status.sessionSync` / "LeetCode Session Sync" |
| Text | `LeetCode: <user>` / `LeetCode: Sign In` (unchanged) | icon only when healthy; icon + two words when action is needed |
| Click | profile panel / sign-in prompt (unchanged) | native quick pick: status as the placeholder, then actions |
| Tooltip | `LeetCode: <user>` + "Click to open your profile" (signed-out text unchanged) | state, last auth sync time, what the click does |
| Visibility | `leetcode.enableStatusBar` | same setting; shown signed in **and** signed out; hidden while sync is turned off or before the first start settles |

Separate ids let VS Code's status bar context menu hide either item on its own
(without ids both items share the extension id and hide together). Both items
are `StatusBarAlignment.Left` with consecutive priorities so nothing lands
between them.

Why two items: the profile click stays one predictable destination, a sync
problem is one click from its fix, and the fix uses native VS Code UI
(AGENTS.md prefers quick picks and notifications over custom UI).

Why shown when signed out: browser sync is the main way to sign in, so a broken
sync matters most to a signed-out user.

Why hidden when disabled: the user turned sync off on purpose; a permanent item
would nag. Turning it back on stays available from the settings and the
profile panel's Session Sync card.

## States

Rendered from `IAuthSyncSummary` (`src/auth/authSyncSummary.ts`), so wording
matches the profile panel's Session Sync card. State is carried by icon shape
and text, never by color alone. All codicons below exist in VS Code 1.57.

| Mode | Icon | Text | Background | Tooltip (after the state line + last sync) |
| --- | --- | --- | --- | --- |
| `local` | `$(sync)` | — | — | Click for sync details and actions |
| just synced (2 s after `onDidSync`) | `$(check)` | — | — | Received your LeetCode session just now |
| `observer` | `$(remote)` | — | — | Another VS Code window is syncing; this one gets its updates |
| `vacant` | `$(warning)` | `Not syncing` | `statusBarItem.warningBackground` | This window will take over automatically within about a minute |
| `stopped` | `$(debug-stop)` | `Sync stopped` | `statusBarItem.warningBackground` | Sync stopped after an error. Click to restart |
| `conflict` | `$(error)` | `Sync blocked` | `statusBarItem.errorBackground` | Port N is used by `<program>` (or "another program") |
| `disabled` | hidden | | | |
| before first start settles | hidden | | | |

`describeMode("stopped")` changes from "LeetCode session sync paused" to
"LeetCode session sync stopped": no command pauses sync. `stopped` only follows
a failed start (any listen error except port-in-use), a failed owner heartbeat
write, or shutdown, and nothing retries it automatically.

The "just synced" check only replaces the icon in `local` and `observer`. It
never hides a warning or error state: `onDidSync` can also fire in `vacant` or
`conflict` (the observer timer reads shared sync state in every mode except
`local` and `disabled`), and those keep their warning or error rendering.

The check replaces a spinner because the sync has already
finished; a spinner would suggest work in progress. Back-to-back syncs restart
the 2 s timer rather than stacking. The tooltip keeps the existing absolute
"Last auth sync" time; a status bar tooltip is computed once, so a relative
time would read stale. The quick pick placeholder is computed when opened and
may use a relative time.

## Quick pick

Placeholder: the state line plus relative last sync, e.g.
"Synced in this window · last sync 4 min ago". No separators
(`QuickPickItemKind` needs 1.64; engine floor is 1.57). Healthy states put the
read-only details first so Enter never restarts a working listener; problem
states put the fix first.

| Mode | Items in order → what each runs |
| --- | --- |
| `local` | Show sync details → `leetcode.authSync.status`; Restart sync → `leetcode.authSync.restart` |
| `observer` | Show sync details → status; Sync in this window instead → `leetcode.authSync.forceStart` (modal confirm kept) |
| `vacant` | Start syncing in this window → restart; Show sync details → status |
| `stopped` | Restart sync → restart (its failure path offers Open Output); Show sync details → status |
| `conflict` | Show what's using port N → existing port-conflict prompt (Open Output / copy inspect / copy stop command), falls back to details when no conflict is recorded; Try again → restart; Use a different port… → `workbench.action.openSettings` `leetcode.authSync.port`, detail "Set the same port in the browser extension options" |

Every list ends with **Open profile** → `leetcode.showUserProfile` (signed in)
or **Sign in** → `leetcode.signin` (signed out).

The force-start modal and its results are reworded to plain language and built
from the current mode, because `leetcode.authSync.forceStart` also runs from
the command palette in any mode:

- `observer`: "Move LeetCode session sync to this window? The other window will
  stop syncing." with "Move Here" / "Cancel".
- `local`: "Restart LeetCode session sync in this window?" with
  "Restart" / "Cancel".
- `disabled`: no modal; show the disabled message with an "Open Setting"
  button for `leetcode.authSync.enabled`.
- any other mode: "Start LeetCode session sync in this window?" with
  "Start" / "Cancel".
- Results: "LeetCode session sync is now running in this window (port N)."
  and "LeetCode session sync moved to this window from <owner>." The release
  failure and disabled messages use the same "session sync" wording.

"Show what's using port N" reuses the port-conflict prompt with wording for
this path: "Port N is used by <program>, so LeetCode session sync can't start.
Stop that program, or use a different port." The force-start path keeps a
force-start-specific sentence. Buttons are unchanged (Open Output / Copy
Inspect Command / Copy Stop Command).

## Engine constraints (1.57 floor, checked against `@types/vscode` 1.57.0)

- `createStatusBarItem(id, alignment, priority)` and `StatusBarItem.name` exist.
- `accessibilityInformation` exists; label `LeetCode session sync: <state>` so
  screen readers do not read codicon ids.
- `backgroundColor`: only `statusBarItem.errorBackground` is honored on 1.57.
  `statusBarItem.warningBackground` is honored from 1.63 and ignored before
  that; warning states then rely on icon + text, which already carry the state.
- Tooltips are plain strings (no `MarkdownString`).

## Implementation outline

1. **Status-change signal.** Add `AuthSyncServer.onDidChangeStatus`. In
   `enqueue`, fire from a `finally` after each operation settles, only when the
   queue is idle and the key
   `mode|port|owner.windowId|conflict.summary` differs from the last emitted
   key. Heartbeat and last-sync timestamps are not in the key, so heartbeats
   never fire it. "Idle" is a counter of in-flight queued operations,
   incremented in `enqueue` and decremented in the `finally`; emit only when it
   returns to zero. (Comparing promises does not work: `pending` stores a
   derived promise, not the operation's.)
2. **Atomic restart.** Add `AuthSyncServer.restart()` as one queued
   stop-then-start and use it from `restartAuthSyncServer`, so Restart, Try
   again and `authSync.*` setting changes never pass through a visible
   `stopped`.
3. **Conflict detail from the observer timer.** In `runObserverCheck`'s
   occupied branch, call `describePortOwner` before taking the lock and store
   it as `lastConflict` inside the lock, so a timer-detected conflict names
   the program. The lookup runs only for a new conflict (an existing conflict
   on the same port is reused), and "Show what's using port N" refreshes it
   first. The queued write is dropped if a restart, disable or port change
   happened while the check ran.
4. **Pure presentation.** `src/statusbar/sessionSyncPresentation.ts`:
   `describeSessionSyncItem(summary, { justSynced })` →
   `{ visible, text, tooltip, backgroundThemeId?, accessibilityLabel }`, and
   `buildSessionSyncActions(summary, { signedIn, now })` →
   `{ placeholder, items: { label, description?, detail?, action }[] }` where
   `action` is a string id mapped to a handler in `extension.ts`.
5. **Status bar.** `LeetCodeStatusBarItem` owns both items with ids, names,
   alignment and priorities; the controller shows/hides them together and the
   sync item additionally follows `visible`. Refresh on user `statusChanged`,
   `onDidSync` (starts the 2 s check) and `onDidChangeStatus`. The sync item
   becomes visible only after the first `startAuthSyncServer()` settles. The
   check timer is cleared on dispose.
6. **Command.** Register `leetcode.authSync.showActions`, title "Session Sync
   Actions", category "LeetCode", plus its `onCommand` activation event; it is
   the sync item's command.
7. **Profile tooltip.** Signed in: `LeetCode: <user>` and "Click to open your
   profile". The sync lines move to the sync item.
8. **Docs and comments.** README status bar bullet, CHANGELOG Unreleased
   (noting that a user who hid the old item from the status bar context menu
   may see it again, since it now has its own id),
   stale "status-bar tooltip" comments in `authSyncSummary.ts`,
   `authSyncServer.ts` and `extension.ts`, this plan's status and the
   `docs/plans/README.md` index.

## Verification

Offline (`npm test`, `npm run test:package`):

- Presentation per mode, signed in/out, the 2 s check (replaces the icon in
  `local`/`observer`, never in `vacant`/`stopped`/`conflict`), hidden states,
  and the quick-pick order and actions per mode.
- Force-start modal text per mode.
- `onDidChangeStatus`: fires once per real transition, not on a no-op refresh,
  and exactly once for `restart()`.
- A timer-detected conflict records the port owner.
- Status bar item creation passes ids, names, alignment and priorities; the
  check timer restarts and is cleared on dispose.

Extension Development Host check (state whether it ran hidden or visible):
local, observer (second window), conflict (occupy the port with
`nc -l 17899`), Restart with no warning flash, hiding each item separately from
the status bar context menu, and quick-pick contents signed in and out. If it
cannot run without taking the user's focus, record it as an open gap for the
maintainer rather than claiming it.

Not covered by either: screen-reader output and `warningBackground` on 1.63+
themes beyond the one checked.

## Verification results (2026-11-10)

Background Extension Development Host runs (VS Code 1.145.2, macOS 15.8.1,
`npm run check:vscode-background`, secondary built-in display, Dark Modern
default theme):

- Local: `$(sync)` only. The quick pick (from the command, and from a DOM click
  on the item) lists details, restart, then sign in.
- Conflict: `$(error) Sync blocked` on the error background. The quick pick
  names the program holding the port and lists the actions in the planned
  order.
- Restart from conflict back to local: sampled every 50 ms; only `$(sync)` was
  seen, with no "stopped" flash.
- Disabled: the sync item is hidden and the account item stays.
- These runs found two older bugs, fixed in `1c98c9c`: the signed-out account
  item was empty, and lsof's escaped, truncated program names appeared in the
  conflict text.

Not covered: observer and vacant (they need a second window), `stopped`
(needs a non-port-in-use listen error), the just-synced check (needs a real
browser push), hiding items from the status bar context menu (needs a real
right-click), screen readers, Windows, and `warningBackground` rendering. The
runs did take focus: VS Code activated itself when its window opened (see
AGENTS.md "Background VS Code checks").

## Out of scope

- Changing what the profile panel shows (beyond the shared "stopped" wording).
- New settings.
