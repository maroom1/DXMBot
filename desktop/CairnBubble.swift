// CairnBubble.swift — native macOS shell for the Cairn personal assistant.
//
// A floating, always-on-top, draggable animated avatar (non-activating NSPanel, 88×88) that expands into a
// 400×620 chat panel hosting http://127.0.0.1:<port>/web/bubble.html in a WKWebView.
// The avatar is a transparent WKWebView showing one of the web/avatars/avatar-*.html styles (bundled into
// Contents/Resources/avatars by build.sh so it renders even while the server is down); a transparent overlay
// view on top owns all mouse handling (click toggles the chat, drag moves, right-click menu, hover). If the
// avatar page cannot load, the native-drawn bubble (gradient + cairn glyph, progress ring, badge) is shown.
// The app keeps the Cairn server alive (auto-start + watchdog), polls /api/assistant/health every 3 s and
// maps it to window.cairnAvatar.setState(idle|working|attention|offline|listening, {running, approvals}),
// and listens to /api/assistant/events so reminders/approvals get the user's attention while the panel is hidden.
// It is a regular Dock app (LSUIElement=false; UserDefaults CairnShowInDock=false switches it to an accessory app
// at runtime): the Dock icon reopens the chat, its menu has Open Chat / New Chat / Dashboard / Docs / status /
// Start at Login, its badge counts pending approvals, and the main menu bar (App, Edit, Window, Help) makes
// ⌘C/⌘V/⌘A/⌘Z work inside the chat's WKWebView.
//
// Build: bash desktop/build.sh  (swiftc -O -swift-version 5 -parse-as-library -framework Cocoa -framework WebKit)
// Paths (project root, node, PATH, port) are baked into Contents/Info.plist by build.sh because GUI
// apps do not inherit the shell PATH (node usually lives under ~/.nvm).

import Cocoa
import WebKit
import Carbon.HIToolbox

// MARK: - Constants & configuration

enum Keys {
    static let origin = "CairnBubbleOrigin"
    static let startAtLogin = "CairnStartAtLogin"
    static let openOnAttention = "CairnOpenOnAttention"
    static let globalHotkey = "CairnGlobalHotkey"
    static let autoStartServer = "CairnAutoStartServer"
    static let serverPid = "CairnServerPid"
    static let avatarStyle = "CairnAvatarStyle"
    /// true (default) → regular app with a Dock icon and menu bar; false → accessory app (bubble only).
    static let showInDock = "CairnShowInDock"

    /// Registered (not written) defaults; called before the activation policy is applied at launch.
    static func registerDefaults(_ d: UserDefaults = .standard) {
        d.register(defaults: [
            globalHotkey: true,
            autoStartServer: true,
            openOnAttention: false,
            startAtLogin: false,
            showInDock: true,
        ])
    }
}

struct CairnConfig {
    let root: String
    let nodePath: String?
    let pathEnv: String
    let port: Int

    var base: String { "http://127.0.0.1:\(port)" }
    func url(_ path: String) -> URL { URL(string: base + path) ?? URL(string: "http://127.0.0.1:8787/")! }
    var bubbleURL: URL { url("/web/bubble.html") }
    var dataDir: String { root + "/data" }
    var logPath: String { dataDir + "/server.log" }
    var cliPath: String { root + "/bin/cairn.js" }

    static func load() -> CairnConfig {
        let fm = FileManager.default
        let info = Bundle.main.infoDictionary ?? [:]
        let env = ProcessInfo.processInfo.environment
        func str(_ key: String) -> String? {
            if let s = info[key] as? String, !s.isEmpty { return s }
            return nil
        }
        var root = env["CAIRN_ROOT"] ?? str("CairnProjectRoot") ?? ""
        if root.isEmpty || !fm.fileExists(atPath: root + "/bin/cairn.js") {
            // Fall back to the bundle location: <root>/desktop/build/Cairn.app
            var u = Bundle.main.bundleURL
            for _ in 0..<4 {
                u = u.deletingLastPathComponent()
                if fm.fileExists(atPath: u.path + "/bin/cairn.js") { root = u.path; break }
            }
        }
        let home = NSHomeDirectory()
        let fallbackPath = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .joined(separator: ":")
        let pathEnv = str("CairnPath") ?? fallbackPath
        var port = 8787
        if let p = env["CAIRN_PORT"].flatMap({ Int($0) }) { port = p }
        else if let n = info["CairnPort"] as? NSNumber { port = n.intValue }
        else if let s = info["CairnPort"] as? String, let n = Int(s) { port = n }
        let node = resolveNode(baked: env["CAIRN_NODE"] ?? str("CairnNodePath"), pathEnv: pathEnv)
        return CairnConfig(root: root, nodePath: node, pathEnv: pathEnv, port: port)
    }

    /// The baked node path first; then PATH; then the newest ~/.nvm install (survives nvm upgrades).
    static func resolveNode(baked: String?, pathEnv: String) -> String? {
        let fm = FileManager.default
        if let b = baked, fm.isExecutableFile(atPath: b) { return b }
        for dir in pathEnv.split(separator: ":") {
            let candidate = "\(dir)/node"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        let nvm = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            for v in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) {
                let candidate = "\(nvm)/\(v)/bin/node"
                if fm.isExecutableFile(atPath: candidate) { return candidate }
            }
        }
        return nil
    }
}

let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0.0"

// MARK: - Logging (appends to <root>/data/server.log, shared with the server child)

enum Log {
    static var fd: Int32 = -1

    static func open(_ path: String) {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if let attrs = try? fm.attributesOfItem(atPath: path), let size = attrs[.size] as? NSNumber, size.int64Value > 5_000_000 {
            let old = path + ".1"
            try? fm.removeItem(atPath: old)
            try? fm.moveItem(atPath: path, toPath: old)
        }
        fd = Darwin.open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    }

    static func write(_ message: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(stamp)] [cairn-desktop] \(message)\n"
        if fd >= 0 {
            _ = line.withCString { ptr in Darwin.write(fd, ptr, strlen(ptr)) }
        }
        NSLog("Cairn: %@", message)
    }
}

// MARK: - Process helpers

/// True if the pid exists and is not a zombie.
func isAlive(_ pid: pid_t) -> Bool {
    if pid <= 0 { return false }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    if sysctl(&mib, 4, &info, &size, nil, 0) != 0 || size == 0 { return false }
    if info.kp_proc.p_pid != pid { return false }
    return Int32(info.kp_proc.p_stat) != 5 // SZOMB
}

func commandLine(of pid: pid_t) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-p", String(pid), "-o", "command="]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return s.isEmpty ? nil : s
}

/// SIGTERM, wait up to `timeout`, then SIGKILL. Safe to call from any thread.
func terminateProcess(pid: pid_t, timeout: TimeInterval) {
    guard pid > 0, isAlive(pid) else { return }
    kill(pid, SIGTERM)
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if !isAlive(pid) { return }
        usleep(50_000)
    }
    Log.write("server pid \(pid) ignored SIGTERM for \(Int(timeout)) s; sending SIGKILL")
    kill(pid, SIGKILL)
}

func appleScriptString(_ s: String) -> String {
    "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

/// Runs osascript (never through a shell) on a background queue; completion on main.
func runAppleScript(_ source: String, completion: @escaping (Bool, String) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", source]
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        var ok = false
        var text = ""
        do {
            try p.run()
            let o = out.fileHandleForReading.readDataToEndOfFile()
            let e = err.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            ok = p.terminationStatus == 0
            text = (String(decoding: o, as: UTF8.self) + String(decoding: e, as: UTF8.self))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            text = error.localizedDescription
        }
        DispatchQueue.main.async { completion(ok, text) }
    }
}

func parseISODate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

func screenFor(_ rect: NSRect) -> NSScreen? {
    var best: NSScreen?
    var bestArea: CGFloat = 0
    for s in NSScreen.screens {
        let i = s.frame.intersection(rect)
        if !i.isNull, i.width * i.height > bestArea {
            bestArea = i.width * i.height
            best = s
        }
    }
    return best ?? NSScreen.screens.first
}

// MARK: - Health polling

struct Health {
    var reachable = false
    var assistantApi = false
    var runningRuns = 0
    var queuedRuns = 0
    var pendingApprovals = 0
    var nextTaskAt: Date?
    var claudeAvailable: Bool?
}

final class HealthClient {
    private let base: String
    private let session: URLSession

    init(base: String) {
        self.base = base
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 2.5
        c.timeoutIntervalForResource = 5
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.connectionProxyDictionary = [:] // never route loopback through a corporate proxy
        c.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: c)
    }

    /// GET /api/assistant/health; if that route is missing (engine not integrated yet) fall back to /api/health.
    func check(_ done: @escaping (Health) -> Void) {
        get("/api/assistant/health") { status, json in
            if status == 200, let j = json {
                done(HealthClient.parse(j))
                return
            }
            if status == 0 {
                done(Health())
                return
            }
            self.get("/api/health") { s2, j2 in
                var h = Health()
                h.reachable = (s2 == 200)
                if let c = j2?["claude"] as? Bool { h.claudeAvailable = c }
                else if let c = j2?["claude"] as? [String: Any] { h.claudeAvailable = c["available"] as? Bool }
                done(h)
            }
        }
    }

    private func get(_ path: String, _ done: @escaping (Int, [String: Any]?) -> Void) {
        guard let url = URL(string: base + path) else { done(0, nil); return }
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        session.dataTask(with: req) { data, resp, err in
            let status = err == nil ? ((resp as? HTTPURLResponse)?.statusCode ?? 0) : 0
            var json: [String: Any]?
            if let d = data, !d.isEmpty { json = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] }
            done(status, json)
        }.resume()
    }

    static func int(_ v: Any?) -> Int {
        if let n = v as? NSNumber { return n.intValue }
        if let a = v as? [Any] { return a.count }
        if let s = v as? String { return Int(s) ?? 0 }
        return 0
    }

    static func parse(_ j: [String: Any]) -> Health {
        var h = Health()
        h.reachable = true
        h.assistantApi = true
        h.runningRuns = int(j["runningRuns"])
        h.queuedRuns = int(j["queuedRuns"])
        h.pendingApprovals = int(j["pendingApprovals"])
        if let s = j["nextTaskAt"] as? String { h.nextTaskAt = parseISODate(s) }
        if let c = j["claude"] as? Bool { h.claudeAvailable = c }
        else if let c = j["claude"] as? [String: Any] { h.claudeAvailable = c["available"] as? Bool }
        return h
    }
}

// MARK: - Server-sent events (/api/assistant/events) — native so alerts work while the panel is hidden

final class EventStream: NSObject, URLSessionDataDelegate {
    private let url: URL
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var stopped = true
    private var retryDelay: TimeInterval = 3
    var onEvent: ((String, [String: Any]) -> Void)? // delivered on main

    init(url: URL) {
        self.url = url
        super.init()
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 90 // idle timeout; the server heartbeats every 15 s
        c.timeoutIntervalForResource = 7 * 24 * 3600
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.connectionProxyDictionary = [:]
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        session = URLSession(configuration: c, delegate: self, delegateQueue: q)
    }

    var isRunning: Bool { !stopped }

    func start() {
        guard stopped else { return }
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        task?.cancel()
        task = nil
    }

    func restart() {
        stop()
        start()
    }

    private func connect() {
        guard !stopped else { return }
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let t = session.dataTask(with: req)
        task = t
        t.resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        buffer.removeAll()
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            retryDelay = 3
            completionHandler(.allow)
        } else {
            retryDelay = 30 // route not available yet (engine being integrated) — check back slowly
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(Data(data.filter { $0 != 0x0D }))
        let sep = Data([0x0A, 0x0A])
        while let r = buffer.range(of: sep) {
            let block = buffer.subdata(in: buffer.startIndex..<r.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<r.upperBound)
            handleBlock(String(decoding: block, as: UTF8.self))
        }
        if buffer.count > 2_000_000 { buffer.removeAll() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let delay = retryDelay
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, !self.stopped else { return }
            if let current = self.task, current !== task, current.state == .running { return }
            self.connect()
        }
    }

    private func handleBlock(_ block: String) {
        var name = "message"
        var dataLines: [String] = []
        for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                var v = String(line.dropFirst(5))
                if v.hasPrefix(" ") { v.removeFirst() }
                dataLines.append(v)
            }
        }
        if dataLines.isEmpty && name == "message" { return }
        let raw = dataLines.joined(separator: "\n")
        var payload: [String: Any] = [:]
        if let d = raw.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) {
            if let dict = obj as? [String: Any] { payload = dict } else { payload = ["value": obj] }
        } else if !raw.isEmpty {
            payload = ["text": raw]
        }
        let eventName = name
        let eventPayload = payload
        DispatchQueue.main.async { [weak self] in self?.onEvent?(eventName, eventPayload) }
    }
}

// MARK: - Server child (auto-start + watchdog restarts)

final class ServerManager {
    let cfg: CairnConfig
    private(set) var process: Process?
    private(set) var adoptedPid: pid_t = 0
    /// True once this app has started (or adopted) the server; Quit then stops it and the watchdog restarts it.
    private(set) var startedByUs = false
    private(set) var lastError: String?
    private var stopping = false
    var onUnexpectedExit: ((Int32) -> Void)?

    init(cfg: CairnConfig) { self.cfg = cfg }

    var isChildRunning: Bool { (process?.isRunning ?? false) || isAlive(adoptedPid) }

    /// A server we spawned in an earlier session (e.g. the app was force-killed) is re-adopted so
    /// Quit / the watchdog still manage it.
    func adoptIfOurs() {
        let stored = pid_t(UserDefaults.standard.integer(forKey: Keys.serverPid))
        guard stored > 0 else { return }
        if isAlive(stored), let cmd = commandLine(of: stored), cmd.contains("cairn.js"), cmd.contains(" serve"),
           cmd.contains("--port \(cfg.port)") {
            adoptedPid = stored
            startedByUs = true
            Log.write("re-adopted Cairn server pid \(stored) started by an earlier session of this app")
        } else {
            UserDefaults.standard.removeObject(forKey: Keys.serverPid)
        }
    }

    @discardableResult
    func start() -> Bool {
        let fm = FileManager.default
        guard let node = cfg.nodePath else {
            lastError = "Node.js not found — rebuild with desktop/build.sh"
            Log.write(lastError!)
            return false
        }
        guard fm.fileExists(atPath: cfg.cliPath) else {
            lastError = "Missing \(cfg.cliPath)"
            Log.write(lastError!)
            return false
        }
        if let p = process, p.isRunning { return true }
        try? fm.createDirectory(atPath: cfg.dataDir, withIntermediateDirectories: true)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cfg.cliPath, "serve", "--port", String(cfg.port)]
        p.currentDirectoryURL = URL(fileURLWithPath: cfg.root)
        var env = ProcessInfo.processInfo.environment
        let nodeDir = (node as NSString).deletingLastPathComponent
        var path = cfg.pathEnv
        if !path.split(separator: ":").contains(Substring(nodeDir)) { path = nodeDir + ":" + path }
        env["PATH"] = path
        env["CAIRN_DESKTOP"] = "1"
        env["NO_COLOR"] = "1"
        env.removeValue(forKey: "FORCE_COLOR")
        if env["HOME"] == nil { env["HOME"] = NSHomeDirectory() }
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        if Log.fd >= 0 {
            let h = FileHandle(fileDescriptor: Log.fd, closeOnDealloc: false)
            p.standardOutput = h
            p.standardError = h
        } else {
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            DispatchQueue.main.async { self?.handleExit(proc, status: status) }
        }
        do {
            try p.run()
        } catch {
            lastError = "Could not start the server: \(error.localizedDescription)"
            Log.write(lastError!)
            return false
        }
        process = p
        startedByUs = true
        stopping = false
        lastError = nil
        UserDefaults.standard.set(Int(p.processIdentifier), forKey: Keys.serverPid)
        Log.write("started server pid \(p.processIdentifier): \(node) \(cfg.cliPath) serve --port \(cfg.port)")
        return true
    }

    private func handleExit(_ proc: Process, status: Int32) {
        guard proc === process else { return } // an old child replaced by a restart
        process = nil
        UserDefaults.standard.removeObject(forKey: Keys.serverPid)
        if stopping {
            Log.write("server stopped (status \(status))")
        } else {
            Log.write("server exited unexpectedly (status \(status)) — see this log above")
            onUnexpectedExit?(status)
        }
    }

    /// Stop everything and start a fresh child (off the main thread while waiting).
    func restart(then: @escaping () -> Void) {
        stopping = true
        let pids = [process?.processIdentifier ?? 0, adoptedPid].filter { $0 > 0 }
        process = nil
        adoptedPid = 0
        DispatchQueue.global(qos: .userInitiated).async {
            for pid in pids { terminateProcess(pid: pid, timeout: 3) }
            DispatchQueue.main.async {
                self.stopping = false
                self.start()
                then()
            }
        }
    }

    /// Blocking stop used when the app quits (the server is only ever stopped if this app started it).
    func stopForQuit() {
        stopping = true
        var pids: [pid_t] = []
        if let p = process, p.isRunning { pids.append(p.processIdentifier) }
        if adoptedPid > 0 { pids.append(adoptedPid) }
        process = nil
        adoptedPid = 0
        UserDefaults.standard.removeObject(forKey: Keys.serverPid)
        for pid in pids {
            Log.write("stopping server pid \(pid)")
            terminateProcess(pid: pid, timeout: 4)
        }
    }
}

// MARK: - Bubble drawing

enum Art {
    static let teal = NSColor(srgbRed: 0.18, green: 0.83, blue: 0.75, alpha: 1)
    static let indigo = NSColor(srgbRed: 0.31, green: 0.27, blue: 0.90, alpha: 1)
    static let ring = NSColor(srgbRed: 0.37, green: 0.92, blue: 0.83, alpha: 1)
    static let red = NSColor(srgbRed: 0.94, green: 0.27, blue: 0.27, alpha: 1)
    static let amber = NSColor(srgbRed: 0.96, green: 0.62, blue: 0.04, alpha: 1)

    /// Gradient circle + a stacked-stones (cairn) glyph, drawn with NSBezierPath.
    static func drawBubble(in rect: NSRect) {
        let circle = NSBezierPath(ovalIn: rect)
        NSGradient(colors: [teal, indigo])?.draw(in: circle, angle: -55)

        // soft top highlight
        NSGraphicsContext.saveGraphicsState()
        circle.addClip()
        let hl = NSBezierPath(ovalIn: NSRect(x: rect.minX + rect.width * 0.12, y: rect.minY + rect.height * 0.52,
                                             width: rect.width * 0.76, height: rect.height * 0.55))
        NSColor.white.withAlphaComponent(0.10).setFill()
        hl.fill()
        NSGraphicsContext.restoreGraphicsState()

        let ringPath = NSBezierPath(ovalIn: rect.insetBy(dx: rect.width * 0.012, dy: rect.height * 0.012))
        ringPath.lineWidth = max(1, rect.width * 0.02)
        NSColor.white.withAlphaComponent(0.22).setStroke()
        ringPath.stroke()

        // stones: (width, height, bottom y, rotation, x offset) in a 64-unit design grid
        let s = rect.width / 64
        let stones: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (31, 11.5, 15.5, 0, 0),
            (22.5, 9.5, 28.5, 5, -1.2),
            (14, 8, 39.5, -7, 1.0),
        ]
        for (i, st) in stones.enumerated() {
            let (w, h, y, rot, dx) = st
            let p = NSBezierPath(ovalIn: NSRect(x: -w * s / 2, y: -h * s / 2, width: w * s, height: h * s))
            p.transform(using: AffineTransform(rotationByDegrees: rot))
            p.transform(using: AffineTransform(translationByX: rect.midX + dx * s, byY: rect.minY + (y + h / 2) * s))
            // subtle shadow under each stone
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.22)
            shadow.shadowOffset = NSSize(width: 0, height: -1.2 * s)
            shadow.shadowBlurRadius = 1.8 * s
            shadow.set()
            NSColor.white.withAlphaComponent(i == 0 ? 0.97 : (i == 1 ? 0.93 : 0.90)).setFill()
            p.fill()
            NSGraphicsContext.restoreGraphicsState()
        }
    }

    static func bubbleImage(side: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: side, height: side), flipped: false) { r in
            drawBubble(in: r)
            return true
        }
    }

    static func badgeImage(text: String, side: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: side, height: side), flipped: false) { r in
            let body = NSBezierPath(ovalIn: r.insetBy(dx: 1, dy: 1))
            red.setFill()
            body.fill()
            body.lineWidth = 1.5
            NSColor.white.setStroke()
            body.stroke()
            let font = NSFont.systemFont(ofSize: text.count > 1 ? side * 0.45 : side * 0.55, weight: .bold)
            let str = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.white])
            let sz = str.size()
            str.draw(at: NSPoint(x: r.midX - sz.width / 2, y: r.midY - sz.height / 2 + 0.5))
            return true
        }
    }

    /// Used by build.sh to generate the app icon from the same drawing code.
    static func renderIcon(to path: String) -> Bool {
        let px = 1024
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return false }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        NSColor.clear.set()
        NSRect(x: 0, y: 0, width: px, height: px).fill()
        drawBubble(in: NSRect(x: 100, y: 100, width: 824, height: 824))
        ctx.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }
}

// MARK: - Bubble panel + view

final class BubblePanel: NSPanel {
    init(side: CGFloat) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: side, height: side),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false // the circle layer carries its own shadow
        hidesOnDeactivate = false
        isMovable = false // we move it ourselves (click-vs-drag detection)
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = true
        worksWhenModal = true
        animationBehavior = .none
        isExcludedFromWindowsMenu = true
        title = "Cairn"
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Native-drawn bubble: gradient circle + cairn glyph, progress ring, badge, offline dot.
/// Shown only when the animated avatar page is unavailable (it draws its own ring/badge/dot).
/// Mouse handling lives in `BubbleOverlayView` above it.
final class BubbleView: NSView {
    /// The window is a square `side`×`side`; the circle (≈72% of it, matching the avatar orb) sits centred.
    static let side: CGFloat = 88
    static let circle: CGFloat = 64
    static var margin: CGFloat { (side - circle) / 2 }

    private let bodyLayer = CALayer()
    private let haloLayer = CAShapeLayer()
    private let trackLayer = CAShapeLayer()
    private let ringLayer = CAShapeLayer()
    private let badgeLayer = CALayer()
    private let dotLayer = CALayer()
    private(set) var badgeText: String?
    private(set) var spinning = false
    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false
        setupLayers()
        setAccessibilityElement(false) // the overlay is the accessible button
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func setupLayers() {
        guard let root = layer else { return }
        let b = bounds
        let c = CGPoint(x: b.midX, y: b.midY)
        let r = BubbleView.circle / 2

        haloLayer.frame = b
        haloLayer.path = CGPath(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2), transform: nil)
        haloLayer.fillColor = NSColor.clear.cgColor
        haloLayer.strokeColor = Art.ring.withAlphaComponent(0.85).cgColor
        haloLayer.lineWidth = 3
        haloLayer.opacity = 0
        root.addSublayer(haloLayer)

        bodyLayer.frame = CGRect(x: c.x - r, y: c.y - r, width: BubbleView.circle, height: BubbleView.circle)
        bodyLayer.shadowColor = NSColor.black.cgColor
        bodyLayer.shadowOpacity = 0.35
        bodyLayer.shadowRadius = 3.5
        bodyLayer.shadowOffset = CGSize(width: 0, height: -1.5)
        bodyLayer.shadowPath = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: BubbleView.circle, height: BubbleView.circle), transform: nil)
        root.addSublayer(bodyLayer)

        let ringRadius = r + 3.2
        let ringPath = CGPath(ellipseIn: CGRect(x: c.x - ringRadius, y: c.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2), transform: nil)
        for l in [trackLayer, ringLayer] {
            l.frame = b
            l.path = ringPath
            l.fillColor = NSColor.clear.cgColor
            l.lineWidth = 2.6
            l.isHidden = true
            root.addSublayer(l)
        }
        trackLayer.strokeColor = NSColor.white.withAlphaComponent(0.28).cgColor
        ringLayer.strokeColor = Art.ring.cgColor
        ringLayer.lineCap = .round
        ringLayer.strokeStart = 0
        ringLayer.strokeEnd = 0.3

        // badge on the circle's upper-right rim, offline dot on its lower-right rim
        let rim = r * 0.74
        let bs: CGFloat = 20
        badgeLayer.frame = CGRect(x: c.x + rim - bs / 2, y: c.y + rim - bs / 2, width: bs, height: bs)
        badgeLayer.isHidden = true
        badgeLayer.zPosition = 10
        root.addSublayer(badgeLayer)

        let ds: CGFloat = 14
        dotLayer.frame = CGRect(x: c.x + rim - ds / 2, y: c.y - rim - ds / 2, width: ds, height: ds)
        dotLayer.cornerRadius = ds / 2
        dotLayer.backgroundColor = Art.amber.cgColor
        dotLayer.borderColor = NSColor.white.cgColor
        dotLayer.borderWidth = 2
        dotLayer.isHidden = true
        dotLayer.zPosition = 10
        root.addSublayer(dotLayer)

        renderContents()
    }

    private var scale: CGFloat { window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2 }

    private func renderContents() {
        let s = scale
        for l in [bodyLayer, haloLayer, trackLayer, ringLayer, badgeLayer, dotLayer] { l.contentsScale = s }
        bodyLayer.contents = Art.bubbleImage(side: BubbleView.circle).layerContents(forContentsScale: s)
        if let t = badgeText {
            badgeLayer.contents = Art.badgeImage(text: t, side: badgeLayer.bounds.width).layerContents(forContentsScale: s)
        }
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        renderContents()
    }

    // MARK: state

    func setRunning(_ on: Bool) {
        guard on != spinning else { return }
        spinning = on
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        trackLayer.isHidden = !on
        ringLayer.isHidden = !on
        CATransaction.commit()
        if on {
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = -2 * Double.pi
            spin.duration = reduceMotion ? 4.0 : 1.15
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            ringLayer.add(spin, forKey: "spin")
            let breathe = CABasicAnimation(keyPath: "strokeEnd")
            breathe.fromValue = 0.18
            breathe.toValue = 0.42
            breathe.duration = 0.9
            breathe.autoreverses = true
            breathe.repeatCount = .infinity
            breathe.isRemovedOnCompletion = false
            breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            if !reduceMotion { ringLayer.add(breathe, forKey: "breathe") }
        } else {
            ringLayer.removeAllAnimations()
        }
    }

    func setBadge(_ text: String?) {
        guard text != badgeText else { return }
        badgeText = text
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let t = text {
            badgeLayer.contents = Art.badgeImage(text: t, side: badgeLayer.bounds.width).layerContents(forContentsScale: scale)
            badgeLayer.isHidden = false
        } else {
            badgeLayer.isHidden = true
        }
        CATransaction.commit()
        if text != nil && !reduceMotion && !isHidden {
            let pop = CAKeyframeAnimation(keyPath: "transform.scale")
            pop.values = [0.4, 1.2, 1.0]
            pop.duration = 0.3
            badgeLayer.add(pop, forKey: "pop")
        }
    }

    func setOffline(_ offline: Bool) {
        guard dotLayer.isHidden == offline else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dotLayer.isHidden = !offline
        CATransaction.commit()
    }

    func setHover(_ on: Bool) {
        bodyLayer.setAffineTransform(on ? CGAffineTransform(scaleX: 1.05, y: 1.05) : .identity)
    }

    /// Attention pulse: the bubble throbs and a halo ripples outward.
    func pulse(times: Float = 3) {
        guard !isHidden else { return }
        if !reduceMotion {
            let s = CABasicAnimation(keyPath: "transform.scale")
            s.fromValue = 1.0
            s.toValue = 1.12
            s.duration = 0.26
            s.autoreverses = true
            s.repeatCount = times
            s.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            bodyLayer.add(s, forKey: "pulse")
        }
        let hs = CABasicAnimation(keyPath: "transform.scale")
        hs.fromValue = 0.94
        hs.toValue = reduceMotion ? 0.94 : 1.17
        let ho = CABasicAnimation(keyPath: "opacity")
        ho.fromValue = 0.95
        ho.toValue = 0.0
        let g = CAAnimationGroup()
        g.animations = [hs, ho]
        g.duration = 0.95
        g.repeatCount = times
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        haloLayer.add(g, forKey: "halo")
    }
}

/// Transparent view above the avatar web view and the native bubble; owns ALL mouse handling:
/// drag anywhere moves the window, a click without movement toggles the chat panel, right-click (or
/// ctrl-click) opens the menu, hover over the orb scales it slightly.
final class BubbleOverlayView: NSView {
    var onClick: (() -> Void)?
    var onDragMoved: (() -> Void)?
    var onDragEnded: (() -> Void)?
    var onHover: ((Bool) -> Void)?
    var menuProvider: (() -> NSMenu?)?

    private var mouseDownAt = NSPoint.zero
    private var originAtDown = NSPoint.zero
    private(set) var dragging = false
    private var tracking = false
    private var menuOpen = false
    private(set) var hovering = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Cairn assistant")
        setAccessibilityHelp("Click to open the Cairn chat. Drag to move. Right-click for options.")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { false }
    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The orb's hit area (slightly larger than the drawn circle so it is easy to grab).
    var hitCircle: NSRect {
        let r = BubbleView.circle / 2 + 4
        return NSRect(x: bounds.midX - r, y: bounds.midY - r, width: r * 2, height: r * 2)
    }

    /// An (invisible) 1/255-alpha disc: the window server passes clicks through fully transparent pixels of a
    /// non-opaque window, so this guarantees the orb is clickable whatever the web avatar draws (its content
    /// lives in another process), while the transparent corners still click through to the windows below.
    override func draw(_ dirtyRect: NSRect) {
        NSColor(white: 1, alpha: 1.0 / 255.0).setFill()
        NSBezierPath(ovalIn: hitCircle).fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: hitCircle, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    }

    private func setHover(_ on: Bool) {
        guard on != hovering else { return }
        hovering = on
        onHover?(on)
    }

    override func mouseEntered(with event: NSEvent) { setHover(true) }
    override func mouseExited(with event: NSEvent) { if !tracking { setHover(false) } }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {
            showMenu(event)
            return
        }
        tracking = true
        dragging = false
        mouseDownAt = NSEvent.mouseLocation
        originAtDown = window?.frame.origin ?? .zero
    }

    override func mouseDragged(with event: NSEvent) {
        guard tracking, let w = window else { return }
        let p = NSEvent.mouseLocation
        let dx = p.x - mouseDownAt.x
        let dy = p.y - mouseDownAt.y
        if !dragging && hypot(dx, dy) < 4 { return }
        dragging = true
        w.setFrameOrigin(NSPoint(x: originAtDown.x + dx, y: originAtDown.y + dy))
        onDragMoved?()
    }

    override func mouseUp(with event: NSEvent) {
        guard tracking else { return }
        tracking = false
        if dragging {
            dragging = false
            onDragEnded?()
        } else {
            onClick?()
        }
        if let w = window {
            let local = convert(w.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
            setHover(NSBezierPath(ovalIn: hitCircle).contains(local))
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        showMenu(event)
    }

    private func showMenu(_ event: NSEvent) {
        guard !menuOpen, let menu = menuProvider?() else { return }
        menuOpen = true
        tracking = false
        NSMenu.popUpContextMenu(menu, with: event, for: self)
        menuOpen = false
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }
}

// MARK: - Animated avatar (web/avatars/*.html in a transparent WKWebView)

struct AvatarStyle: Equatable {
    let key: String
    let file: String
    let name: String
}

/// index.json {default, styles:[{key, file, name}]} next to the avatar pages.
struct AvatarCatalog {
    /// Menu/UserDefaults key for the native-drawn bubble (no web view).
    static let classicKey = "classic"

    let dir: URL?
    let defaultKey: String
    let styles: [AvatarStyle]

    func style(_ key: String?) -> AvatarStyle? { styles.first { $0.key == key } }

    /// Bundled copy first (works with the server down and is what build.sh verified), then the project's web/avatars.
    static func candidateDirs(root: String) -> [String] {
        var c: [String] = []
        if let e = ProcessInfo.processInfo.environment["CAIRN_AVATAR_DIR"], !e.isEmpty { c.append(e) }
        if let r = Bundle.main.resourcePath { c.append(r + "/avatars") }
        if !root.isEmpty { c.append(root + "/web/avatars") }
        return c
    }

    static func load(root: String) -> AvatarCatalog {
        for d in candidateDirs(root: root) {
            let cat = parse(dir: URL(fileURLWithPath: d, isDirectory: true))
            if !cat.styles.isEmpty { return cat }
        }
        return AvatarCatalog(dir: nil, defaultKey: classicKey, styles: [])
    }

    static func isSafeFile(_ f: String) -> Bool {
        !f.isEmpty && !f.contains("/") && !f.contains("\\") && !f.hasPrefix(".") && f.lowercased().hasSuffix(".html")
    }

    static func parse(dir: URL) -> AvatarCatalog {
        let fm = FileManager.default
        var styles: [AvatarStyle] = []
        var def = ""
        if let data = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
           let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            def = (j["default"] as? String) ?? ""
            for s in (j["styles"] as? [[String: Any]]) ?? [] {
                guard let file = s["file"] as? String, isSafeFile(file),
                      fm.fileExists(atPath: dir.appendingPathComponent(file).path) else { continue }
                var key = (s["key"] as? String) ?? ""
                if key.isEmpty { key = String((file as NSString).deletingPathExtension.replacingOccurrences(of: "avatar-", with: "")) }
                if key == classicKey || styles.contains(where: { $0.key == key }) { continue }
                let name = (s["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? key.capitalized
                styles.append(AvatarStyle(key: key, file: file, name: name))
            }
        }
        if styles.isEmpty, let files = try? fm.contentsOfDirectory(atPath: dir.path) {
            // no (valid) index.json: any avatar-*.html still works
            for f in files.sorted() where f.hasPrefix("avatar-") && isSafeFile(f) {
                let key = String((f as NSString).deletingPathExtension.dropFirst("avatar-".count))
                if !key.isEmpty && key != classicKey { styles.append(AvatarStyle(key: key, file: f, name: key.capitalized)) }
            }
        }
        if let byFile = styles.first(where: { $0.file == def }) { def = byFile.key } // "default" may name the file
        if !styles.contains(where: { $0.key == def }) { def = styles.first?.key ?? classicKey }
        return AvatarCatalog(dir: dir, defaultKey: def, styles: styles)
    }
}

enum AvatarState: String, CaseIterable {
    case idle, working, attention, offline, listening
}

/// Hosts the avatar page. `onAvailability(true)` once the page loaded and exposes window.cairnAvatar.setState;
/// `onAvailability(false)` when it failed (missing file, load error, no API, crashed repeatedly).
final class AvatarController: NSObject, WKNavigationDelegate {
    static let injectedCSS = """
    html,body{background:transparent!important;overflow:hidden!important;margin:0!important;width:100%!important;height:100%!important}
    html,body,body *{pointer-events:none!important}
    ::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
    body{transition:transform 320ms cubic-bezier(.2,.8,.2,1);transform-origin:50% 50%}
    html.cairn-hover:not(.cairn-hover-native) body{transform:scale(1.05)}
    """

    let webView: WKWebView
    private(set) var style: AvatarStyle?
    private(set) var ready = false
    private(set) var failed = false
    private(set) var lastError: String?
    private var dir: URL?
    private var state: AvatarState = .idle
    private var running = 0
    private var approvals = 0
    private var hover = false
    private var lastSent: String?
    private var generation = 0
    private var crashes: [Date] = []
    var onAvailability: ((Bool) -> Void)?

    override init() {
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .nonPersistent()
        conf.suppressesIncrementalRendering = true
        conf.applicationNameForUserAgent = "CairnDesktop/\(appVersion)"
        let ucc = WKUserContentController()
        // Mouse events belong to the native overlay: disable page hit-testing (so :hover never fires), keep it transparent.
        let css = AvatarController.injectedCSS.replacingOccurrences(of: "\n", with: " ")
        ucc.addUserScript(WKUserScript(source: """
            (function(){var s=document.createElement('style');s.id='cairn-native-style';s.textContent=\(jsString(css));
            (document.head||document.documentElement).appendChild(s);})();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        conf.userContentController = ucc
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: BubbleView.side, height: BubbleView.side), configuration: conf)
        wv.setValue(false, forKey: "drawsBackground") // transparent: only the orb is visible
        if #available(macOS 12.0, *) { wv.underPageBackgroundColor = .clear }
        wv.allowsMagnification = false
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        wv.setAccessibilityElement(false)
        webView = wv
        super.init()
        webView.navigationDelegate = self
    }

    /// Load `style` from `dir` (instant switch: the previous page stays until the new one has rendered).
    func load(_ style: AvatarStyle, from dir: URL) {
        self.style = style
        self.dir = dir
        ready = false
        failed = false
        lastSent = nil
        generation += 1
        let gen = generation
        let file = dir.appendingPathComponent(style.file)
        guard FileManager.default.fileExists(atPath: file.path) else {
            fail("missing \(file.path)")
            return
        }
        var comps = URLComponents(url: file, resolvingAgainstBaseURL: false)
        comps?.fragment = "state=\(state.rawValue)&running=\(running)&approvals=\(approvals)"
        let url = comps?.url ?? file
        webView.loadFileURL(url, allowingReadAccessTo: dir)
        // A page that never finishes (or never exposes the API) must not leave the bubble empty.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self = self, self.generation == gen, !self.ready, !self.failed else { return }
            self.fail("timed out loading \(style.file)")
        }
    }

    func unload() {
        generation += 1
        style = nil
        ready = false
        failed = false
        lastSent = nil
        webView.stopLoading()
        webView.loadHTMLString("<html><body style='background:transparent'></body></html>", baseURL: nil)
    }

    private func fail(_ why: String) {
        guard !failed else { return }
        failed = true
        ready = false
        lastError = why
        Log.write("avatar \(style?.key ?? "-") unavailable (\(why)); showing the native bubble")
        onAvailability?(false)
    }

    func setState(_ s: AvatarState, running: Int, approvals: Int) {
        state = s
        self.running = max(0, running)
        self.approvals = max(0, approvals)
        push()
    }

    private func push() {
        guard ready else { return }
        let key = "\(state.rawValue)|\(running)|\(approvals)"
        guard key != lastSent else { return }
        lastSent = key
        webView.evaluateJavaScript(
            "(function(){var a=window.cairnAvatar;if(a&&typeof a.setState==='function'){a.setState('\(state.rawValue)',{running:\(running),approvals:\(approvals)});return true}return false})()"
        ) { [weak self] result, error in
            if error != nil || (result as? Bool) != true { self?.lastSent = nil }
        }
    }

    func setHover(_ on: Bool) {
        hover = on
        guard ready else { return }
        // Prefer the avatar's own hover hook when it has one; otherwise the injected CSS scales the page.
        webView.evaluateJavaScript("""
            (function(on){var a=window.cairnAvatar,d=document.documentElement;
            if(a&&typeof a.setHover==='function'){d.classList.add('cairn-hover-native');a.setHover(on);}
            d.classList.toggle('cairn-hover',on);return true})(\(on ? "true" : "false"))
            """, completionHandler: nil)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" { decisionHandler(.allow); return }
        // Only the local avatar files; an avatar page never navigates anywhere else.
        if scheme == "file", let d = dir, url.standardizedFileURL.path.hasPrefix(d.standardizedFileURL.path) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard style != nil, webView.url?.isFileURL == true else { return }
        let gen = generation
        webView.evaluateJavaScript("typeof window.cairnAvatar === 'object' && window.cairnAvatar !== null && typeof window.cairnAvatar.setState === 'function'") { [weak self] result, _ in
            guard let self = self, self.generation == gen else { return }
            if (result as? Bool) == true {
                self.ready = true
                self.failed = false
                self.lastError = nil
                self.lastSent = nil
                self.push()
                if self.hover { self.setHover(true) }
                self.onAvailability?(true)
            } else {
                self.fail("\(self.style?.file ?? "page") does not expose window.cairnAvatar.setState")
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadError(error)
    }

    private func loadError(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        guard style != nil else { return }
        fail(ns.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        crashes = crashes.filter { now.timeIntervalSince($0) < 300 } + [now]
        ready = false
        guard let s = style, let d = dir else { return }
        if crashes.count > 3 {
            fail("web content process crashed \(crashes.count) times in 5 min")
            return
        }
        Log.write("avatar web content process terminated; reloading \(s.file)")
        load(s, from: d)
    }
}

/// Escape a Swift string as a JavaScript string literal.
func jsString(_ s: String) -> String {
    if let d = try? JSONSerialization.data(withJSONObject: [s]), let arr = String(data: d, encoding: .utf8),
       arr.count >= 2 {
        return String(arr.dropFirst().dropLast())
    }
    return "''"
}

/// Content view of the bubble window: native bubble (fallback) < avatar web view < overlay (mouse).
final class BubbleHostView: NSView {
    let native: BubbleView
    let overlay: BubbleOverlayView
    let avatar: AvatarController
    private(set) var avatarVisible = false

    init(side: CGFloat) {
        let r = NSRect(x: 0, y: 0, width: side, height: side)
        native = BubbleView(frame: r)
        overlay = BubbleOverlayView(frame: r)
        avatar = AvatarController()
        super.init(frame: r)
        wantsLayer = true
        layer?.masksToBounds = false
        native.autoresizingMask = [.width, .height]
        overlay.autoresizingMask = [.width, .height]
        avatar.webView.frame = r
        avatar.webView.autoresizingMask = [.width, .height]
        addSubview(native)
        addSubview(avatar.webView, positioned: .above, relativeTo: native)
        addSubview(overlay, positioned: .above, relativeTo: avatar.webView)
        showAvatar(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isOpaque: Bool { false }

    /// true → the web avatar draws everything (ring, badge, dot); false → native bubble.
    func showAvatar(_ on: Bool) {
        avatarVisible = on
        native.isHidden = on
        avatar.webView.isHidden = !on
    }

    /// While the first avatar page loads: nothing visible (transparent) instead of a flash of the native bubble.
    func showLoading() {
        avatarVisible = false
        native.isHidden = true
        avatar.webView.isHidden = false
    }
}

// MARK: - Chat panel

final class ChatPanel: NSPanel {
    var onEscape: (() -> Void)?

    init(size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovableByWindowBackground = false
        animationBehavior = .utilityWindow
        isExcludedFromWindowsMenu = true
        title = "Cairn Chat"
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

final class RoundedContainerView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 14
        layer?.masksToBounds = true
        layer?.borderWidth = 0.5
        if #available(macOS 10.15, *) { layer?.cornerCurve = .continuous }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.borderColor = NSColor.separatorColor.cgColor
    }
}

/// Transparent strip over the web page's header (its height comes from bubble.js's {type:'ready', dragRegionHeight},
/// because WKWebView ignores -webkit-app-region). Drags move the panel; interactive header elements (buttons,
/// links, inputs, .no-drag — their rects are queried from the page) are excluded from the strip's hit area so
/// they receive their events natively (hover/active states, clicks); a plain click elsewhere on the strip is
/// forwarded to the web view.
final class HeaderDragView: NSView {
    weak var target: NSView?
    /// Rects (in this flipped view's coordinates == CSS px from the page's top-left) that the web view handles.
    var passThrough: [NSRect] = []

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let sv = superview else { return nil }
        let p = convert(point, from: sv)
        guard bounds.contains(p) else { return nil }
        if passThrough.contains(where: { $0.contains(p) }) { return nil } // falls through to the web view
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard let window = window else { return }
        let start = NSEvent.mouseLocation
        let origin = window.frame.origin
        var dragged = false
        while true {
            guard let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp], until: .distantFuture,
                                              inMode: .eventTracking, dequeue: true) else { break }
            if next.type == .leftMouseUp {
                if !dragged {
                    target?.mouseDown(with: event)
                    target?.mouseUp(with: next)
                }
                break
            }
            let p = NSEvent.mouseLocation
            let dx = p.x - start.x
            let dy = p.y - start.y
            if !dragged && hypot(dx, dy) < 3 { continue }
            dragged = true
            window.setFrameOrigin(NSPoint(x: origin.x + dx, y: origin.y + dy))
        }
    }

    override func rightMouseDown(with event: NSEvent) { target?.rightMouseDown(with: event) }
    override func scrollWheel(with event: NSEvent) { target?.scrollWheel(with: event) }
}

final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

final class ChatController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let size = NSSize(width: 400, height: 620)
    /// Header drag strip height used until bubble.js reports its real dragRegionHeight.
    static let defaultHeaderHeight: CGFloat = 52

    let cfg: CairnConfig
    let panel: ChatPanel
    private let container: RoundedContainerView
    private var webView: WKWebView?
    private var strip: HeaderDragView?
    private(set) var dragRegionHeight: CGFloat = 0
    private var dragRegionLogged = false
    private(set) var showingFallback = false
    private(set) var loadedOnce = false
    private var lastLoadAttempt = Date.distantPast
    /// bubble.js posted {type:'ready'} for the current page (window.cairnBubble exists).
    private(set) var pageReady = false
    /// window.cairnBubble calls requested before the page was ready (run on 'ready'; dropped after 30 s).
    private var pendingCalls: [(name: String, at: Date)] = []
    private(set) var lastBubbleCall: String?
    /// Self-test: show()/hide() only track visibility; nothing is put on screen and the page is not loaded.
    var headless = false
    private var headlessVisible = false

    var onAttention: ((String?, String?) -> Void)?
    var onVisibilityChange: ((Bool) -> Void)?
    var onOpenExternal: ((URL) -> Void)?

    /// The window.cairnBubble hooks the native shell may call (bubble.js).
    static let bubbleCalls: Set<String> = ["focusComposer", "newChat", "refresh"]

    var pendingBubbleCalls: [String] { pendingCalls.map { $0.name } }

    /// Calls window.cairnBubble.<name>() now if the page is ready, else once bubble.js reports 'ready'.
    func callBubble(_ name: String) {
        guard ChatController.bubbleCalls.contains(name) else { return }
        lastBubbleCall = name
        guard pageReady, !showingFallback, let wv = webView else {
            pendingCalls.removeAll { $0.name == name }
            pendingCalls.append((name: name, at: Date()))
            return
        }
        wv.evaluateJavaScript(
            "(function(){var b=window.cairnBubble;if(b&&typeof b.\(name)==='function'){b.\(name)();return true}return false})()"
        ) { result, error in
            if error != nil || (result as? Bool) != true { Log.write("chat panel: window.cairnBubble.\(name)() unavailable") }
        }
    }

    private func flushPendingCalls() {
        let now = Date()
        let calls = pendingCalls.filter { now.timeIntervalSince($0.at) < 30 }.map { $0.name }
        pendingCalls.removeAll()
        for c in calls { callBubble(c) }
    }

    init(cfg: CairnConfig) {
        self.cfg = cfg
        panel = ChatPanel(size: ChatController.size)
        container = RoundedContainerView(frame: NSRect(origin: .zero, size: ChatController.size))
        super.init()
        container.autoresizingMask = [.width, .height]
        panel.contentView = container
        panel.onEscape = { [weak self] in self?.hide() }
    }

    var isVisible: Bool { headless ? headlessVisible : panel.isVisible }

    @discardableResult
    private func ensureWebView() -> WKWebView {
        if let w = webView { return w }
        let conf = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(WeakScriptHandler(self), name: "cairn")
        ucc.addUserScript(WKUserScript(
            source: "window.cairnNative = Object.freeze({ shell: 'macos', version: '\(appVersion)' });",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        conf.userContentController = ucc
        conf.websiteDataStore = .default() // localStorage (current conversation) persists across launches
        conf.preferences.javaScriptCanOpenWindowsAutomatically = true
        conf.applicationNameForUserAgent = "CairnDesktop/\(appVersion)"
        let wv = WKWebView(frame: container.bounds, configuration: conf)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsMagnification = false
        if #available(macOS 13.3, *) { wv.isInspectable = true }
        container.addSubview(wv)

        let strip = HeaderDragView(frame: .zero)
        strip.autoresizingMask = [.width, .minYMargin]
        strip.target = wv
        strip.isHidden = true // until bubble.js reports {type:'ready', dragRegionHeight}
        container.addSubview(strip, positioned: .above, relativeTo: wv)
        self.strip = strip
        webView = wv
        return wv
    }

    /// Size the native drag strip to the page's header and exclude its interactive elements.
    func setDragRegion(height: CGFloat) {
        let h = min(max(0, height), 160)
        dragRegionHeight = h
        dragRegionLogged = false
        guard let strip = strip else { return }
        strip.frame = NSRect(x: 0, y: container.bounds.height - h, width: container.bounds.width, height: h)
        strip.isHidden = h < 1
        refreshDragRegion()
    }

    private func disableDragRegion() {
        dragRegionHeight = 0
        strip?.isHidden = true
        strip?.passThrough = []
    }

    static let noDragRectsJS = """
        (function(){var hdr=document.querySelector('[data-drag-region]');if(!hdr)return null;
        var out=[],sel='.no-drag,button,a[href],input,select,textarea,label,summary,[role="button"],[role="tab"],[contenteditable],[tabindex]:not([tabindex="-1"])';
        hdr.querySelectorAll(sel).forEach(function(e){var b=e.getBoundingClientRect();
        if(b.width>0&&b.height>0)out.push([b.left,b.top,b.width,b.height]);});
        return JSON.stringify({bottom:hdr.getBoundingClientRect().bottom,rects:out});})()
        """

    /// Re-query the header's interactive rects (buttons can appear/disappear); cheap, called on ready/show/tick.
    func refreshDragRegion() {
        guard let wv = webView, let strip = strip, !showingFallback, dragRegionHeight > 0 else { return }
        wv.evaluateJavaScript(ChatController.noDragRectsJS) { [weak self, weak strip] result, _ in
            guard let self = self, let strip = strip, let json = result as? String, let d = json.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
            let rects: [NSRect] = ((obj["rects"] as? [[Any]]) ?? []).compactMap { a in
                let n = a.compactMap { ($0 as? NSNumber).map { CGFloat($0.doubleValue) } }
                return n.count == 4 ? NSRect(x: n[0], y: n[1], width: n[2], height: n[3]).insetBy(dx: -2, dy: -2) : nil
            }
            strip.passThrough = rects
            if !self.dragRegionLogged {
                self.dragRegionLogged = true
                Log.write("chat panel: header drag strip \(Int(self.dragRegionHeight)) px, \(rects.count) interactive rect(s) pass through")
            }
            if let b = (obj["bottom"] as? NSNumber).map({ CGFloat($0.doubleValue) }), b >= 1, abs(b - self.dragRegionHeight) > 0.5 {
                let h = min(b, 160)
                self.dragRegionHeight = h
                strip.frame = NSRect(x: 0, y: self.container.bounds.height - h, width: self.container.bounds.width, height: h)
            }
        }
    }

    /// Load (or reload) bubble.html. Called at startup once the server is healthy so the panel opens instantly.
    func load() {
        let wv = ensureWebView()
        lastLoadAttempt = Date()
        disableDragRegion()
        showingFallback = false
        pageReady = false
        loadedOnce = true
        wv.load(URLRequest(url: cfg.bubbleURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
    }

    func reload() {
        if showingFallback || webView?.url == nil { load() } else { disableDragRegion(); pageReady = false; webView?.reload() }
    }

    func preload() {
        if !loadedOnce || showingFallback { load() }
    }

    /// Called on every health tick: retries a failed load once the server is back.
    func tick(reachable: Bool) {
        if panel.isVisible { refreshDragRegion() }
        guard reachable else { return }
        if (!loadedOnce || showingFallback) && Date().timeIntervalSince(lastLoadAttempt) > 10 { load() }
    }

    func show(beside bubbleFrame: NSRect, activate: Bool) {
        if headless {
            if !headlessVisible { headlessVisible = true; onVisibilityChange?(true) }
            return
        }
        if !loadedOnce { load() }
        reposition(beside: bubbleFrame)
        let wasVisible = panel.isVisible
        if activate {
            if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
            if !wasVisible { panel.alphaValue = 0 }
            panel.makeKeyAndOrderFront(nil)
            if let wv = webView { panel.makeFirstResponder(wv) }
        } else {
            if !wasVisible { panel.alphaValue = 0 }
            panel.orderFrontRegardless()
        }
        if !wasVisible {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.14
                panel.animator().alphaValue = 1
            }
        }
        panel.invalidateShadow()
        refreshDragRegion()
        if !wasVisible { onVisibilityChange?(true) }
    }

    func hide() {
        if headless {
            if headlessVisible { headlessVisible = false; onVisibilityChange?(false) }
            return
        }
        guard panel.isVisible else { return }
        panel.orderOut(nil) // the WKWebView (and its state) stays alive
        onVisibilityChange?(false)
    }

    func reposition(beside bubbleFrame: NSRect) {
        let old = panel.frame.size
        panel.setFrame(ChatController.frame(beside: bubbleFrame), display: panel.isVisible)
        if panel.frame.size != old && dragRegionHeight > 0 { setDragRegion(height: dragRegionHeight) }
    }

    /// Place the panel next to the bubble, flipping sides/direction so it stays on screen.
    static func frame(beside bubble: NSRect) -> NSRect {
        let circle = bubble.insetBy(dx: BubbleView.margin, dy: BubbleView.margin)
        guard let vf = screenFor(bubble)?.visibleFrame else { return NSRect(origin: .zero, size: size) }
        let gap: CGFloat = 10
        let edge: CGFloat = 8
        let w = min(size.width, vf.width - edge * 2)
        let h = min(size.height, vf.height - edge * 2)
        var x: CGFloat
        if circle.midX > vf.midX {
            x = circle.minX - gap - w
            if x < vf.minX + edge { x = circle.maxX + gap }
        } else {
            x = circle.maxX + gap
            if x + w > vf.maxX - edge { x = circle.minX - gap - w }
        }
        var y: CGFloat = circle.midY > vf.midY ? circle.maxY - h : circle.minY
        x = min(max(x, vf.minX + edge), vf.maxX - w - edge)
        y = min(max(y, vf.minY + edge), vf.maxY - h - edge)
        return NSRect(x: x, y: y, width: w, height: h)
    }

    // MARK: fallback page (server down / bubble.html missing)

    private func showFallback(title: String, detail: String) {
        disableDragRegion()
        showingFallback = true
        pageReady = false
        ensureWebView().loadHTMLString(ChatController.fallbackHTML(title: title, detail: detail), baseURL: nil)
    }

    static func fallbackHTML(title: String, detail: String) -> String {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        }
        return """
        <!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <style>
        html,body{height:100%;margin:0}
        body{font:13px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
             text-align:center;background:Canvas;color:CanvasText}
        .box{max-width:310px;padding:24px}
        .logo{width:46px;height:46px;border-radius:50%;margin:0 auto;background:linear-gradient(135deg,#2dd4bf,#4f46e5)}
        h1{font-size:16px;margin:14px 0 6px} p{opacity:.72;line-height:1.45;word-break:break-word}
        button{font:inherit;margin:6px 4px;padding:7px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.4);
               background:transparent;color:inherit;cursor:pointer}
        button.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
        </style></head><body><div class="box"><div class="logo"></div>
        <h1>\(esc(title))</h1><p>\(esc(detail))</p>
        <button class="primary" onclick="post({type:'retry'})">Retry</button>
        <button onclick="post({type:'open',url:'/'})">Open Dashboard</button>
        <button onclick="post({type:'collapse'})">Hide</button>
        <script>function post(m){try{window.webkit.messageHandlers.cairn.postMessage(m)}catch(e){}}</script>
        </div></body></html>
        """
    }

    // MARK: WKScriptMessageHandler — window.webkit.messageHandlers.cairn.postMessage({type})

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "cairn" else { return }
        let origin = message.frameInfo.securityOrigin
        let local = (origin.host == "127.0.0.1" || origin.host == "localhost") && origin.port == cfg.port
        guard local || showingFallback else { return }
        var body: [String: Any] = [:]
        var type = ""
        if let d = message.body as? [String: Any] {
            body = d
            type = (d["type"] as? String) ?? ""
        } else if let s = message.body as? String {
            type = s
        }
        switch type {
        case "collapse", "hide", "close":
            hide()
        case "attention":
            onAttention?(body["title"] as? String, body["message"] as? String)
        case "expand", "show":
            onAttention?(nil, nil)
        case "open":
            if let s = body["url"] as? String, let u = URL(string: s, relativeTo: URL(string: cfg.base + "/")),
               let scheme = u.absoluteURL.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                onOpenExternal?(u.absoluteURL)
            }
        case "retry", "reload":
            load()
        case "ready":
            guard local, message.frameInfo.isMainFrame else { break }
            let h = (body["dragRegionHeight"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? ChatController.defaultHeaderHeight
            setDragRegion(height: h)
            pageReady = true
            flushPendingCalls()
        default:
            break
        }
    }

    // MARK: WKNavigationDelegate

    private func isPanelPage(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        return (u.host == "127.0.0.1" || u.host == "localhost") && u.port == cfg.port && u.path.hasPrefix("/web/bubble")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" { decisionHandler(.allow); return }
        let userLink = navigationAction.navigationType == .linkActivated || navigationAction.navigationType == .formSubmitted
        if navigationAction.targetFrame?.isMainFrame ?? true {
            // Links out of the panel (dashboard, docs, shopping links…) open in the default browser.
            if !(scheme == "http" || scheme == "https") || (userLink && !isPanelPage(url)) {
                onOpenExternal?(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false // window.cairnBubble returns with the new page's 'ready'
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse,
           http.statusCode >= 400, isPanelPage(http.url) {
            decisionHandler(.cancel)
            let code = http.statusCode
            DispatchQueue.main.async {
                self.showFallback(title: "Chat panel not available yet",
                                  detail: "The Cairn server answered \(code) for /web/bubble.html. The dashboard works meanwhile; this panel retries automatically.")
            }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    private func handleLoadError(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return } // interrupted by policy change
        if showingFallback { return }
        showFallback(title: "Connecting to Cairn…",
                     detail: "Can't reach \(cfg.base) (\(ns.localizedDescription)). The server is starting or restarting; this panel reconnects automatically.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.write("web content process terminated; reloading chat panel")
        pageReady = false
        load()
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { onOpenExternal?(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let a = NSAlert()
        a.messageText = "Cairn"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "Cairn"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let a = NSAlert()
        a.messageText = "Cairn"
        a.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = parameters.allowsDirectories
        p.canChooseFiles = true
        completionHandler(p.runModal() == .OK ? p.urls : nil)
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var shared: AppDelegate?

    let cfg = CairnConfig.load()
    var bubble: BubblePanel!
    var bubbleHost: BubbleHostView!
    var bubbleView: BubbleView! { bubbleHost?.native }
    var chat: ChatController!
    var server: ServerManager!
    var healthClient: HealthClient!
    var events: EventStream!

    var health = Health()
    var consecutiveFailures = 0
    var startupDeadline: Date?
    var restartAttempts = 0
    var nextRestartAllowed = Date.distantPast
    var healthySince: Date?
    var pollToken = 0
    var pollInFlight = false
    var attentionUnseen = false
    /// Last 'attention' (bubble.html message or native reminder event): the avatar shows 'attention' for 10 s.
    var lastAttentionAt: Date?
    var avatars = AvatarCatalog(dir: nil, defaultKey: AvatarCatalog.classicKey, styles: [])
    var loginItemBusy = false
    var terminating = false
    var activityToken: NSObjectProtocol?
    var keyMonitor: Any?
    var hotKeyRef: EventHotKeyRef?
    var hotKeyHandlerInstalled = false
    var signalSources: [DispatchSourceSignal] = []
    /// Self-test: nothing is ordered on screen, the app is never activated.
    var headless = false
    /// When the app last became active / was unhidden (tells a Dock click that activated Cairn from one made while
    /// Cairn was already frontmost).
    var becameActiveAt = Date.distantPast
    var unhiddenAt = Date.distantPast
    /// Pending approvals at the previous reachable health poll (nil until the first one): a rise bounces the Dock icon.
    var knownApprovals: Int?
    var lastDockAttentionAt = Date.distantPast

    // MARK: Dock / activation policy

    static func showInDock(_ d: UserDefaults = .standard) -> Bool { d.bool(forKey: Keys.showInDock) }

    /// CairnShowInDock (default true) → .regular (Dock icon, menu bar, ⌘Tab); false → .accessory (bubble only).
    static func activationPolicy(showInDock: Bool) -> NSApplication.ActivationPolicy { showInDock ? .regular : .accessory }

    /// Applies CairnShowInDock now (at launch from main(), and live from the "Show in Dock" toggle).
    func applyActivationPolicy() {
        let policy = AppDelegate.activationPolicy(showInDock: AppDelegate.showInDock())
        guard !headless, NSApp.activationPolicy() != policy else { return }
        let wasLaunched = bubble != nil
        NSApp.setActivationPolicy(policy)
        guard wasLaunched else { return }
        Log.write(policy == .regular ? "Show in Dock on: regular app (Dock icon, menu bar)" : "Show in Dock off: accessory app (bubble only)")
        if policy == .regular {
            updateDockTile()
            activateApp() // the menu bar switches to Cairn's once it is active again
        }
        // Switching policy can deactivate the app; keep the bubble (and an open chat) in front.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self = self else { return }
            self.bubble?.orderFrontRegardless()
            if self.chat?.isVisible == true { self.chat.panel.orderFrontRegardless() }
        }
    }

    func activateApp() {
        guard !headless else { return }
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    /// Dock tile badge: the number of pending approvals, nothing when there are none or the server is unreachable.
    static func dockBadgeLabel(health: Health) -> String? {
        let n = health.reachable ? health.pendingApprovals : 0
        return n > 0 ? String(n) : nil
    }

    func updateDockTile() {
        guard !headless else { return }
        let label = AppDelegate.dockBadgeLabel(health: health)
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    /// Bounce the Dock icon once (informational) for a new approval or a reminder; at most once per 5 s, so the
    /// same event arriving from bubble.js, the native event stream and the health poll bounces it only once.
    func requestDockAttention(_ why: String) {
        guard !headless, NSApp.activationPolicy() == .regular, !NSApp.isActive else { return }
        let now = Date()
        guard now.timeIntervalSince(lastDockAttentionAt) > 5 else { return }
        lastDockAttentionAt = now
        _ = NSApp.requestUserAttention(.informationalRequest)
        Log.write("Dock attention: \(why)")
    }

    /// "N tasks running · M approvals" for the Dock menu (or why the server is not answering).
    static func dockStatusLine(health: Health, starting: Bool, serverError: String?) -> String {
        guard health.reachable else {
            if let e = serverError { return "Server problem: \(e)" }
            return starting ? "Starting the Cairn server…" : "Server unreachable"
        }
        let n = health.runningRuns
        let a = health.pendingApprovals
        return "\(n) task\(n == 1 ? "" : "s") running · \(a) approval\(a == 1 ? "" : "s")"
    }

    enum ReopenAction: Equatable { case open, hide }

    /// A Dock click toggles the chat like a bubble click when Cairn was already frontmost with the chat focused;
    /// otherwise (Cairn in the background, chat hidden) it opens the chat and focuses the composer.
    static func reopenAction(chatVisible: Bool, chatKey: Bool, appWasActive: Bool) -> ReopenAction {
        chatVisible && chatKey && appWasActive ? .hide : .open
    }

    /// Dock icon click, or Spotlight / Finder / `open -a Cairn` while Cairn is already running.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard bubble != nil, chat != nil else { return false }
        let now = Date()
        if !headless && (NSApp.isHidden || now.timeIntervalSince(unhiddenAt) < 0.6) {
            // Clicking the Dock icon of a hidden Cairn (⌘H) just brings it back as it was.
            if NSApp.isHidden { NSApp.unhide(nil) }
            ensureBubbleVisible()
            Log.write("Dock: reopen while hidden → unhide")
            return false
        }
        ensureBubbleVisible()
        let wasActive = NSApp.isActive && now.timeIntervalSince(becameActiveAt) > 0.5
        switch AppDelegate.reopenAction(chatVisible: chat.isVisible, chatKey: chat.panel.isKeyWindow, appWasActive: wasActive) {
        case .hide:
            chat.hide()
            Log.write("Dock: reopen → hide chat")
        case .open:
            presentChat(focusComposer: true)
            Log.write("Dock: reopen → open chat")
        }
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) { becameActiveAt = Date() }

    func applicationDidUnhide(_ notification: Notification) { unhiddenAt = Date() }

    /// Dock icon right-click menu (macOS appends Options, Show All Windows, Hide and Quit).
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let m = NSMenu(title: "Cairn")
        m.autoenablesItems = false
        func add(_ title: String, _ sel: Selector?, enabled: Bool = true, state: NSControl.StateValue = .off) {
            let item = NSMenuItem(title: title, action: sel, keyEquivalent: "")
            if sel != nil { item.target = self }
            item.isEnabled = enabled
            item.state = state
            m.addItem(item)
        }
        add("Open Chat", #selector(openChatFromDock))
        add("New Chat", #selector(newChatFromDock))
        m.addItem(.separator())
        add("Open Dashboard", #selector(openDashboard))
        add("Open Docs", #selector(openDocs))
        m.addItem(.separator())
        add(AppDelegate.dockStatusLine(health: health, starting: startupDeadline != nil, serverError: server?.lastError),
            nil, enabled: false)
        m.addItem(.separator())
        add("Start at Login", #selector(toggleStartAtLogin), enabled: !loginItemBusy,
            state: UserDefaults.standard.bool(forKey: Keys.startAtLogin) ? .on : .off)
        return m
    }

    @objc func openChatFromDock() {
        ensureBubbleVisible()
        presentChat(focusComposer: true)
    }

    @objc func newChatFromDock() {
        ensureBubbleVisible()
        presentChat(focusComposer: false)
        chat.callBubble("newChat") // bubble.js starts a fresh conversation and focuses the composer
        Log.write("New Chat requested")
    }

    /// The bubble is on screen (clamped to a visible display) and in front.
    func ensureBubbleVisible() {
        guard let b = bubble else { return }
        let c = clamp(b.frame.origin)
        if c != b.frame.origin { b.setFrameOrigin(c) }
        if !headless { b.orderFrontRegardless() }
    }

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        Keys.registerDefaults()
        let me = getpid()
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.cairn.bubble")
            .filter { $0.processIdentifier != me }
        if !others.isEmpty {
            NSLog("Cairn: another instance is already running (pid %d); exiting", others[0].processIdentifier)
            exit(0)
        }

        Log.open(cfg.logPath)
        Log.write("Cairn desktop \(appVersion) launching (pid \(me), root=\(cfg.root), node=\(cfg.nodePath ?? "missing"), port=\(cfg.port), "
                  + (NSApp.activationPolicy() == .regular ? "Dock app" : "accessory app — Show in Dock is off") + ")")
        ProcessInfo.processInfo.disableAutomaticTermination("Cairn stays on to run reminders and background tasks")
        activityToken = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep],
                                                              reason: "Cairn keeps reminders and background tasks running")

        setupMainMenu()
        server = ServerManager(cfg: cfg)
        server.onUnexpectedExit = { [weak self] _ in self?.serverExitedUnexpectedly() }
        healthClient = HealthClient(base: cfg.base)
        events = EventStream(url: cfg.url("/api/assistant/events"))
        events.onEvent = { [weak self] name, data in self?.handleServerEvent(name, data) }

        setupBubble()
        chat = ChatController(cfg: cfg)
        chat.onAttention = { [weak self] title, message in self?.attention(title: title, message: message, markUnseen: true) }
        chat.onVisibilityChange = { [weak self] visible in self?.chatVisibilityChanged(visible) }
        chat.onOpenExternal = { url in NSWorkspace.shared.open(url) }

        installKeyHandling()
        installSignalHandlers()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake),
                                                          name: NSWorkspace.didWakeNotification, object: nil)
        initialHealthCheck()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        events?.stop()
        unregisterHotKey()
        if let s = server, s.startedByUs {
            Log.write("quitting: stopping the server this app started")
            s.stopForQuit()
        }
        Log.write("Cairn desktop exited")
    }

    private func setupMainMenu() {
        let main = buildMainMenu()
        NSApp.mainMenu = main
        if let help = main.items.first(where: { $0.submenu?.title == "Help" })?.submenu { NSApp.helpMenu = help }
        if let services = main.items.first?.submenu?.items.first(where: { $0.title == "Services" })?.submenu {
            NSApp.servicesMenu = services
        }
    }

    /// The menu bar shown while Cairn is the active (regular) app. Edit uses the standard first-responder selectors
    /// (nil target) so ⌘Z/⇧⌘Z/⌘X/⌘C/⌘V/⌘A reach the chat panel's WKWebView. Also used by the self-test.
    func buildMainMenu() -> NSMenu {
        let main = NSMenu(title: "Main Menu")
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }
        @discardableResult
        func add(_ menu: NSMenu, _ title: String, _ sel: Selector, _ key: String = "",
                 _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            item.keyEquivalentModifierMask = key.isEmpty ? [] : mods
            item.target = target
            menu.addItem(item)
            return item
        }

        // App menu (its title is replaced by the app name in the menu bar)
        let app = submenu("Cairn")
        add(app, "About Cairn", #selector(showAbout), target: self)
        app.addItem(.separator())
        add(app, "Open Dashboard…", #selector(openDashboard), target: self)
        app.addItem(.separator())
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = NSMenu(title: "Services")
        app.addItem(servicesItem)
        app.addItem(.separator())
        add(app, "Hide Cairn", #selector(NSApplication.hide(_:)), "h")
        add(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        add(app, "Quit Cairn", #selector(quitFromMenu), "q", target: self)

        // Edit — nil target: the first responder (the chat's WKWebView) handles these
        let edit = submenu("Edit")
        add(edit, "Undo", Selector(("undo:")), "z")
        add(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(edit, "Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift])
        add(edit, "Delete", #selector(NSText.delete(_:)))
        add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")

        // Window
        let window = submenu("Window")
        add(window, "Show Chat", #selector(toggleChat), " ", [.option], target: self) // title follows the panel (validateMenuItem)
        add(window, "Close Chat", #selector(closeChatOrWindow(_:)), "w", target: self) // or the key window (About…)
        add(window, "Reload Chat", #selector(reloadChat), "r", target: self)
        window.addItem(.separator())
        add(window, "Reset Bubble Position", #selector(resetPosition), target: self)
        window.addItem(.separator())
        add(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m") // enabled only for windows that can
        add(window, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))

        // Help
        let help = submenu("Help")
        add(help, "Cairn Docs", #selector(openDocs), target: self)
        add(help, "Floating Bubble App Guide", #selector(openDesktopDocs), target: self)
        help.addItem(.separator())
        add(help, "Show Server Log", #selector(showLog), target: self)
        return main
    }

    @objc func showAbout() {
        activateApp()
        let credits = NSAttributedString(
            string: "Local personal assistant.\nServer: \(cfg.base)\nProject: \(cfg.root)",
            attributes: [.font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor])
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
    }

    // MARK: bubble

    /// Builds the bubble window (native fallback + avatar web view + mouse overlay). Also used by the self-test.
    func makeBubble() {
        bubble = BubblePanel(side: BubbleView.side)
        bubbleHost = BubbleHostView(side: BubbleView.side)
        bubble.contentView = bubbleHost
        let o = bubbleHost.overlay
        o.onClick = { [weak self] in self?.toggleChat() }
        o.onDragMoved = { [weak self] in self?.bubbleMoved() }
        o.onDragEnded = { [weak self] in self?.bubbleDragEnded() }
        o.onHover = { [weak self] on in
            guard let h = self?.bubbleHost else { return }
            h.native.setHover(on)
            h.avatar.setHover(on)
        }
        o.menuProvider = { [weak self] in self?.buildMenu() }
        bubbleHost.avatar.onAvailability = { [weak self] ok in
            guard let self = self, let h = self.bubbleHost else { return }
            h.showAvatar(ok)
            if ok { Log.write("avatar '\(h.avatar.style?.key ?? "-")' loaded") }
            self.updateBubble()
        }
        avatars = AvatarCatalog.load(root: cfg.root)
    }

    private func setupBubble() {
        makeBubble()
        if let d = avatars.dir {
            Log.write("avatars: \(avatars.styles.map { $0.key }.joined(separator: ", ")) from \(d.path) (default \(avatars.defaultKey))")
        } else {
            Log.write("avatars: none found (\(AvatarCatalog.candidateDirs(root: cfg.root).joined(separator: ", "))); using the native bubble")
        }
        applyAvatar()
        bubble.setFrameOrigin(restoredOrigin())
        bubble.orderFrontRegardless()
        updateBubble()
    }

    /// The chosen avatar style key (UserDefaults, else index.json's default); "classic" = native bubble.
    var currentAvatarKey: String {
        let saved = UserDefaults.standard.string(forKey: Keys.avatarStyle)
        if let k = saved, k == AvatarCatalog.classicKey || avatars.style(k) != nil { return k }
        return avatars.defaultKey
    }

    /// (Re)load the avatar web view for the current style, or fall back to the native bubble.
    func applyAvatar() {
        guard let host = bubbleHost else { return }
        let key = currentAvatarKey
        guard let style = avatars.style(key), let dir = avatars.dir else {
            host.avatar.unload()
            host.showAvatar(false)
            updateBubble()
            return
        }
        pushAvatarState()
        if !host.avatarVisible { host.showLoading() } // switching styles keeps the old page until the new one renders
        host.avatar.load(style, from: dir)
    }

    @objc func selectAvatar(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        UserDefaults.standard.set(key, forKey: Keys.avatarStyle)
        Log.write("avatar style → \(key)")
        avatars = AvatarCatalog.load(root: cfg.root) // pick up newly added styles
        applyAvatar()
    }

    /// Health → avatar state: offline if unreachable; attention if approvals are pending or an 'attention'
    /// message arrived in the last 10 s; working while runs are active; listening while the chat is open; else idle.
    static func avatarState(health: Health, lastAttention: Date?, chatVisible: Bool, now: Date = Date()) -> AvatarState {
        if !health.reachable { return .offline }
        if health.pendingApprovals > 0 { return .attention }
        if let t = lastAttention, now.timeIntervalSince(t) < 10 { return .attention }
        if health.runningRuns > 0 { return .working }
        return chatVisible ? .listening : .idle
    }

    private func pushAvatarState() {
        guard let host = bubbleHost else { return }
        let st = AppDelegate.avatarState(health: health, lastAttention: lastAttentionAt, chatVisible: chat?.isVisible ?? false)
        host.avatar.setState(st, running: health.reachable ? health.runningRuns : 0,
                             approvals: health.reachable ? health.pendingApprovals : 0)
    }

    func defaultOrigin() -> NSPoint {
        let vf = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let inset: CGFloat = 16
        return NSPoint(x: vf.maxX - inset - BubbleView.circle - BubbleView.margin,
                       y: vf.maxY - inset - BubbleView.circle - BubbleView.margin)
    }

    private func restoredOrigin() -> NSPoint {
        if let a = UserDefaults.standard.array(forKey: Keys.origin) as? [Double], a.count == 2 {
            return clamp(NSPoint(x: a[0], y: a[1]))
        }
        return defaultOrigin()
    }

    /// Keep the whole circle on the visible part of the screen it (mostly) sits on.
    func clamp(_ o: NSPoint) -> NSPoint {
        let side = BubbleView.side
        let m = BubbleView.margin
        let frame = NSRect(x: o.x, y: o.y, width: side, height: side)
        var best: NSScreen?
        var bestArea: CGFloat = 0
        for s in NSScreen.screens {
            let i = s.visibleFrame.intersection(frame)
            if !i.isNull, i.width * i.height > bestArea {
                bestArea = i.width * i.height
                best = s
            }
        }
        if best == nil {
            let c = NSPoint(x: frame.midX, y: frame.midY)
            best = NSScreen.screens.min(by: {
                hypot($0.visibleFrame.midX - c.x, $0.visibleFrame.midY - c.y) < hypot($1.visibleFrame.midX - c.x, $1.visibleFrame.midY - c.y)
            })
        }
        guard let vf = best?.visibleFrame else { return o }
        let x = min(max(o.x, vf.minX - m), vf.maxX - side + m)
        let y = min(max(o.y, vf.minY - m), vf.maxY - side + m)
        return NSPoint(x: x, y: y)
    }

    private func bubbleMoved() {
        if chat.isVisible { chat.reposition(beside: bubble.frame) }
    }

    private func bubbleDragEnded() {
        let c = clamp(bubble.frame.origin)
        if c != bubble.frame.origin {
            bubble.setFrame(NSRect(origin: c, size: bubble.frame.size), display: true, animate: true)
        }
        UserDefaults.standard.set([Double(c.x), Double(c.y)], forKey: Keys.origin)
        if chat.isVisible { chat.reposition(beside: bubble.frame) }
    }

    @objc private func screensChanged() {
        let c = clamp(bubble.frame.origin)
        if c != bubble.frame.origin { bubble.setFrameOrigin(c) }
        if chat.isVisible { chat.reposition(beside: bubble.frame) }
    }

    @objc private func didWake() {
        Log.write("system woke; re-checking server health")
        events.restart()
        schedulePoll(after: 1.0)
    }

    private func statusLine() -> String {
        if !health.reachable {
            if let e = server?.lastError { return "Cairn — \(e)" }
            return startupDeadline != nil ? "Cairn — starting the server…" : "Cairn — server unreachable"
        }
        var parts: [String] = []
        let n = health.runningRuns
        parts.append(n == 0 ? "No tasks running" : "\(n) task\(n == 1 ? "" : "s") running")
        if health.queuedRuns > 0 { parts.append("\(health.queuedRuns) queued") }
        if health.pendingApprovals > 0 {
            parts.append("\(health.pendingApprovals) approval\(health.pendingApprovals == 1 ? "" : "s") waiting")
        }
        return "Cairn — " + parts.joined(separator: " · ")
    }

    func updateBubble() {
        guard let host = bubbleHost else { return }
        let v = host.native
        // The avatar page draws its own ring/badge/dot; the native ones only matter while it is not loaded.
        let native = !host.avatarVisible
        v.setOffline(native && !health.reachable)
        v.setRunning(native && health.reachable && health.runningRuns > 0)
        let n = health.reachable ? health.pendingApprovals : 0
        v.setBadge(native ? (n > 0 ? (n > 9 ? "9+" : "\(n)") : (attentionUnseen ? "!" : nil)) : nil)
        pushAvatarState()
        updateDockTile()
        let line = statusLine()
        host.overlay.toolTip = line
        host.overlay.setAccessibilityValue(line)
    }

    // MARK: chat panel

    @objc func toggleChat() {
        if chat.isVisible { chat.hide() } else { showChat() }
    }

    @objc func showChat() { presentChat(focusComposer: false) }

    /// Shows the chat panel (activating Cairn so the panel becomes key and typing works).
    func presentChat(focusComposer: Bool) {
        chat.show(beside: bubble.frame, activate: true)
        if !headless { bubble.orderFrontRegardless() }
        if focusComposer { chat.callBubble("focusComposer") } // queued until bubble.js is ready
    }

    @objc func hideChat() { chat.hide() }

    /// ⌘W: closes another key window (the About panel, …) if there is one, else hides the chat panel.
    @objc func closeChatOrWindow(_ sender: Any?) {
        if let w = NSApp.keyWindow, w !== chat.panel, w !== bubble { w.performClose(sender); return }
        chat.hide()
    }

    @objc func reloadChat() { chat.reload() }

    private func chatVisibilityChanged(_ visible: Bool) {
        if visible { attentionUnseen = false }
        updateBubble()
    }

    private func attention(title: String?, message: String?, markUnseen: Bool) {
        if let t = title { Log.write("attention: \(t)\(message.map { " — \($0)" } ?? "")") }
        if markUnseen && !chat.isVisible { attentionUnseen = true }
        lastAttentionAt = Date()
        bubbleView.pulse()
        updateBubble()
        if let t = title { requestDockAttention(t) } // a reminder or an approval (not a plain 'show' request)
        // drop back from 'attention' once the 10 s window has passed (the 3 s poll would too, a bit later)
        DispatchQueue.main.asyncAfter(deadline: .now() + 10.1) { [weak self] in self?.updateBubble() }
        if UserDefaults.standard.bool(forKey: Keys.openOnAttention) && !chat.isVisible {
            chat.show(beside: bubble.frame, activate: false)
            bubble.orderFrontRegardless()
        }
    }

    private func handleServerEvent(_ name: String, _ data: [String: Any]) {
        switch name {
        case "reminder":
            let task = (data["task"] as? [String: Any]) ?? data
            attention(title: "Reminder: \((task["title"] as? String) ?? "")", message: task["notes"] as? String, markUnseen: true)
        case "approval":
            bubbleView.pulse()
            schedulePoll(after: 0.1)
        case "task_result", "run_done":
            if !chat.isVisible { bubbleView.pulse(times: 1) }
            schedulePoll(after: 0.1)
        case "run_started", "run_update", "approval_resolved":
            schedulePoll(after: 0.1)
        default:
            break
        }
    }

    // MARK: health polling + watchdog

    private func initialHealthCheck() {
        healthClient.check { h in
            DispatchQueue.main.async {
                if h.reachable {
                    self.server.adoptIfOurs()
                    Log.write("found a running Cairn server at \(self.cfg.base)\(self.server.startedByUs ? " (started by this app earlier)" : "")")
                    self.handleHealth(h)
                } else {
                    self.startServer(reason: "no server answering at \(self.cfg.base)")
                }
            }
        }
    }

    private func startServer(reason: String) {
        guard UserDefaults.standard.bool(forKey: Keys.autoStartServer) else {
            Log.write("auto-start disabled (defaults write com.cairn.bubble \(Keys.autoStartServer) -bool YES to enable)")
            handleHealth(Health())
            return
        }
        Log.write("starting server: \(reason)")
        if server.start() { startupDeadline = Date().addingTimeInterval(20) }
        updateBubble()
        schedulePoll(after: 0.5)
    }

    private func schedulePoll(after interval: TimeInterval) {
        pollToken += 1
        let token = pollToken
        DispatchQueue.main.asyncAfter(deadline: .now() + interval) { [weak self] in
            guard let self = self, self.pollToken == token else { return }
            self.pollHealth()
        }
    }

    private func pollHealth() {
        guard !terminating, !pollInFlight else { return }
        pollInFlight = true
        healthClient.check { h in
            DispatchQueue.main.async {
                self.pollInFlight = false
                self.handleHealth(h)
            }
        }
    }

    private func handleHealth(_ h: Health) {
        guard !terminating else { return }
        let wasReachable = health.reachable
        health = h
        if h.reachable {
            if let known = knownApprovals, h.pendingApprovals > known {
                requestDockAttention("\(h.pendingApprovals - known) new approval\(h.pendingApprovals - known == 1 ? "" : "s")")
            }
            knownApprovals = h.pendingApprovals
            consecutiveFailures = 0
            if startupDeadline != nil {
                Log.write("server is healthy")
                startupDeadline = nil
            }
            if let since = healthySince {
                if Date().timeIntervalSince(since) > 120 { restartAttempts = 0 }
            } else {
                healthySince = Date()
            }
            if !wasReachable { serverBecameReachable() }
        } else {
            healthySince = nil
            if let d = startupDeadline, Date() < d {
                // still inside the start-up grace window (≤ 20 s)
            } else {
                if startupDeadline != nil {
                    Log.write("server did not become healthy within the start-up window")
                    startupDeadline = nil
                }
                if wasReachable { Log.write("server stopped answering health checks") }
                consecutiveFailures += 1
                watchdog()
            }
        }
        chat?.tick(reachable: h.reachable)
        updateBubble()
        schedulePoll(after: startupDeadline != nil ? 0.5 : 3.0)
    }

    private func serverBecameReachable() {
        Log.write("connected to \(cfg.base)\(health.assistantApi ? "" : " (assistant API not available yet — using /api/health)")")
        events.start()
        chat.preload()
    }

    private func serverExitedUnexpectedly() {
        startupDeadline = nil // no point waiting out the grace window for a dead process
        schedulePoll(after: 0.3)
    }

    /// Restart the server child after 3 failed polls (if this app started it), with backoff so a crash loop
    /// does not spin. If some other process owned the server and it vanished, take over after 5 polls.
    private func watchdog() {
        guard !terminating, UserDefaults.standard.bool(forKey: Keys.autoStartServer) else { return }
        let threshold = server.startedByUs ? 3 : 5
        guard consecutiveFailures >= threshold, Date() >= nextRestartAllowed else { return }
        restartAttempts += 1
        let backoff = min(120.0, 10.0 * pow(2.0, Double(restartAttempts - 1)))
        nextRestartAllowed = Date().addingTimeInterval(backoff)
        consecutiveFailures = 0
        if server.startedByUs {
            Log.write("watchdog: health failed \(threshold)x — restarting the server (attempt \(restartAttempts), next retry ≥ \(Int(backoff)) s)")
            startupDeadline = Date().addingTimeInterval(20)
            server.restart { [weak self] in
                guard let self = self else { return }
                self.startupDeadline = Date().addingTimeInterval(20)
                self.schedulePoll(after: 0.5)
            }
        } else {
            startServer(reason: "watchdog: no server for \(threshold) polls")
        }
    }

    // MARK: context menu

    func buildMenu() -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false

        func info(_ title: String) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            m.addItem(item)
        }
        func action(_ title: String, _ sel: Selector, key: String = "", mods: NSEvent.ModifierFlags = [], enabled: Bool = true,
                    state: NSControl.StateValue = .off) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            item.target = self
            item.keyEquivalentModifierMask = mods
            item.isEnabled = enabled
            item.state = state
            m.addItem(item)
            return item
        }

        if health.reachable {
            let n = health.runningRuns
            info(n == 1 ? "1 task running" : "\(n) tasks running")
            if health.queuedRuns > 0 { info("\(health.queuedRuns) queued") }
            if health.pendingApprovals > 0 {
                let p = health.pendingApprovals
                _ = action("\(p) approval\(p == 1 ? "" : "s") waiting — Review…", #selector(showChat))
            }
            if let next = health.nextTaskAt {
                let f = DateFormatter()
                f.doesRelativeDateFormatting = true
                f.dateStyle = .short
                f.timeStyle = .short
                info("Next task: \(f.string(from: next))")
            }
        } else if let e = server.lastError {
            info("Server problem: \(e)")
        } else {
            info(startupDeadline != nil ? "Starting the Cairn server…" : "Server unreachable — watchdog is retrying")
        }
        m.addItem(.separator())

        _ = action(chat.isVisible ? "Hide Chat" : "Open Chat", #selector(toggleChat), key: " ", mods: [.option])
        _ = action("Open Dashboard", #selector(openDashboard))
        _ = action("Open Docs", #selector(openDocs))
        m.addItem(.separator())

        _ = action("Start at Login", #selector(toggleStartAtLogin), enabled: !loginItemBusy,
                   state: UserDefaults.standard.bool(forKey: Keys.startAtLogin) ? .on : .off)
        _ = action("Show in Dock", #selector(toggleShowInDock), state: AppDelegate.showInDock() ? .on : .off)
        _ = action("Open Chat on Alerts", #selector(toggleOpenOnAttention),
                   state: UserDefaults.standard.bool(forKey: Keys.openOnAttention) ? .on : .off)
        _ = action("Global Shortcut ⌥Space", #selector(toggleGlobalHotkey),
                   state: hotKeyRef != nil ? .on : .off)
        _ = action("Reset Position", #selector(resetPosition))
        m.addItem(avatarMenuItem())
        m.addItem(.separator())

        _ = action("Restart Server", #selector(restartServerAction), enabled: server.startedByUs || !health.reachable)
        _ = action("Show Server Log", #selector(showLog))
        m.addItem(.separator())
        _ = action("Quit Cairn", #selector(quitFromMenu), key: "q", mods: [.command])
        return m
    }

    /// "Avatar" submenu: styles from index.json (checkmark on the current one) + the classic native bubble.
    func avatarMenuItem() -> NSMenuItem {
        let item = NSMenuItem(title: "Avatar", action: nil, keyEquivalent: "")
        let sub = NSMenu(title: "Avatar")
        sub.autoenablesItems = false
        let current = currentAvatarKey
        let failed = bubbleHost?.avatar.failed == true
        for s in avatars.styles {
            let title = s.key == avatars.defaultKey ? "\(s.name) (default)" : s.name
            let i = NSMenuItem(title: title, action: #selector(selectAvatar(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = s.key
            i.state = s.key == current ? .on : .off
            if s.key == current && failed { i.toolTip = bubbleHost?.avatar.lastError }
            sub.addItem(i)
        }
        if !avatars.styles.isEmpty { sub.addItem(.separator()) }
        let classic = NSMenuItem(title: "Classic Bubble", action: #selector(selectAvatar(_:)), keyEquivalent: "")
        classic.target = self
        classic.representedObject = AvatarCatalog.classicKey
        classic.state = current == AvatarCatalog.classicKey ? .on : .off
        sub.addItem(classic)
        item.submenu = sub
        return item
    }

    @objc private func openDashboard() { NSWorkspace.shared.open(cfg.url("/")) }

    @objc private func openDocs() { NSWorkspace.shared.open(cfg.url("/docs/")) }

    @objc private func openDesktopDocs() { NSWorkspace.shared.open(cfg.url("/docs/desktop.html")) }

    /// "Show in Dock" (UserDefaults CairnShowInDock): switches between a regular Dock app and a bubble-only
    /// accessory app right away; the choice is kept for the next launch.
    @objc func toggleShowInDock() {
        let d = UserDefaults.standard
        d.set(!AppDelegate.showInDock(d), forKey: Keys.showInDock)
        applyActivationPolicy()
    }

    @objc private func showLog() {
        let url = URL(fileURLWithPath: cfg.logPath)
        if !FileManager.default.fileExists(atPath: cfg.logPath) { FileManager.default.createFile(atPath: cfg.logPath, contents: nil) }
        NSWorkspace.shared.open(url)
    }

    @objc private func resetPosition() {
        UserDefaults.standard.removeObject(forKey: Keys.origin)
        bubble.setFrame(NSRect(origin: defaultOrigin(), size: bubble.frame.size), display: true, animate: true)
        if chat.isVisible { chat.reposition(beside: bubble.frame) }
    }

    @objc private func toggleOpenOnAttention() {
        let d = UserDefaults.standard
        d.set(!d.bool(forKey: Keys.openOnAttention), forKey: Keys.openOnAttention)
    }

    @objc private func toggleGlobalHotkey() {
        if hotKeyRef != nil {
            unregisterHotKey()
            UserDefaults.standard.set(false, forKey: Keys.globalHotkey)
        } else {
            UserDefaults.standard.set(true, forKey: Keys.globalHotkey)
            registerHotKey()
        }
    }

    @objc private func restartServerAction() {
        Log.write("restart requested from the menu")
        consecutiveFailures = 0
        restartAttempts = 0
        nextRestartAllowed = Date().addingTimeInterval(10)
        health.reachable = false
        startupDeadline = Date().addingTimeInterval(20)
        updateBubble()
        if server.startedByUs {
            server.restart { [weak self] in
                guard let self = self else { return }
                self.startupDeadline = Date().addingTimeInterval(20)
                self.schedulePoll(after: 0.5)
            }
        } else {
            startServer(reason: "menu")
        }
    }

    /// Opt-in only: adds/removes this app in System Events login items (never done automatically).
    @objc private func toggleStartAtLogin() {
        guard !loginItemBusy else { return }
        let enable = !UserDefaults.standard.bool(forKey: Keys.startAtLogin)
        let path = Bundle.main.bundlePath
        let p = appleScriptString(path)
        let p2 = appleScriptString(path + "/")
        let removeExisting = """
            try
                delete (every login item whose path is \(p) or path is \(p2))
            end try
        """
        let script = enable ? """
        tell application "System Events"
        \(removeExisting)
            make login item at end with properties {path:\(p), hidden:false}
        end tell
        """ : """
        tell application "System Events"
        \(removeExisting)
        end tell
        """
        loginItemBusy = true
        runAppleScript(script) { [weak self] ok, output in
            guard let self = self else { return }
            self.loginItemBusy = false
            if ok {
                UserDefaults.standard.set(enable, forKey: Keys.startAtLogin)
                Log.write(enable ? "added login item \(path)" : "removed login item \(path)")
            } else {
                Log.write("login item update failed: \(output)")
                if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
                let a = NSAlert()
                a.alertStyle = .warning
                a.messageText = enable ? "Couldn't add Cairn to your login items" : "Couldn't remove Cairn from your login items"
                a.informativeText = "\(output)\n\nAllow Cairn to control “System Events” in System Settings › Privacy & Security › Automation, then try again. You can also manage it in System Settings › General › Login Items."
                a.addButton(withTitle: "OK")
                a.runModal()
            }
        }
    }

    @objc func quitFromMenu() {
        let busy = health.reachable ? health.runningRuns + health.queuedRuns : 0
        if busy > 0 && server.startedByUs {
            if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
            let a = NSAlert()
            a.messageText = "Quit Cairn?"
            a.informativeText = "\(busy) background task\(busy == 1 ? " is" : "s are") still running. Quitting stops the Cairn server and those tasks; scheduled reminders resume the next time Cairn starts."
            a.addButton(withTitle: "Quit")
            a.addButton(withTitle: "Cancel")
            if a.runModal() != .alertFirstButtonReturn { return }
        }
        NSApp.terminate(nil)
    }

    // MARK: keyboard — ⌥Space toggles the panel (global hot key when available, else while Cairn is active); Esc hides

    private func installKeyHandling() {
        if UserDefaults.standard.bool(forKey: Keys.globalHotkey) { registerHotKey() }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
            if event.keyCode == UInt16(kVK_Space) && flags == .option && self.hotKeyRef == nil {
                self.toggleChat()
                return nil
            }
            if event.keyCode == UInt16(kVK_Escape) && flags.isEmpty && self.chat.panel.isKeyWindow {
                self.chat.hide()
                return nil
            }
            return event
        }
    }

    private func registerHotKey() {
        guard hotKeyRef == nil else { return }
        if !hotKeyHandlerInstalled {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
                DispatchQueue.main.async { AppDelegate.shared?.toggleChat() }
                return noErr
            }, 1, &spec, nil, nil)
            hotKeyHandlerInstalled = (status == noErr)
        }
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: OSType(0x4341_524E), id: 1) // 'CARN'
        let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &ref)
        if status == noErr, let r = ref {
            hotKeyRef = r
            Log.write("global shortcut ⌥Space registered")
        } else {
            Log.write("global shortcut ⌥Space unavailable (status \(status)); it still works while Cairn is active")
        }
    }

    private func unregisterHotKey() {
        if let r = hotKeyRef {
            UnregisterEventHotKey(r)
            hotKeyRef = nil
        }
    }

    // MARK: signals — `kill`/`pkill` quit cleanly (and stop the server child)

    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                DispatchQueue.main.async {
                    Log.write("received signal \(sig); quitting")
                    NSApp.terminate(nil)
                }
            }
            src.resume()
            signalSources.append(src)
        }
    }
}

/// Menu bar items targeting the app delegate (the bubble and Dock menus set their state when they are built).
extension AppDelegate: NSMenuItemValidation {
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(toggleChat):
            item.title = chat?.isVisible == true ? "Hide Chat" : "Show Chat"
            return chat != nil
        case #selector(closeChatOrWindow(_:)):
            let other = NSApp.keyWindow.map { $0 !== chat?.panel && $0 !== bubble } ?? false
            item.title = other ? "Close Window" : "Close Chat"
            return other || chat?.isVisible == true
        case #selector(hideChat), #selector(reloadChat):
            return chat?.isVisible == true
        case #selector(toggleStartAtLogin):
            item.state = UserDefaults.standard.bool(forKey: Keys.startAtLogin) ? .on : .off
            return !loginItemBusy
        case #selector(toggleShowInDock):
            item.state = AppDelegate.showInDock() ? .on : .off
            return true
        default:
            return true
        }
    }
}

// MARK: - Headless self-test (run by build.sh): menu, bubble layers, geometry — no server, nothing shown

func runSelfTest() -> Int32 {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "ok  " : "FAIL") \(what)")
        if !ok { failures += 1 }
    }
    let d = AppDelegate()
    d.headless = true // nothing is ordered on screen, the app is never activated
    d.server = ServerManager(cfg: d.cfg)
    d.chat = ChatController(cfg: d.cfg)
    d.chat.headless = true
    d.makeBubble()

    d.health = Health()
    let offline = d.buildMenu().items.map { $0.title }
    check(offline.contains("Open Chat") && offline.contains("Quit Cairn") && offline.contains("Start at Login")
          && offline.contains("Show in Dock") && offline.contains("Reset Position") && offline.contains("Open Dashboard")
          && offline.contains("Open Docs"),
          "menu (offline): " + offline.filter { !$0.isEmpty }.joined(separator: " | "))

    // Dock app: CairnShowInDock (default true) → .regular, false → .accessory; the bundle is not an LSUIElement agent
    // (a scratch suite that is only ever registered into: in-memory, nothing is written to ~/Library/Preferences)
    if let ud = UserDefaults(suiteName: "com.cairn.bubble.selftest") {
        Keys.registerDefaults(ud)
        let byDefault = AppDelegate.activationPolicy(showInDock: AppDelegate.showInDock(ud))
        ud.register(defaults: [Keys.showInDock: false])
        let off = AppDelegate.activationPolicy(showInDock: AppDelegate.showInDock(ud))
        ud.register(defaults: [Keys.showInDock: true])
        let on = AppDelegate.activationPolicy(showInDock: AppDelegate.showInDock(ud))
        check(byDefault == .regular && off == .accessory && on == .regular,
              "activation policy honours CairnShowInDock (unset → regular, NO → accessory, YES → regular)")
    } else {
        check(false, "activation policy: could not create a scratch UserDefaults suite")
    }
    if Bundle.main.bundleURL.pathExtension == "app" {
        let ui = Bundle.main.object(forInfoDictionaryKey: "LSUIElement")
        let isAgent = (ui as? Bool) == true || (ui as? String).map { ["1", "true", "yes"].contains($0.lowercased()) } == true
        check(!isAgent, "Info.plist: LSUIElement is off, so the app gets a Dock icon (LSUIElement = \((ui as? Bool).map { $0 ? "true" : "false" } ?? "absent"))")
    }

    // main menu bar: App, Edit (first-responder selectors + key equivalents → ⌘C/⌘V work in the WKWebView), Window, Help
    let mainMenu = d.buildMainMenu()
    func menuItem(_ menu: String, _ title: String) -> NSMenuItem? {
        mainMenu.items.first { $0.submenu?.title == menu }?.submenu?.items.first { $0.title == title }
    }
    func keyed(_ menu: String, _ title: String, _ sel: Selector, _ key: String, _ mods: NSEvent.ModifierFlags,
               firstResponder: Bool = true) -> Bool {
        guard let i = menuItem(menu, title) else { return false }
        return i.action == sel && i.keyEquivalent == key
            && i.keyEquivalentModifierMask.intersection(.deviceIndependentFlagsMask) == mods
            && (firstResponder ? i.target == nil : i.target === d)
    }
    check(keyed("Edit", "Copy", #selector(NSText.copy(_:)), "c", [.command])
          && keyed("Edit", "Paste", #selector(NSText.paste(_:)), "v", [.command])
          && keyed("Edit", "Cut", #selector(NSText.cut(_:)), "x", [.command])
          && keyed("Edit", "Select All", #selector(NSText.selectAll(_:)), "a", [.command])
          && keyed("Edit", "Undo", Selector(("undo:")), "z", [.command])
          && keyed("Edit", "Redo", Selector(("redo:")), "z", [.command, .shift]),
          "main menu: Edit › Undo ⌘Z, Redo ⇧⌘Z, Cut ⌘X, Copy ⌘C, Paste ⌘V, Select All ⌘A (first responder)")
    check(menuItem("Cairn", "About Cairn") != nil && menuItem("Cairn", "Open Dashboard…") != nil
          && keyed("Cairn", "Hide Cairn", #selector(NSApplication.hide(_:)), "h", [.command])
          && keyed("Cairn", "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
          && menuItem("Cairn", "Show All") != nil
          && keyed("Cairn", "Quit Cairn", #selector(AppDelegate.quitFromMenu), "q", [.command], firstResponder: false)
          && keyed("Window", "Show Chat", #selector(AppDelegate.toggleChat), " ", [.option], firstResponder: false)
          && menuItem("Window", "Reset Bubble Position") != nil && menuItem("Window", "Minimize")?.keyEquivalent == "m"
          && menuItem("Help", "Cairn Docs") != nil,
          "main menu: " + mainMenu.items.map { m in
              "\(m.title) › " + (m.submenu?.items.filter { !$0.isSeparatorItem }.map { $0.title }.joined(separator: ", ") ?? "")
          }.joined(separator: " | "))

    var h = Health()
    h.reachable = true
    h.assistantApi = true
    h.runningRuns = 2
    h.queuedRuns = 1
    h.pendingApprovals = 3
    h.nextTaskAt = Date().addingTimeInterval(3600)
    d.health = h
    let busy = d.buildMenu().items.map { $0.title }
    check(busy.contains("2 tasks running") && busy.contains("1 queued") && busy.contains { $0.hasPrefix("3 approvals waiting") }
          && busy.contains { $0.hasPrefix("Next task:") }, "menu (busy): " + busy.filter { !$0.isEmpty }.joined(separator: " | "))
    check(HealthClient.parse(["runningRuns": 2, "pendingApprovals": [1, 2], "nextTaskAt": "2026-10-01T09:00:00.000Z"]).pendingApprovals == 2,
          "health parsing accepts counts or arrays")

    // Dock menu, badge and reopen (Dock icon click)
    let dockItems = d.applicationDockMenu(app)?.items ?? []
    let dockTitles = dockItems.filter { !$0.isSeparatorItem }.map { $0.title }
    let dockActions = dockItems.filter { $0.action != nil }
    check(["Open Chat", "New Chat", "Open Dashboard", "Open Docs", "Start at Login"].allSatisfy { dockTitles.contains($0) }
          && dockItems.contains { $0.title == "2 tasks running · 3 approvals" && !$0.isEnabled }
          && dockActions.allSatisfy { $0.target === d && d.responds(to: $0.action!) },
          "Dock menu: " + dockTitles.joined(separator: " | "))
    var zero = h
    zero.pendingApprovals = 0
    check(AppDelegate.dockBadgeLabel(health: h) == "3" && AppDelegate.dockBadgeLabel(health: zero) == nil
          && AppDelegate.dockBadgeLabel(health: Health()) == nil, "Dock badge = pending approvals (none at 0 or offline)")
    let showChatItem = menuItem("Window", "Show Chat")
    check(!d.chat.isVisible, "chat panel starts hidden")
    _ = d.applicationShouldHandleReopen(app, hasVisibleWindows: false)
    if let i = showChatItem { _ = d.validateMenuItem(i) }
    check(d.chat.isVisible && d.chat.pendingBubbleCalls.contains("focusComposer") && showChatItem?.title == "Hide Chat",
          "reopen (Dock click) opens the chat panel and focuses the composer (queued: \(d.chat.pendingBubbleCalls.joined(separator: ", ")))")
    check(AppDelegate.reopenAction(chatVisible: true, chatKey: true, appWasActive: true) == .hide
          && AppDelegate.reopenAction(chatVisible: true, chatKey: true, appWasActive: false) == .open
          && AppDelegate.reopenAction(chatVisible: false, chatKey: false, appWasActive: true) == .open,
          "reopen hides the chat only when Cairn was already frontmost with the chat focused")
    d.chat.hide()
    d.newChatFromDock()
    check(d.chat.isVisible && d.chat.pendingBubbleCalls.contains("newChat"), "Dock › New Chat opens the panel and calls cairnBubble.newChat()")
    d.chat.hide()

    d.updateBubble()
    d.bubbleView.pulse()
    check(d.bubbleView.spinning && d.bubbleView.badgeText == "3", "native bubble shows ring + badge while the avatar is not loaded")
    d.bubbleView.setRunning(false)
    d.bubbleView.setBadge(nil)
    check(d.bubbleHost.overlay.toolTip?.contains("2 tasks running") == true, "bubble status: \(d.bubbleHost.overlay.toolTip ?? "-")")
    check(d.bubble.frame.width == 88 && d.bubble.frame.height == 88, "bubble window is 88×88: \(d.bubble.frame.size)")
    let views = d.bubbleHost.subviews
    check(views.last === d.bubbleHost.overlay && views.contains(d.bubbleHost.avatar.webView),
          "overlay view sits above the avatar web view")
    let center = NSPoint(x: BubbleView.side / 2, y: BubbleView.side / 2)
    check(d.bubbleHost.hitTest(center) === d.bubbleHost.overlay, "overlay owns mouse events over the orb")

    // health → avatar state mapping
    let now = Date()
    var hs = Health()
    check(AppDelegate.avatarState(health: hs, lastAttention: nil, chatVisible: false) == .offline, "state: unreachable → offline")
    hs.reachable = true
    check(AppDelegate.avatarState(health: hs, lastAttention: nil, chatVisible: false) == .idle, "state: /api/health only → idle")
    check(AppDelegate.avatarState(health: hs, lastAttention: nil, chatVisible: true) == .listening, "state: chat open → listening")
    hs.runningRuns = 1
    check(AppDelegate.avatarState(health: hs, lastAttention: nil, chatVisible: true) == .working, "state: running → working")
    check(AppDelegate.avatarState(health: hs, lastAttention: now.addingTimeInterval(-3), chatVisible: false, now: now) == .attention,
          "state: attention message < 10 s ago → attention")
    check(AppDelegate.avatarState(health: hs, lastAttention: now.addingTimeInterval(-11), chatVisible: false, now: now) == .working,
          "state: attention expires after 10 s")
    hs.pendingApprovals = 1
    check(AppDelegate.avatarState(health: hs, lastAttention: nil, chatVisible: false) == .attention, "state: approvals → attention")

    // avatar catalog (bundled Contents/Resources/avatars when run from the app) + menu
    let cat = d.avatars
    check(!cat.styles.isEmpty && cat.style(cat.defaultKey) != nil,
          "avatar styles: \(cat.styles.map { $0.key }.joined(separator: ", ")) default=\(cat.defaultKey) dir=\(cat.dir?.path ?? "-")")
    if let dir = cat.dir, let res = Bundle.main.resourcePath, Bundle.main.bundleURL.pathExtension == "app",
       ProcessInfo.processInfo.environment["CAIRN_AVATAR_DIR"] == nil {
        check(dir.path.hasPrefix(res), "avatars load from the app bundle (work with the server down)")
    }
    let avatarItem = d.buildMenu().items.first { $0.title == "Avatar" }
    let subTitles = avatarItem?.submenu?.items.map { $0.title } ?? []
    check(avatarItem?.submenu?.items.contains { $0.state == .on } == true && subTitles.contains("Classic Bubble"),
          "menu: Avatar › " + subTitles.filter { !$0.isEmpty }.joined(separator: " | "))

    // chat header drag strip: buttons pass through to the web view, the rest drags
    let strip = HeaderDragView(frame: NSRect(x: 0, y: 568, width: 400, height: 52))
    let host = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 620))
    host.addSubview(strip)
    strip.passThrough = [NSRect(x: 300, y: 10, width: 32, height: 32)]
    check(strip.hitTest(NSPoint(x: 100, y: 600)) === strip && strip.hitTest(NSPoint(x: 310, y: 590)) == nil
          && strip.hitTest(NSPoint(x: 100, y: 300)) == nil, "header strip drags, header buttons pass through")

    // load every avatar page for real (offscreen): it must expose window.cairnAvatar.setState
    func spin(until done: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline { _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
    }
    if let dir = cat.dir {
        let ctl = AvatarController()
        let win = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 88, height: 88), styleMask: [.borderless],
                           backing: .buffered, defer: false)
        win.contentView?.addSubview(ctl.webView)
        var result: Bool?
        ctl.onAvailability = { ok in result = ok }
        for st in cat.styles {
            result = nil
            ctl.setState(.idle, running: 0, approvals: 0)
            ctl.load(st, from: dir)
            spin(until: { result != nil }, timeout: 8)
            var stateOK = result == true
            if stateOK {
                for s in AvatarState.allCases {
                    var r: Any?
                    var fin = false
                    ctl.webView.evaluateJavaScript("window.cairnAvatar.setState('\(s.rawValue)',{running:2,approvals:1});true") { v, e in
                        r = e == nil ? v : nil
                        fin = true
                    }
                    spin(until: { fin }, timeout: 3)
                    if (r as? Bool) != true { stateOK = false }
                }
                // native overlay owns the mouse: page hit-testing off, transparent, hover class scales it
                ctl.setHover(true)
                var probe: String?
                ctl.webView.evaluateJavaScript("""
                    (function(){var b=getComputedStyle(document.body);return [document.documentElement.classList.contains('cairn-hover'),
                    b.pointerEvents,b.backgroundColor,!!document.getElementById('cairn-native-style')].join('|')})()
                    """) { v, _ in probe = (v as? String) ?? "error" }
                spin(until: { probe != nil }, timeout: 3)
                ctl.setHover(false)
                if probe != "true|none|rgba(0, 0, 0, 0)|true" {
                    stateOK = false
                    print("     \(st.key): hover/transparency probe = \(probe ?? "timeout")")
                }
            }
            check(stateOK, "avatar '\(st.key)' (\(st.file)) loads and accepts every state\(result == nil ? " (timed out)" : (ctl.lastError.map { ": \($0)" } ?? ""))")
        }
        ctl.unload()
    }

    if let screen = NSScreen.screens.first {
        let vf = screen.visibleFrame
        let bubbleFrame = NSRect(origin: d.defaultOrigin(), size: NSSize(width: BubbleView.side, height: BubbleView.side))
        let circle = bubbleFrame.insetBy(dx: BubbleView.margin, dy: BubbleView.margin)
        check(abs(vf.maxX - circle.maxX - 16) < 0.5 && abs(vf.maxY - circle.maxY - 16) < 0.5, "default position top-right, 16 px inset: \(circle)")
        let panel = ChatController.frame(beside: bubbleFrame)
        check(vf.contains(panel) && !panel.intersects(circle), "panel beside bubble, on screen: \(panel)")
        let far = d.clamp(NSPoint(x: vf.maxX + 5000, y: vf.minY - 5000))
        let farCircle = NSRect(origin: far, size: bubbleFrame.size).insetBy(dx: BubbleView.margin, dy: BubbleView.margin)
        check(NSScreen.screens.contains { $0.visibleFrame.contains(farCircle) }, "off-screen position clamped back: \(farCircle)")
        let left = NSRect(x: vf.minX, y: vf.minY, width: BubbleView.side, height: BubbleView.side)
        let lp = ChatController.frame(beside: left)
        check(vf.contains(lp) && lp.minX > left.midX, "panel flips to the right of a bottom-left bubble: \(lp)")
    } else {
        print("skip geometry checks (no screen)")
    }
    check(appleScriptString("a\"b\\c") == "\"a\\\"b\\\\c\"", "AppleScript string escaping")
    print(failures == 0 ? "self-test passed" : "self-test FAILED (\(failures))")
    return failures == 0 ? 0 : 1
}

// MARK: - Entry point

@main
enum CairnMain {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--render-icon"), i + 1 < args.count {
            exit(Art.renderIcon(to: args[i + 1]) ? 0 : 1)
        }
        if args.contains("--self-test") {
            exit(runSelfTest())
        }
        if args.contains("--print-config") {
            let c = CairnConfig.load()
            print("root=\(c.root)")
            print("node=\(c.nodePath ?? "(not found)")")
            print("path=\(c.pathEnv)")
            print("port=\(c.port)")
            print("bubbleURL=\(c.bubbleURL.absoluteString)")
            print("log=\(c.logPath)")
            exit(c.nodePath != nil && FileManager.default.fileExists(atPath: c.cliPath) ? 0 : 1)
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        AppDelegate.shared = delegate
        app.delegate = delegate
        // Dock icon + menu bar by default; `defaults write com.cairn.bubble CairnShowInDock -bool NO` (or the
        // bubble menu's "Show in Dock") makes it a bubble-only accessory app.
        Keys.registerDefaults()
        app.setActivationPolicy(AppDelegate.activationPolicy(showInDock: AppDelegate.showInDock()))
        app.run()
    }
}
