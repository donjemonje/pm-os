// PM-OS local scan station — the menu bar indicator (Daniel 2026-11-12).
//
// The station (poller.mjs) starts scans without asking; this is the small sign on the Mac that it is there and what
// it is doing. One icon in the menu bar for every installed environment (~/.pmos/<env>/status.json, written by the
// poller): a quiet icon when idle, the icon plus the page count while a scan is being read, a warning sign when a
// station has not checked in. The menu shows one line per environment, the last scan, "Check in now" and "Open log".
// It only reads files and starts the station's own LaunchAgent: no network, no key, nothing of PM-OS in it.
//
//   swiftc -O -swift-version 5 menubar.swift -o ~/.pmos/bin/pmos-station-menu     (install-menu.sh does this)
//   pmos-station-menu [--root ~/.pmos]

import AppKit

struct LastScan: Decodable {
    let competitor: String?
    let pagesRead: Int?
    let finishedAt: String?
    let result: String?
}

struct Status: Decodable {
    let state: String?
    let station: String?
    let appUrl: String?
    let lastCheckIn: String?
    let message: String?
    let competitor: String?
    let pagesRead: Int?
    let scanStartedAt: String?
    let waiting: Int?
    let updatedAt: String?
    let lastScan: LastScan?
}

struct Env {
    let name: String
    let dir: URL
    let status: Status?
}

/// The station checks in every 15 minutes: nothing for this long (and no scan being read) means it is not running.
let silentAfter: TimeInterval = 20 * 60
/// A scan that wrote nothing for this long has stopped (a page takes seconds; the longest wait is a 2-minute request).
let stalledAfter: TimeInterval = 10 * 60

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func date(_ s: String?) -> Date? {
    guard let s = s else { return nil }
    return iso.date(from: s)
}

func clock(_ d: Date?) -> String {
    guard let d = d else { return "never" }
    let f = DateFormatter()
    f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM HH:mm"
    return f.string(from: d)
}

func minutes(since d: Date?) -> String {
    guard let d = d else { return "" }
    let m = max(0, Int(Date().timeIntervalSince(d) / 60))
    return m < 1 ? "under a minute" : m < 60 ? "\(m) min" : "\(m / 60) h \(m % 60) min"
}

enum Health { case idle, scanning, warning }

func health(_ s: Status?) -> Health {
    guard let s = s else { return .warning }
    let updated = date(s.updatedAt)
    if s.state == "scanning" {
        if let u = updated, Date().timeIntervalSince(u) > stalledAfter { return .warning }
        return .scanning
    }
    if s.state == "unreachable" { return .warning }
    guard let seen = date(s.lastCheckIn), Date().timeIntervalSince(seen) <= silentAfter else { return .warning }
    return .idle
}

func line(_ e: Env) -> String {
    guard let s = e.status else { return "\(e.name): no check-in yet" }
    switch health(s) {
    case .scanning:
        let more = (s.waiting ?? 0) > 0 ? " · \(s.waiting!) more waiting" : ""
        return "\(e.name): scanning \(s.competitor ?? "a site") · \(s.pagesRead ?? 0) pages · \(minutes(since: date(s.scanStartedAt)))\(more)"
    case .idle:
        return "\(e.name): on · last check-in \(clock(date(s.lastCheckIn)))"
    case .warning:
        if s.state == "scanning" { return "\(e.name): scan of \(s.competitor ?? "a site") stopped · no page since \(clock(date(s.updatedAt)))" }
        if s.state == "unreachable" { return "\(e.name): PM-OS not reachable · last check-in \(clock(date(s.lastCheckIn)))" }
        return "\(e.name): not running · last check-in \(clock(date(s.lastCheckIn)))"
    }
}

@MainActor
final class Indicator: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let root: URL
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var envs: [Env] = []

    init(root: URL) {
        self.root = root
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.delegate = self
        item.menu = menu
        refresh()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    /// Every folder under the root that holds a station key or a status file is one environment.
    func load() -> [Env] {
        let fm = FileManager.default
        let dirs = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        var out: [Env] = []
        for dir in dirs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let file = dir.appendingPathComponent("status.json")
            let hasKey = fm.fileExists(atPath: dir.appendingPathComponent("station-key").path)
            let status = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Status.self, from: $0) }
            if status == nil && !hasKey { continue }
            out.append(Env(name: dir.lastPathComponent, dir: dir, status: status))
        }
        return out
    }

    func refresh() {
        envs = load()
        let states = envs.map { health($0.status) }
        let scanning = envs.first { health($0.status) == .scanning }
        let warn = scanning == nil && (states.contains(.warning) || envs.isEmpty)
        let symbol = warn ? "exclamationmark.triangle" : "dot.radiowaves.left.and.right"
        guard let button = item.button else { return }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "PM-OS local station")
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading
        // Idle: the icon alone, dimmed. Scanning: the icon and the pages read so far.
        button.appearsDisabled = scanning == nil && !warn
        button.title = scanning.map { " \($0.status?.pagesRead ?? 0)" } ?? ""
        button.toolTip = envs.isEmpty ? "PM-OS local station: not installed" : envs.map(line).joined(separator: "\n")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refresh()
        menu.removeAllItems()
        let head = NSMenuItem(title: "PM-OS local station", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        if envs.isEmpty {
            let none = NSMenuItem(title: "No station installed under \(root.path)", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        for (i, e) in envs.enumerated() {
            menu.addItem(.separator())
            let l = NSMenuItem(title: line(e), action: nil, keyEquivalent: "")
            l.isEnabled = false
            menu.addItem(l)
            if let last = e.status?.lastScan, let name = last.competitor {
                let t = NSMenuItem(title: "Last scan: \(name) · \(last.pagesRead ?? 0) pages · \(clock(date(last.finishedAt))) · \(last.result ?? "")", action: nil, keyEquivalent: "")
                t.isEnabled = false
                menu.addItem(t)
            }
            if health(e.status) == .warning, let m = e.status?.message, e.status?.state == "unreachable" {
                let t = NSMenuItem(title: String(m.prefix(110)), action: nil, keyEquivalent: "")
                t.isEnabled = false
                menu.addItem(t)
            }
            let check = NSMenuItem(title: "Check in now (\(e.name))", action: #selector(checkIn(_:)), keyEquivalent: "")
            check.target = self
            check.tag = i
            // A check-in while a scan is being read would restart the station in the middle of it.
            check.isEnabled = health(e.status) != .scanning
            menu.addItem(check)
            let log = NSMenuItem(title: "Open log (\(e.name))", action: #selector(openLog(_:)), keyEquivalent: "")
            log.target = self
            log.tag = i
            menu.addItem(log)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Hide this icon until the next login", action: #selector(quit(_:)), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
    }

    @objc func checkIn(_ sender: NSMenuItem) {
        guard envs.indices.contains(sender.tag) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "gui/\(getuid())/com.pm-os.local-scan.\(envs[sender.tag].name)"]
        try? p.run()
    }

    @objc func openLog(_ sender: NSMenuItem) {
        guard envs.indices.contains(sender.tag) else { return }
        NSWorkspace.shared.open(envs[sender.tag].dir.appendingPathComponent("local-scan.log"))
    }

    @objc func quit(_ sender: NSMenuItem) {
        NSApp.terminate(nil)
    }
}

let arguments = CommandLine.arguments
let rootPath: String = {
    if let i = arguments.firstIndex(of: "--root"), arguments.indices.contains(i + 1) { return arguments[i + 1] }
    return NSHomeDirectory() + "/.pmos"
}()

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let indicator = Indicator(root: URL(fileURLWithPath: rootPath))
    app.delegate = indicator
    app.setActivationPolicy(.accessory)
    app.run()
}
