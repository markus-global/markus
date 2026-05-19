import ApplicationServices
import AppKit
import Foundation
import CoreGraphics

func jsonOut(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func exitWithError(_ msg: String, code: Int32) -> Never {
    jsonOut(["error": msg, "clicked": false])
    exit(code)
}

let args = CommandLine.arguments

// --check: report permission and Chrome status
if args.contains("--check") {
    let trusted = AXIsProcessTrusted()
    let chromeRunning = !NSRunningApplication.runningApplications(
        withBundleIdentifier: "com.google.Chrome"
    ).isEmpty
    jsonOut([
        "accessibilityPermission": trusted,
        "chromeRunning": chromeRunning,
        "platform": "darwin"
    ])
    exit(0)
}

// --open-accessibility: open System Settings > Accessibility
if args.contains("--open-accessibility") {
    let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
    NSWorkspace.shared.open(url)
    jsonOut(["opened": "accessibility_settings"])
    exit(0)
}

guard AXIsProcessTrusted() else {
    exitWithError("Accessibility permission not granted", code: 2)
}

let chromeApps = NSRunningApplication.runningApplications(
    withBundleIdentifier: "com.google.Chrome"
)
guard let chrome = chromeApps.first else {
    exitWithError("Chrome is not running", code: 1)
}

var timeoutSec = 5.0
if let idx = args.firstIndex(of: "--timeout"), idx + 1 < args.count,
   let t = Double(args[idx + 1]) {
    timeoutSec = t
}

let chromePid = Int(chrome.processIdentifier)

// Dialog window name patterns (multi-language)
let dialogNamePatterns = [
    "允许远程调试",
    "Allow remote debugging",
    "Allow debugging",
    "リモートデバッグを許可",
    "원격 디버깅 허용",
]

struct DialogWindow {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

/// Find Chrome's "Allow remote debugging?" dialog by window name via CoreGraphics.
func findDialogWindow() -> DialogWindow? {
    guard let windowList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }

    for info in windowList {
        guard let ownerPid = info[kCGWindowOwnerPID as String] as? Int, ownerPid == chromePid else { continue }
        guard let name = info[kCGWindowName as String] as? String, !name.isEmpty else { continue }
        guard let boundsDict = info[kCGWindowBounds as String] else { continue }

        let matchesPattern = dialogNamePatterns.contains { name.contains($0) }
        guard matchesPattern else { continue }

        var rect = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(boundsDict as! CFDictionary, &rect) else { continue }

        if rect.width > 100 && rect.height > 80 {
            return DialogWindow(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
        }
    }
    return nil
}

func clickAt(_ point: CGPoint) -> Bool {
    guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        return false
    }
    mouseDown.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)
    mouseUp.post(tap: .cghidEventTap)
    return true
}

/// Click the "Allow" button via coordinate offset on the dialog window.
func clickAllowButton(dialog: DialogWindow) -> Bool {
    let buttonX = dialog.x + dialog.width - 55
    let buttonY = dialog.y + dialog.height - 35
    return clickAt(CGPoint(x: buttonX, y: buttonY))
}

// Also try AX button approach as fallback (older Chrome)
let appElement = AXUIElementCreateApplication(chrome.processIdentifier)

func findAllowButtonAX(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 12 { return nil }
    var roleRef: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
    let role = roleRef as? String ?? ""
    var titleRef: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
    let title = titleRef as? String ?? ""

    if role == "AXButton" {
        let lower = title.lowercased()
        if lower == "allow" || lower == "允许" || lower == "allow debugging" {
            return element
        }
    }

    var childrenRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef)
    guard err == .success, let children = childrenRef as? [AXUIElement] else { return nil }
    for child in children {
        if let found = findAllowButtonAX(child, depth: depth + 1) { return found }
    }
    return nil
}

let pollInterval: TimeInterval = 0.3
let deadline = Date().addingTimeInterval(timeoutSec)

while Date() < deadline {
    // Strategy 1: Find dialog window by name and click via CGEvent mouse
    if let dialog = findDialogWindow() {
        if clickAllowButton(dialog: dialog) {
            Thread.sleep(forTimeInterval: 0.3)
            if findDialogWindow() == nil {
                jsonOut(["clicked": true, "method": "mouse_click"])
                exit(0)
            }
        }
    }

    // Strategy 2: AX API fallback (older Chrome InfoBar style)
    if let button = findAllowButtonAX(appElement) {
        let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
        if result == .success {
            jsonOut(["clicked": true, "method": "accessibility"])
            exit(0)
        }
    }

    Thread.sleep(forTimeInterval: pollInterval)
}

exitWithError("Allow button not found within timeout", code: 1)
