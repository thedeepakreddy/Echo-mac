// axhelper — reads the macOS Accessibility tree and activates elements.
//
// Jarvis uses this so it can reason about "the Send button" instead of guessing
// pixel coordinates from a screenshot. Two commands:
//
//   axhelper dump [--pid N] [--all]   -> JSON of interactive elements
//   axhelper press --path P [--pid N] -> AXPress the element at that index path
//
// A "path" is the slash-joined list of child indices from the window root, e.g.
// "0/3/2". Pressing by path activates the control directly through the API — no
// mouse movement, and it works even when the element is scrolled off or covered.
//
// Coordinates are screen points, top-left origin — the same space cliclick uses,
// so an element's centre can also be clicked the old way as a fallback.

import Cocoa
import ApplicationServices

// MARK: - attribute helpers

func copyAttr(_ el: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, key as CFString, &value) == .success ? value : nil
}

func str(_ el: AXUIElement, _ key: String) -> String? {
    (copyAttr(el, key) as? String).flatMap { $0.isEmpty ? nil : $0 }
}

func point(_ el: AXUIElement) -> CGPoint {
    var p = CGPoint.zero
    if let v = copyAttr(el, kAXPositionAttribute as String) {
        AXValueGetValue(v as! AXValue, .cgPoint, &p)
    }
    return p
}

func size(_ el: AXUIElement) -> CGSize {
    var s = CGSize.zero
    if let v = copyAttr(el, kAXSizeAttribute as String) {
        AXValueGetValue(v as! AXValue, .cgSize, &s)
    }
    return s
}

func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (copyAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

// MARK: - what counts as interactive

// Roles a user can act on. AXStaticText is included only when it carries an
// action (some apps make labels clickable), handled below.
let INTERACTIVE: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXLink", "AXComboBox",
    "AXSlider", "AXTabGroup", "AXTab", "AXDisclosureTriangle", "AXSearchField",
    "AXIncrementor", "AXSegmentedControl",
]

func label(_ el: AXUIElement) -> String {
    // Prefer a human label; fall back through the usual attributes.
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel",
                kAXValueAttribute, kAXHelpAttribute, "AXPlaceholderValue"] {
        if let s = str(el, key as String) { return s }
    }
    return ""
}

// MARK: - dump

struct Element { let role, label, value, path: String
                 let x, y, w, h: Int; let enabled: Bool; let actions: [String] }

func jsonString(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        case "\r": out += "\\r"
        default:
            if c.value < 0x20 { out += String(format: "\\u%04x", c.value) }
            else { out.unicodeScalars.append(c) }
        }
    }
    return out + "\""
}

var elements: [Element] = []
var visited = 0

func walk(_ el: AXUIElement, _ path: String, _ depth: Int) {
    if visited > 6000 || depth > 40 { return }
    visited += 1

    let role = str(el, kAXRoleAttribute as String) ?? ""
    let acts = actions(el)
    let interactive = INTERACTIVE.contains(role)
        || (role == "AXStaticText" && acts.contains("AXPress"))

    if interactive {
        let sz = size(el)
        // Skip zero-size and off-screen ghosts the tree keeps around.
        if sz.width >= 1 && sz.height >= 1 {
            let pt = point(el)
            let enabled = (copyAttr(el, kAXEnabledAttribute as String) as? Bool) ?? true
            elements.append(Element(
                role: role,
                label: label(el),
                value: str(el, kAXValueAttribute as String) ?? "",
                path: path,
                x: Int(pt.x), y: Int(pt.y), w: Int(sz.width), h: Int(sz.height),
                enabled: enabled, actions: acts))
        }
    }

    for (i, child) in children(el).enumerated() {
        walk(child, path.isEmpty ? "\(i)" : "\(path)/\(i)", depth + 1)
    }
}

// Ask the app to expose its tree. Native apps ignore this harmlessly; Electron
// and some others only populate accessibility once asked.
func enableAX(_ app: AXUIElement) {
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

func targetPid(_ args: [String]) -> pid_t? {
    if let i = args.firstIndex(of: "--pid"), i + 1 < args.count { return pid_t(args[i + 1]) }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func focusedWindow(_ app: AXUIElement, all: Bool) -> [AXUIElement] {
    if all { return (copyAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] }
    if let w = copyAttr(app, kAXFocusedWindowAttribute as String) { return [w as! AXUIElement] }
    return (copyAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]).map { Array($0.prefix(1)) } ?? []
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "dump"

guard AXIsProcessTrusted() else {
    print(#"{"error":"accessibility-not-trusted"}"#)
    exit(2)
}
guard let pid = targetPid(args) else {
    print(#"{"error":"no-target-app"}"#)
    exit(3)
}

let app = AXUIElementCreateApplication(pid)
enableAX(app)
let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"

switch command {
case "dump":
    let all = args.contains("--all")
    let windows = focusedWindow(app, all: all)
    if windows.isEmpty {
        print("{\"app\":\(jsonString(appName)),\"pid\":\(pid),\"axAvailable\":false,\"elements\":[]}")
        exit(0)
    }
    for (wi, win) in windows.enumerated() { walk(win, all ? "\(wi)" : "", 0) }

    var rows: [String] = []
    for (i, e) in elements.enumerated() {
        rows.append("""
        {"i":\(i),"role":\(jsonString(e.role)),"label":\(jsonString(e.label)),\
        "value":\(jsonString(e.value)),"path":\(jsonString(e.path)),\
        "x":\(e.x),"y":\(e.y),"w":\(e.w),"h":\(e.h),"enabled":\(e.enabled),\
        "press":\(e.actions.contains("AXPress"))}
        """)
    }
    let available = !elements.isEmpty
    print("{\"app\":\(jsonString(appName)),\"pid\":\(pid),\"axAvailable\":\(available),\"elements\":[\(rows.joined(separator: ","))]}")

case "press":
    guard let pi = args.firstIndex(of: "--path"), pi + 1 < args.count else {
        print(#"{"error":"missing-path"}"#); exit(4)
    }
    let path = args[pi + 1]
    let all = args.contains("--all")
    // The path's first segment is the window index only in --all mode.
    let comps = path.split(separator: "/").map { Int($0) ?? -1 }
    let windows = focusedWindow(app, all: all)
    guard !windows.isEmpty else { print(#"{"error":"no-window"}"#); exit(5) }

    var el: AXUIElement? = all ? (comps.first.flatMap { windows.indices.contains($0) ? windows[$0] : nil }) : windows[0]
    for idx in comps.dropFirst(all ? 1 : 0) {
        let kids = el.map(children) ?? []
        guard kids.indices.contains(idx) else { print(#"{"error":"path-not-found"}"#); exit(6) }
        el = kids[idx]
    }
    guard let target = el else { print(#"{"error":"path-not-found"}"#); exit(6) }
    let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
    if result == .success {
        print("{\"ok\":true,\"label\":\(jsonString(label(target)))}")
    } else {
        print("{\"ok\":false,\"code\":\(result.rawValue)}")
        exit(7)
    }

default:
    print(#"{"error":"unknown-command"}"#); exit(1)
}
