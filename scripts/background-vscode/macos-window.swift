#!/usr/bin/env swift
// Copyright (c) wilmtang. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// macOS helper for scripts/background-vscode/run.js. Keeps verification UI off
// the user's work display and never activates the launched app:
//   display            print the non-primary, unmirrored built-in display bounds
//                      (global top-left coordinates) or exit 1
//   launch APP ARGS…   open a NEW, hidden instance of APP without activating
//                      it; print pid
//   unhide PID         show PID's windows without activating it
//   windows PID        print "id x y w h onscreen" for each window of PID
//   frontmost          print the frontmost app's pid
// Never fall back to another screen: if the built-in display is absent, primary
// or mirrored, refuse.

import AppKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func secondaryBuiltinBounds() -> CGRect? {
    for screen in NSScreen.screens {
        guard let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else {
            continue
        }
        if CGDisplayIsBuiltin(id) != 0 && id != CGMainDisplayID() && CGDisplayIsInMirrorSet(id) == 0 {
            return CGDisplayBounds(id)
        }
    }
    return nil
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage: macos-window.swift display | launch APP ARGS… | unhide PID | windows PID | frontmost")
}

switch command {
case "display":
    guard let bounds = secondaryBuiltinBounds() else {
        fail("refused: no non-primary, unmirrored built-in display")
    }
    print(Int(bounds.origin.x), Int(bounds.origin.y), Int(bounds.width), Int(bounds.height))

case "launch":
    guard args.count >= 2 else { fail("usage: launch APP ARGS…") }
    guard secondaryBuiltinBounds() != nil else {
        fail("refused: no non-primary, unmirrored built-in display")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    // Start hidden: the caller checks the window landed on the test display
    // before anything becomes visible.
    configuration.hides = true
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.arguments = Array(args.dropFirst(2))
    var result: Result<pid_t, Error>?
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: args[1], isDirectory: true), configuration: configuration) { app, error in
        if let error = error {
            result = .failure(error)
        } else if let app = app {
            result = .success(app.processIdentifier)
        } else {
            result = .failure(NSError(domain: "BackgroundVSCode", code: 1, userInfo: [NSLocalizedDescriptionKey: "no application returned"]))
        }
    }
    while result == nil {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    switch result! {
    case let .success(pid): print(pid)
    case let .failure(error): fail("launch failed: \(error.localizedDescription)")
    }

case "windows":
    guard args.count == 2, let pid = Int32(args[1]) else { fail("usage: windows PID") }
    let info = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    for window in info {
        guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
              (window[kCGWindowLayer as String] as? Int) == 0,
              let id = window[kCGWindowNumber as String] as? Int,
              let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict),
              bounds.width > 200, bounds.height > 200 else {
            continue
        }
        let onscreen = (window[kCGWindowIsOnscreen as String] as? Bool) ?? false
        print(id, Int(bounds.origin.x), Int(bounds.origin.y), Int(bounds.width), Int(bounds.height), onscreen ? 1 : 0)
    }

case "unhide":
    guard args.count == 2, let pid = Int32(args[1]),
          let app = NSRunningApplication(processIdentifier: pid) else { fail("usage: unhide PID") }
    _ = app.unhide()
    print(app.isHidden ? "hidden" : "shown")

case "frontmost":
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)

default:
    fail("unknown command \(command)")
}
