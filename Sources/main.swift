import SwiftUI
import ServiceManagement
import UserNotifications
import CoreImage.CIFilterBuiltins

// MARK: - App

@main
struct MimoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @ObservedObject private var mimo = Mimo.shared
    var body: some Scene {
        MenuBarExtra {
            MimoPanel().environmentObject(mimo)
        } label: {
            Image(nsImage: Mimo.menuIcon)
            Text(mimo.menuTitle)
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var current: AppDelegate?
    var window: NSWindow?
    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.current = self
        let mimo = Mimo.shared
        if mimo.map == nil {
            showWindow(tab: .places)
            mimo.runMap(firstTime: true)
        } else {
            showWindow()
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow(); return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func showWindow(tab: MimoTab? = nil) {
        if let tab { Mimo.shared.tab = tab }
        if window == nil {
            let host = NSHostingController(rootView: MimoPanel().environmentObject(Mimo.shared))
            let w = NSWindow(contentViewController: host)
            w.title = "Mimo"
            w.styleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
            w.titlebarAppearsTransparent = true
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

// MARK: - Notifications (show banners even when Mimo is in front)

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let cat = r.notification.request.content.categoryIdentifier
        let tab: MimoTab? = cat == "review" ? .review : cat == "places" ? .places : nil
        DispatchQueue.main.async { AppDelegate.current?.showWindow(tab: tab) }
        done()
    }
}

// MARK: - Places Mimo can clean

struct CleanTarget: Identifiable, Codable, Hashable {
    enum Mode: String, Codable { case contents, olderFiles, installers, nodeModules }
    var id: String
    var name: String
    var icon: String
    var path: String            // relative to home, or absolute for custom places
    var mode: Mode
    var days: Int = 30
    var defaultOn: Bool = false
    var custom: Bool = false

    var permanent: Bool { mode == .contents || mode == .nodeModules }
    var usesDays: Bool { mode != .contents }
    var detail: String {
        switch mode {
        case .contents: return custom ? "Everything inside is deleted permanently." : (id == "bin" ? "Permanently deletes what's in your Bin." : "Deleted. Rebuilds itself when needed.")
        case .olderFiles: return "Files older than \(days) days move to the Bin."
        case .installers: return "Installers older than \(days) days move to the Bin."
        case .nodeModules: return "Deleted in projects untouched for \(days) days. Run npm install to restore."
        }
    }
    func url(_ home: URL) -> URL { path.hasPrefix("/") ? URL(fileURLWithPath: path) : home.appendingPathComponent(path) }
}

/// Places Mimo recognises on any Mac. Only the ones that exist on this Mac are shown.
let knownPlaces: [CleanTarget] = [
    CleanTarget(id: "caches", name: "App caches", icon: "shippingbox.fill", path: "Library/Caches", mode: .contents, defaultOn: true),
    CleanTarget(id: "whatsapp", name: "Old WhatsApp media", icon: "message.fill", path: "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media", mode: .olderFiles, days: 30, defaultOn: true),
    CleanTarget(id: "xcode", name: "Xcode build data", icon: "hammer.fill", path: "Library/Developer/Xcode/DerivedData", mode: .contents, defaultOn: true),
    CleanTarget(id: "devicesupport", name: "Xcode device support files", icon: "iphone", path: "Library/Developer/Xcode/iOS DeviceSupport", mode: .contents, defaultOn: true),
    CleanTarget(id: "simcaches", name: "iOS Simulator caches", icon: "ipad.and.iphone", path: "Library/Developer/CoreSimulator/Caches", mode: .contents, defaultOn: true),
    CleanTarget(id: "archives", name: "Old Xcode archives", icon: "archivebox.fill", path: "Library/Developer/Xcode/Archives", mode: .olderFiles, days: 180),
    CleanTarget(id: "gradle", name: "Gradle caches", icon: "cube.box.fill", path: ".gradle/caches", mode: .contents, defaultOn: true),
    CleanTarget(id: "npm", name: "npm cache", icon: "shippingbox", path: ".npm/_cacache", mode: .contents, defaultOn: true),
    CleanTarget(id: "pub", name: "Flutter / Dart package cache", icon: "bird.fill", path: ".pub-cache/hosted", mode: .contents),
    CleanTarget(id: "cocoapods", name: "CocoaPods specs", icon: "leaf.fill", path: ".cocoapods/repos", mode: .contents),
    CleanTarget(id: "slack", name: "Slack cache", icon: "number", path: "Library/Application Support/Slack/Cache", mode: .contents, defaultOn: true),
    CleanTarget(id: "slacksw", name: "Slack offline storage", icon: "number", path: "Library/Application Support/Slack/Service Worker/CacheStorage", mode: .contents, defaultOn: true),
    CleanTarget(id: "maildl", name: "Mail attachment copies", icon: "envelope.fill", path: "Library/Containers/com.apple.mail/Data/Library/Mail Downloads", mode: .contents, defaultOn: true),
    CleanTarget(id: "logs", name: "Old log files", icon: "doc.text.fill", path: "Library/Logs", mode: .olderFiles, days: 30, defaultOn: true),
    CleanTarget(id: "backups", name: "Old iPhone backups", icon: "iphone.gen3", path: "Library/Application Support/MobileSync/Backup", mode: .olderFiles, days: 180),
    CleanTarget(id: "installers", name: "Old installers in Downloads", icon: "arrow.down.doc.fill", path: "Downloads", mode: .installers, days: 30),
    CleanTarget(id: "bin", name: "Empty the Bin", icon: "trash.fill", path: ".Trash", mode: .contents),
]
let nodeModulesPlace = CleanTarget(id: "node_modules", name: "node_modules in old projects", icon: "curlybraces", path: "", mode: .nodeModules, days: 60)

// MARK: - Map of the Mac

struct FolderSize: Codable, Identifiable, Hashable { var path: String; var bytes: Int64; var id: String { path } }
struct FolderNode: Codable, Identifiable { var folder: FolderSize; var children: [FolderSize]; var id: String { folder.path } }
struct NodeModulesEntry: Codable, Hashable { var path: String; var bytes: Int64; var modified: Date }
struct MapResult: Codable {
    var date: Date
    var folders: Int
    var files: Int
    var totalBytes: Int64
    var tree: [FolderNode]
    var known: [String: Int64]
    var nodeModules: [NodeModulesEntry]
}

struct FoundItem: Identifiable {
    let id = UUID(); let url: URL; let bytes: Int64
    var label: String { url.lastPathComponent == "node_modules" ? url.deletingLastPathComponent().lastPathComponent + "/node_modules" : url.lastPathComponent }
}
struct Finding: Identifiable {
    let target: CleanTarget
    var items: [FoundItem]
    var id: String { target.id }
    var bytes: Int64 { items.reduce(0) { $0 + $1.bytes } }
}

enum MimoTab: String, CaseIterable, Identifiable { case overview = "Overview", review = "Review", places = "Places", settings = "Settings"; var id: String { rawValue } }

func fmt(_ b: Int64) -> String { ByteCountFormatter.string(fromByteCount: b, countStyle: .file) }

// MARK: - Model

struct Activity: Identifiable { let id = UUID(); let time: Date; let icon: String; let text: String }

final class Mimo: ObservableObject {
    static let shared = Mimo()
    private let d = UserDefaults.standard

    // live state
    @Published var tab: MimoTab = .overview
    @Published var freeGB = 0
    @Published var totalGB = 0
    @Published var isCleaning = false
    @Published var isScanning = false
    @Published var cleaningStep = ""
    @Published var lastCheck = Date()
    @Published var lastFreed: Int?
    @Published var totalFreed = 0
    @Published var activity: [Activity] = []
    @Published var findings: [Finding] = []
    @Published var pendingReview = false
    @Published var selected: Set<String> = []
    @Published var lastReport = Date()
    @Published var notificationsAllowed = true

    // mapping
    @Published var map: MapResult?
    @Published var isMapping = false
    @Published var mapFolders = 0
    @Published var mapBytes: Int64 = 0
    @Published var mapCurrent = ""

    // settings
    @Published var cleanBelowGB: Int { didSet { d.set(cleanBelowGB, forKey: "cleanBelowGB") } }
    @Published var askFirst: Bool { didSet { d.set(askFirst, forKey: "askFirst") } }
    @Published var reportMinutes: Int { didSet { d.set(reportMinutes, forKey: "reportMinutes") } }
    @Published var enabled: [String: Bool] { didSet { d.set(enabled, forKey: "enabledTargets") } }
    @Published var daysOverride: [String: Int] { didSet { d.set(daysOverride, forKey: "daysOverride") } }
    @Published var customPlaces: [CleanTarget] { didSet { d.set(try? JSONEncoder().encode(customPlaces), forKey: "customPlaces") } }
    @Published var countInstall: Bool { didSet { d.set(countInstall, forKey: "countInstall") } }

    // phone remote
    @Published var pairCode: String?
    @Published var pairExpires: Date?
    @Published var pairedPhones: Int = 0 { didSet { d.set(pairedPhones, forKey: "pairedPhones") } }
    @Published var remoteError: String?
    private var remoteTimer: Timer?
    private var remoteBusy = false
    private var lastStatusPush = Date.distantPast
    private var lastCommandPoll = Date.distantPast
    private var statusDirty = true
    private lazy var macName: String = Host.current().localizedName ?? "Mac"

    var warnGB: Int { cleanBelowGB + 10 }
    var reportEvery: TimeInterval { TimeInterval(reportMinutes * 60) }

    let home = FileManager.default.homeDirectoryForCurrentUser
    var logURL: URL { home.appendingPathComponent("Library/Logs/mimo.log") }
    var mapURL: URL { home.appendingPathComponent("Library/Application Support/Mimo/map.json") }
    private var timer: Timer?
    private var warned = false
    private var lastReviewNudge = Date.distantPast
    private var useNative = false

    static let menuIcon: NSImage = {
        let img = Bundle.main.url(forResource: "menu", withExtension: "svg").flatMap { NSImage(contentsOf: $0) } ?? NSImage(systemSymbolName: "pawprint.fill", accessibilityDescription: nil)!
        img.size = NSSize(width: 18, height: 18); img.isTemplate = true
        return img
    }()
    static let faceIcon: NSImage = Bundle.main.url(forResource: "mimo", withExtension: "png").flatMap { NSImage(contentsOf: $0) } ?? NSApp.applicationIconImage

    init() {
        cleanBelowGB = (d.object(forKey: "cleanBelowGB") as? Int) ?? 15
        askFirst = (d.object(forKey: "askFirst") as? Bool) ?? true
        reportMinutes = (d.object(forKey: "reportMinutes") as? Int) ?? 30
        enabled = (d.dictionary(forKey: "enabledTargets") as? [String: Bool]) ?? [:]
        var days = (d.dictionary(forKey: "daysOverride") as? [String: Int]) ?? [:]
        if days["whatsapp"] == nil, let old = d.object(forKey: "whatsappDays") as? Int { days["whatsapp"] = old }
        if days["installers"] == nil, let old = d.object(forKey: "installerDays") as? Int { days["installers"] = old }
        daysOverride = days
        countInstall = (d.object(forKey: "countInstall") as? Bool) ?? true
        pairedPhones = d.integer(forKey: "pairedPhones")
        customPlaces = (d.data(forKey: "customPlaces").flatMap { try? JSONDecoder().decode([CleanTarget].self, from: $0) }) ?? []
        map = (try? Data(contentsOf: mapURL)).flatMap { data in
            let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
            return try? dec.decode(MapResult.self, from: data)
        }

        try? SMAppService.mainApp.register()
        readDisk()
        add("pawprint.fill", "Mimo started — watching every minute")
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in
            DispatchQueue.main.async {
                self.useNative = ok
                self.refreshPermission()
                self.notify("Woof! Mimo is on duty 🐶 You have \(self.freeGB) GB free. I'll check every minute.")
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.check() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.check() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.reportInstallIfNeeded() }
        if d.bool(forKey: "remoteOn") { DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.startRemoteLoop() } }
    }

    // MARK: install count
    // Sends one anonymous ping the first time Mimo runs on a Mac: a random ID made here, the app version,
    // the macOS version and the chip type. No names, files or folder information ever leave the Mac.

    static let backend = URL(string: "https://mimo.techtree.lifestyle/v1/installs")!
    private var lastInstallAttempt = Date.distantPast

    var installId: String {
        if let id = d.string(forKey: "installId") { return id }
        let new = UUID().uuidString.lowercased(); d.set(new, forKey: "installId"); return new
    }

    /// Anonymous count of how much space a clean cleared, so Mimo's total impact can be shown. Same switch as the install count.
    func reportCleanup(bytes: Int64, categories: [(id: String, name: String, bytes: Int64)], trigger: String) {
        guard countInstall, bytes > 0 else { return }
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        let body: [String: Any] = [
            "installId": installId, "platform": "macos", "arch": arch, "trigger": trigger,
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "bytes": bytes,
            "categories": categories.map { ["id": $0.id, "name": $0.name, "bytes": $0.bytes] as [String: Any] },
        ]
        var req = URLRequest(url: URL(string: "https://mimo.techtree.lifestyle/v1/cleanups")!, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }

    func reportInstallIfNeeded() {
        guard countInstall, !d.bool(forKey: "installReported"),
              Date().timeIntervalSince(lastInstallAttempt) > 3600 else { return }
        lastInstallAttempt = Date()
        let id = installId
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let body: [String: String] = [
            "installId": id,
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
            "osVersion": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
            "arch": arch,
        ]
        var req = URLRequest(url: Mimo.backend, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            guard let code = (resp as? HTTPURLResponse)?.statusCode, (200..<300).contains(code) else { return }
            DispatchQueue.main.async {
                self.d.set(true, forKey: "installReported")
                self.log("Install counted anonymously")
            }
        }.resume()
    }

    // MARK: places

    /// Every place Mimo could clean on this Mac: recognised places that exist, project node_modules, and your own places.
    var allPlaces: [CleanTarget] {
        let fm = FileManager.default
        var list = knownPlaces.filter { fm.fileExists(atPath: $0.url(home).path) }
        if let m = map, !m.nodeModules.isEmpty { list.append(nodeModulesPlace) }
        list += customPlaces
        return list.map { t in var t = t; if let dd = daysOverride[t.id] { t.days = dd }; return t }
    }
    var enabledTargets: [CleanTarget] { allPlaces.filter { isOn($0) } }
    func isOn(_ t: CleanTarget) -> Bool { enabled[t.id] ?? (t.custom ? true : t.defaultOn) }
    func setOn(_ t: CleanTarget, _ on: Bool) { enabled[t.id] = on; findings.removeAll { $0.id == t.id }; selected.remove(t.id) }
    func setDays(_ t: CleanTarget, _ v: Int) { daysOverride[t.id] = v; findings.removeAll { $0.id == t.id } }
    func days(_ t: CleanTarget) -> Int { daysOverride[t.id] ?? t.days }
    func knownSize(_ t: CleanTarget) -> Int64? {
        if t.mode == .nodeModules { return map?.nodeModules.reduce(0) { $0 + $1.bytes } }
        return map?.known[t.id]
    }

    func addCustomPlace(path: String, clearEverything: Bool) {
        let id = "custom:" + path
        guard !customPlaces.contains(where: { $0.id == id }) else { return }
        let name = (path as NSString).lastPathComponent
        customPlaces.append(CleanTarget(id: id, name: name, icon: "folder.fill", path: path,
                                        mode: clearEverything ? .contents : .olderFiles, days: 30, defaultOn: true, custom: true))
        enabled[id] = true
        add("plus.circle.fill", "Added \(name) to my cleaning places")
    }
    func removeCustomPlace(_ t: CleanTarget) {
        customPlaces.removeAll { $0.id == t.id }
        enabled[t.id] = nil; findings.removeAll { $0.id == t.id }; selected.remove(t.id)
        add("minus.circle", "Removed \(t.name) from my cleaning places")
    }
    func isCustom(path: String) -> Bool { customPlaces.contains { $0.path == path } }
    /// Folders that a recognised place already covers, so the biggest-folders list doesn't double up.
    func coveredByKnown(_ path: String) -> CleanTarget? {
        allPlaces.first { !$0.custom && $0.mode != .nodeModules && !$0.path.isEmpty && $0.url(home).path == path }
    }

    // MARK: state

    var usedFraction: Double { totalGB == 0 ? 0 : Double(totalGB - freeGB) / Double(totalGB) }
    var menuTitle: String { isCleaning ? "cleaning…" : isMapping ? "mapping…" : pendingReview ? "\(freeGB)GB •" : "\(freeGB)GB" }
    var mood: (text: String, color: Color, emoji: String) {
        if isMapping { return ("Mapping your Mac", .teal, "🗺️") }
        if isCleaning { return ("Cleaning up for you", .blue, "🧹") }
        if pendingReview { return ("Waiting for your OK", .purple, "🐾") }
        if freeGB < cleanBelowGB { return ("Running low", .red, "😟") }
        if freeGB < warnGB { return ("Getting tight", .orange, "👀") }
        return ("All good", .green, "😊")
    }
    var selectedBytes: Int64 { findings.filter { selected.contains($0.id) }.reduce(0) { $0 + $1.bytes } }
    var foundBytes: Int64 { findings.reduce(0) { $0 + $1.bytes } }
    var nextReportText: String {
        let secs = max(0, Int(reportEvery - Date().timeIntervalSince(lastReport)))
        return secs >= 3600 ? "\(secs/3600)h \((secs%3600)/60)m" : "\(max(1, secs/60)) min"
    }

    func readDisk() {
        let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
        freeGB = Int((v?.volumeAvailableCapacityForImportantUsage ?? 0) / 1_000_000_000)
        totalGB = (v?.volumeTotalCapacity ?? 0) / 1_000_000_000
    }

    func add(_ icon: String, _ text: String) {
        statusDirty = true
        activity.insert(Activity(time: Date(), icon: icon, text: text), at: 0)
        if activity.count > 40 { activity.removeLast() }
        log(text)
    }

    // MARK: watching

    func check(manual: Bool = false) {
        readDisk(); lastCheck = Date()
        if manual { add("magnifyingglass", "Checked: \(freeGB) GB free") }
        reportInstallIfNeeded()
        if let m = map, Date().timeIntervalSince(m.date) > 7 * 86_400, !isMapping, !isCleaning { runMap(firstTime: false) }
        if freeGB < cleanBelowGB && !isCleaning && !isScanning {
            if askFirst {
                if !pendingReview { prepareReview(reason: .lowSpace) }
                else if Date().timeIntervalSince(lastReviewNudge) >= reportEvery { nudgeReview() }
            } else {
                add("exclamationmark.triangle.fill", "Low on space (\(freeGB) GB) — started cleaning")
                notify("Only \(freeGB) GB left — fetching the broom 🧹")
                scan { self.clean(ids: Set(self.findings.map { $0.id }), trigger: "auto") }
            }
            return
        }
        if freeGB < warnGB && !warned {
            warned = true
            add("exclamationmark.triangle.fill", "Space getting tight: \(freeGB) GB")
            notify("Heads up: only \(freeGB) GB left. I'll \(askFirst ? "ask you about cleaning" : "start cleaning") at \(cleanBelowGB) GB.")
        } else if freeGB >= warnGB { warned = false }
        if Date().timeIntervalSince(lastReport) >= reportEvery { report() }
    }

    func report() {
        readDisk(); lastReport = Date()
        add("bell.fill", "Sent you a storage update")
        notify(friendlyLine())
    }

    func friendlyLine() -> String {
        let f = freeGB
        if pendingReview { return "Psst 🐾 I've got \(fmt(foundBytes)) ready to clean. Click to review." }
        if f < cleanBelowGB { return "Ruff… only \(f) GB left 😟" }
        if f < warnGB {
            return ["Sniff sniff 👀 \(f) GB free — getting a bit tight, I'm watching closely.",
                    "Heads up, friend: \(f) GB left. I'll step in at \(cleanBelowGB) GB 🧹",
                    "Ears up 🐕 \(f) GB free. Not panicking yet, but I'm close by."].randomElement()!
        }
        return ["Woof! 🐶 Still on patrol — \(f) GB free. All good!",
                "Tail wagging 🐕 You've got \(f) GB free. Nothing to clean.",
                "Mimo checking in 🐾 \(f) GB free and looking healthy.",
                "Good news from your storage dog: \(f) GB free ✅",
                "Just did my rounds 🦴 \(f) GB free. Carry on!",
                "Sniffed every corner 👃 \(f) GB free — all clear."].randomElement()!
    }

    // MARK: mapping the Mac

    func runMap(firstTime: Bool) {
        guard !isMapping else { return }
        isMapping = true; mapFolders = 0; mapBytes = 0; mapCurrent = ""
        add("map.fill", firstTime ? "Mapping your Mac for the first time" : "Refreshing my map of your Mac")
        if firstTime { notify("Hi, I'm Mimo 🐶 I'm sniffing through your folders to learn where space goes. This takes a few minutes.") }
        let home = self.home
        let places = knownPlaces
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            let rootCount = home.pathComponents.count
            var sizes: [String: Int64] = [:]
            var folders = 0, files = 0
            var total: Int64 = 0
            var nm: [NodeModulesEntry] = []
            var lastPost = Date()
            let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .totalFileAllocatedSizeKey, .contentModificationDateKey]

            func addUp(_ dir: URL, _ bytes: Int64) {
                let comps = dir.pathComponents
                let depth = comps.count - rootCount
                guard depth >= 1 else { return }
                for level in 1...min(2, depth) {
                    sizes[NSString.path(withComponents: Array(comps.prefix(rootCount + level))), default: 0] += bytes
                }
            }

            guard let e = fm.enumerator(at: home, includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true }) else {
                DispatchQueue.main.async { self.isMapping = false }
                return
            }
            for case let url as URL in e {
                guard let r = try? url.resourceValues(forKeys: Set(keys)), r.isSymbolicLink != true else { continue }
                if r.isDirectory == true {
                    folders += 1
                    if url.lastPathComponent == "node_modules" {
                        let s = self.size(of: url)
                        nm.append(NodeModulesEntry(path: url.path, bytes: s, modified: r.contentModificationDate ?? Date()))
                        total += s; addUp(url, s)
                        e.skipDescendants()
                    }
                    if Date().timeIntervalSince(lastPost) > 0.25 {
                        lastPost = Date()
                        let f = folders, t = total, p = url.path.replacingOccurrences(of: home.path, with: "~")
                        DispatchQueue.main.async { self.mapFolders = f; self.mapBytes = t; self.mapCurrent = p }
                    }
                } else if r.isRegularFile == true {
                    files += 1
                    let s = Int64(r.totalFileAllocatedSize ?? 0)
                    total += s
                    addUp(url.deletingLastPathComponent(), s)
                }
            }

            // tree: top-level folders, each with its biggest sub-folders
            let top = sizes.filter { URL(fileURLWithPath: $0.key).pathComponents.count == rootCount + 1 }
                .sorted { $0.value > $1.value }.prefix(14)
            let tree: [FolderNode] = top.map { (p, b) in
                let kids = sizes.filter { URL(fileURLWithPath: $0.key).deletingLastPathComponent().path == p }
                    .sorted { $0.value > $1.value }.prefix(10)
                    .map { FolderSize(path: $0.key, bytes: $0.value) }
                return FolderNode(folder: FolderSize(path: p, bytes: b), children: Array(kids))
            }.filter { $0.folder.bytes > 50_000_000 }

            var known: [String: Int64] = [:]
            for t in places where fm.fileExists(atPath: t.url(home).path) { known[t.id] = self.size(of: t.url(home)) }

            let result = MapResult(date: Date(), folders: folders, files: files, totalBytes: total, tree: tree,
                                   known: known, nodeModules: nm.sorted { $0.bytes > $1.bytes })
            let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
            try? fm.createDirectory(at: self.mapURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? enc.encode(result).write(to: self.mapURL)

            DispatchQueue.main.async {
                self.map = result
                self.isMapping = false
                let cleanable = known.values.reduce(0, +) + nm.reduce(0) { $0 + $1.bytes }
                self.add("checkmark.seal.fill", "Mapped \(folders.formatted()) folders, \(fmt(total)) in total")
                if firstTime {
                    self.notify("Done mapping 🗺️ I found up to \(fmt(cleanable)) I could look after. Pick the places you want me to clean.", category: "places")
                }
                self.scan()
            }
        }
    }

    // MARK: review flow

    enum ReviewReason { case lowSpace, manual }

    func prepareReview(reason: ReviewReason) {
        scan {
            guard !self.findings.isEmpty else {
                self.add("checkmark.circle", "Looked for things to clean — found nothing")
                if reason == .manual { self.notify("I sniffed around and found nothing to clean 🐶") }
                return
            }
            self.selected = Set(self.findings.map { $0.id })
            self.pendingReview = true
            self.add("tray.full.fill", "Found \(fmt(self.foundBytes)) to clean — waiting for your OK")
            if reason == .lowSpace {
                self.lastReviewNudge = Date()
                self.notify("Only \(self.freeGB) GB left. I found \(fmt(self.foundBytes)) I can clean — click to review 🐾", category: "review")
            } else {
                self.tab = .review
            }
        }
    }

    func nudgeReview() {
        lastReviewNudge = Date(); lastReport = Date()
        notify("Still waiting on you 🐾 \(fmt(foundBytes)) is ready to clean and you have \(freeGB) GB free.", category: "review")
    }

    func cleanNow() {
        if askFirst { prepareReview(reason: .manual) }
        else {
            add("sparkles", "You asked me to clean up")
            notify("On it! Cleaning up now… 🧹")
            scan { self.clean(ids: Set(self.findings.map { $0.id }), trigger: "manual") }
        }
    }

    func approve(trigger: String = "review") {
        let ids = selected
        pendingReview = false
        add("hand.thumbsup.fill", "You approved \(fmt(selectedBytes)) for cleaning")
        clean(ids: ids, trigger: trigger)
    }

    func dismissReview() {
        pendingReview = false
        add("hand.raised.fill", "You said not now — I'll ask again if space stays low")
        lastReviewNudge = Date()
        tab = .overview
    }

    // MARK: scanning

    func scan(then: (() -> Void)? = nil) {
        guard !isScanning else { return }
        isScanning = true
        let targets = enabledTargets
        let nm = map?.nodeModules ?? []
        DispatchQueue.global(qos: .utility).async {
            var out: [Finding] = []
            for t in targets {
                let items = self.items(for: t, nodeModules: nm)
                if !items.isEmpty { out.append(Finding(target: t, items: items.sorted { $0.bytes > $1.bytes })) }
            }
            DispatchQueue.main.async {
                self.findings = out
                self.selected = self.selected.intersection(Set(out.map { $0.id }))
                self.isScanning = false
                then?()
            }
        }
    }

    private func items(for t: CleanTarget, nodeModules: [NodeModulesEntry]) -> [FoundItem] {
        let fm = FileManager.default
        let root = t.url(home)
        let cutoff = Date().addingTimeInterval(-Double(t.days) * 86_400)
        switch t.mode {
        case .contents:
            let kids = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            return kids.filter { !$0.lastPathComponent.lowercased().contains("mimo") && $0.lastPathComponent != ".DS_Store" }
                .map { FoundItem(url: $0, bytes: size(of: $0)) }
                .filter { $0.bytes > 0 }
        case .olderFiles:
            var out: [FoundItem] = []
            let keys: Set<URLResourceKey> = [.totalFileAllocatedSizeKey, .contentModificationDateKey, .isRegularFileKey]
            guard let e = fm.enumerator(at: root, includingPropertiesForKeys: Array(keys)) else { return [] }
            for case let f as URL in e {
                guard !f.lastPathComponent.lowercased().contains("mimo"),
                      let r = try? f.resourceValues(forKeys: keys),
                      r.isRegularFile == true, let dd = r.contentModificationDate, dd < cutoff else { continue }
                out.append(FoundItem(url: f, bytes: Int64(r.totalFileAllocatedSize ?? 0)))
            }
            return out
        case .installers:
            let exts: Set<String> = ["dmg", "pkg", "zip", "iso", "xip"]
            let kids = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey])) ?? []
            return kids.compactMap { f in
                guard exts.contains(f.pathExtension.lowercased()),
                      let r = try? f.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                      r.isRegularFile == true, let dd = r.contentModificationDate, dd < cutoff else { return nil }
                return FoundItem(url: f, bytes: size(of: f))
            }
        case .nodeModules:
            return nodeModules.compactMap { n in
                let u = URL(fileURLWithPath: n.path)
                guard fm.fileExists(atPath: n.path) else { return nil }
                let mod = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? n.modified
                guard mod < cutoff else { return nil }
                return FoundItem(url: u, bytes: n.bytes)
            }
        }
    }

    func size(of url: URL) -> Int64 {
        let keys: Set<URLResourceKey> = [.totalFileAllocatedSizeKey, .isRegularFileKey]
        if let r = try? url.resourceValues(forKeys: keys), r.isRegularFile == true { return Int64(r.totalFileAllocatedSize ?? 0) }
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: Array(keys), options: [], errorHandler: { _, _ in true }) else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e {
            if let r = try? f.resourceValues(forKeys: keys), r.isRegularFile == true { total += Int64(r.totalFileAllocatedSize ?? 0) }
        }
        return total
    }

    // MARK: cleaning

    func clean(ids: Set<String>, trigger: String = "review") {
        guard !isCleaning else { return }
        let work = findings.filter { ids.contains($0.id) }
        guard !work.isEmpty else { add("checkmark.circle", "Nothing to clean"); return }
        isCleaning = true
        tab = .overview
        let before = freeGB
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            var cleared: [(id: String, name: String, bytes: Int64)] = []
            for f in work {
                DispatchQueue.main.async { self.cleaningStep = "Clearing \(f.target.name.lowercased())…" }
                var bytes: Int64 = 0
                for item in f.items {
                    do {
                        if f.target.permanent { try fm.removeItem(at: item.url) }
                        else { try fm.trashItem(at: item.url, resultingItemURL: nil) }
                        bytes += item.bytes
                    } catch { /* in use or protected: skip */ }
                }
                // Report built-in places by id; your own folders only as "Your folders" (never their names).
                if bytes > 0 { cleared.append((f.target.custom ? "custom" : f.target.id, f.target.custom ? "Your folders" : f.target.name, bytes)) }
            }
            let clearedTotal = cleared.reduce(Int64(0)) { $0 + $1.bytes }
            self.reportCleanup(bytes: clearedTotal, categories: cleared, trigger: trigger)
            DispatchQueue.main.async {
                self.readDisk()
                let freed = max(self.freeGB - before, 0)
                self.lastFreed = freed; self.totalFreed += freed
                self.isCleaning = false; self.cleaningStep = ""
                self.lastReport = Date()
                self.findings.removeAll { ids.contains($0.id) }
                self.selected = []
                let names = work.map { $0.target.name.lowercased() }.joined(separator: ", ")
                self.add("checkmark.seal.fill", "Cleaned \(names) — cleared \(fmt(clearedTotal))")
                self.notify("Good boy report 🐾 Cleared \(fmt(clearedTotal)) — you now have \(self.freeGB) GB free.")
                self.scan()
            }
        }
    }

    // MARK: phone remote
    // Pairs this Mac with the owner's phone. The Mac sends storage totals, what Mimo found per category,
    // its places and activity (never file names or paths) and polls for commands the phone queued.

    static let remoteAPI = "https://mimo.techtree.lifestyle/v1"
    var remoteAppURL: String { "https://mimo.techtree.lifestyle/app/" + (pairCode.map { "#pair=\($0)" } ?? "") }

    private var deviceSecret: String {
        if let s = d.string(forKey: "deviceSecret") { return s }
        let s = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        d.set(s, forKey: "deviceSecret"); return s
    }

    private func remoteCall(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: Mimo.remoteAPI + path)!, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue(installId, forHTTPHeaderField: "X-Mimo-Device")
        req.setValue("Bearer " + deviceSecret, forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(code) else {
            throw NSError(domain: "Mimo", code: code, userInfo: [NSLocalizedDescriptionKey: (obj["error"] as? String) ?? "Mimo's server answered \(code)"])
        }
        return obj
    }

    func startPairing() {
        remoteError = nil
        let body: [String: Any] = ["deviceId": installId, "secret": deviceSecret, "name": macName]
        Task {
            do {
                let r = try await remoteCall("/pair/start", method: "POST", body: body)
                await MainActor.run {
                    self.pairCode = r["code"] as? String
                    self.pairExpires = Date().addingTimeInterval(600)
                    self.d.set(true, forKey: "remoteOn")
                    self.add("iphone", "Showing a code to pair your phone")
                    self.statusDirty = true
                    self.startRemoteLoop()
                }
            } catch {
                await MainActor.run { self.remoteError = "Couldn't reach Mimo's server. Check your internet and try again." }
            }
        }
    }

    func cancelPairing() { pairCode = nil; pairExpires = nil }

    func unpairAll() {
        Task {
            do {
                _ = try await remoteCall("/device/unpair-all", method: "POST", body: [:])
                await MainActor.run {
                    self.pairedPhones = 0; self.pairCode = nil
                    self.add("iphone.slash", "Unpaired all phones")
                }
            } catch {
                await MainActor.run { self.remoteError = "Couldn't reach Mimo's server to unpair. Try again." }
            }
        }
    }

    func startRemoteLoop() {
        guard remoteTimer == nil else { return }
        remoteTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.remoteTick() }
        remoteTick()
    }

    private func remoteTick() {
        if let exp = pairExpires, Date() > exp { pairCode = nil; pairExpires = nil }
        let active = pairedPhones > 0 || pairCode != nil
        let pollEvery: TimeInterval = active ? 5 : 60
        guard !remoteBusy, Date().timeIntervalSince(lastCommandPoll) >= pollEvery else { return }
        remoteBusy = true
        lastCommandPoll = Date()
        let pushStatus = active && (statusDirty || Date().timeIntervalSince(lastStatusPush) >= 20)
        let status = pushStatus ? remoteStatus() : [:]
        if pushStatus { statusDirty = false; lastStatusPush = Date() }
        Task {
            defer { DispatchQueue.main.async { self.remoteBusy = false } }
            do {
                if pushStatus {
                    let r = try await remoteCall("/device/status", method: "POST", body: ["status": status])
                    await MainActor.run { self.updatePhones(r["phones"] as? Int) }
                }
                let r = try await remoteCall("/device/commands")
                await MainActor.run { self.updatePhones(r["phones"] as? Int) }
                for c in (r["commands"] as? [[String: Any]]) ?? [] {
                    guard let id = c["id"] as? String, let type = c["type"] as? String else { continue }
                    let args = c["args"] as? [String: Any] ?? [:]
                    let (ok, message) = await MainActor.run { self.runRemote(type, args) }
                    _ = try? await remoteCall("/device/commands/\(id)", method: "POST", body: ["ok": ok, "message": message])
                    await MainActor.run { self.statusDirty = true; self.lastCommandPoll = .distantPast }
                }
            } catch {
                // Offline or server unavailable: try again on the next tick.
            }
        }
    }

    private func updatePhones(_ n: Int?) {
        guard let n else { return }
        if n > pairedPhones && pairCode != nil {
            pairCode = nil; pairExpires = nil
            add("iphone", "Paired with your phone")
            notify("Your phone is paired 📱 You can now check on me and tell me what to clean from anywhere.")
        }
        pairedPhones = n
    }

    /// Runs a command that came from the paired phone. Returns whether it worked and a short message for the phone.
    private func runRemote(_ type: String, _ args: [String: Any]) -> (Bool, String) {
        switch type {
        case "check":
            check(manual: true)
            return (true, "Checked: \(freeGB) GB free")
        case "notify":
            notify("Hello from your phone 📱 " + friendlyLine())
            return (true, "Notification sent to your Mac")
        case "scan":
            add("iphone", "Your phone asked me to look for things to clean")
            prepareReview(reason: .manual)
            return (true, "Looking for things to clean")
        case "clean":
            let ids = Set((args["ids"] as? [String]) ?? [])
            let valid = ids.intersection(Set(findings.map { $0.id }))
            guard !valid.isEmpty else { return (false, "Nothing to clean right now. Tap Find things to clean first.") }
            selected = valid
            add("iphone", "Your phone approved cleaning \(fmt(selectedBytes))")
            approve(trigger: "phone")
            return (true, "Cleaning started")
        case "dismiss":
            dismissReview()
            return (true, "OK, not now")
        case "setThreshold":
            let gb = max(5, min(500, (args["gb"] as? Int) ?? cleanBelowGB))
            cleanBelowGB = gb
            add("iphone", "Your phone set cleaning to start below \(gb) GB")
            return (true, "Mimo now steps in below \(gb) GB")
        case "setAskFirst":
            let on = (args["on"] as? Bool) ?? true
            askFirst = on
            add("iphone", on ? "Your phone turned on Ask me first" : "Your phone turned on Clean automatically")
            return (true, on ? "Mimo will ask before deleting" : "Mimo will clean on his own")
        case "setPlace":
            guard let id = args["id"] as? String, let t = allPlaces.first(where: { $0.id == id }) else { return (false, "That place isn't on this Mac anymore") }
            let on = (args["on"] as? Bool) ?? false
            setOn(t, on)
            add("iphone", "Your phone turned \(on ? "on" : "off") \(t.name)")
            scan()
            return (true, "\(t.name) turned \(on ? "on" : "off")")
        case "remap":
            runMap(firstTime: false)
            return (true, "Mapping your Mac")
        default:
            return (false, "This version of Mimo doesn't know that command. Update Mimo on your Mac.")
        }
    }

    private func remoteStatus() -> [String: Any] {
        let iso = ISO8601DateFormatter()
        return [
            "name": macName,
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "freeGB": freeGB, "totalGB": totalGB,
            "mood": "\(mood.text) \(mood.emoji)",
            "isCleaning": isCleaning, "isScanning": isScanning, "isMapping": isMapping,
            "cleaningStep": cleaningStep,
            "pendingReview": pendingReview,
            "cleanBelowGB": cleanBelowGB, "askFirst": askFirst,
            "lastFreed": lastFreed ?? 0, "totalFreed": totalFreed,
            "findings": findings.map { ["id": $0.id, "name": $0.target.name, "bytes": $0.bytes, "count": $0.items.count, "permanent": $0.target.permanent] as [String: Any] },
            "places": allPlaces.map { t -> [String: Any] in
                var p: [String: Any] = ["id": t.id, "name": t.name, "on": isOn(t)]
                if let b = knownSize(t) { p["bytes"] = b }
                return p
            },
            "activity": activity.prefix(15).map { ["time": iso.string(from: $0.time), "text": $0.text] },
            "updatedAt": iso.string(from: Date()),
        ]
    }

    func qrImage(_ text: String) -> NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: out.extent.width / 2, height: out.extent.height / 2))
    }

    // MARK: notifications + log

    func refreshPermission() {
        UNUserNotificationCenter.current().getNotificationSettings { st in
            DispatchQueue.main.async {
                self.notificationsAllowed = st.authorizationStatus == .authorized || st.authorizationStatus == .provisional
                self.useNative = self.notificationsAllowed
            }
        }
    }

    func openNotificationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
    }
    func openFullDiskAccessSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
    }

    func notify(_ msg: String, category: String? = nil) {
        if useNative {
            let c = UNMutableNotificationContent(); c.title = "Mimo 🐶"; c.body = msg; c.sound = .default
            if let category { c.categoryIdentifier = category }
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        } else {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = ["-e", "display notification \"\(msg.replacingOccurrences(of: "\"", with: "'"))\" with title \"Mimo 🐶\" sound name \"Glass\""]
            try? p.run()
        }
    }

    func log(_ line: String) {
        let text = "\(Date()): \(line)\n"
        if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(text.data(using: .utf8)!); h.closeFile() }
        else { try? text.write(to: logURL, atomically: true, encoding: .utf8) }
    }
}

// MARK: - UI

struct MimoPanel: View {
    @EnvironmentObject var mimo: Mimo
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Picker("", selection: $mimo.tab) {
                ForEach(MimoTab.allCases) { t in
                    Text(t == .review && mimo.pendingReview ? "Review •" : t.rawValue).tag(t)
                }
            }
            .pickerStyle(.segmented).labelsHidden()
            Group {
                switch mimo.tab {
                case .overview: OverviewTab()
                case .review: ReviewTab()
                case .places: PlacesTab()
                case .settings: SettingsTab()
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .padding(16)
        .frame(width: 400, height: 660)
        .onAppear { mimo.readDisk(); if mimo.findings.isEmpty && !mimo.isMapping { mimo.scan() }; mimo.refreshPermission() }
    }

    var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: Mimo.faceIcon).resizable().frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("Mimo").font(.system(size: 17, weight: .bold, design: .rounded))
                HStack(spacing: 5) {
                    Circle().fill(mimo.mood.color).frame(width: 7, height: 7)
                    Text("\(mimo.mood.text) \(mimo.mood.emoji)").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text("checked \(mimo.lastCheck, style: .relative) ago").font(.caption2).foregroundStyle(.tertiary).multilineTextAlignment(.trailing)
        }
    }
}

struct OverviewTab: View {
    @EnvironmentObject var mimo: Mimo
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            gauge
            if mimo.isMapping { banner("Mapping your Mac… \(mimo.mapFolders.formatted()) folders so far", .teal) }
            else if mimo.isCleaning { banner(mimo.cleaningStep.isEmpty ? "Cleaning…" : mimo.cleaningStep, .blue) }
            else if mimo.pendingReview {
                HStack {
                    Image(systemName: "tray.full.fill").foregroundStyle(.purple)
                    Text("\(fmt(mimo.foundBytes)) is waiting for your OK").font(.callout)
                    Spacer()
                    Button("Review") { mimo.tab = .review }.controlSize(.small)
                }
                .padding(10).background(RoundedRectangle(cornerRadius: 10).fill(Color.purple.opacity(0.12)))
            }
            cleanables
            activityFeed
            Spacer(minLength: 0)
            HStack {
                Button { mimo.cleanNow() } label: { Label(mimo.askFirst ? "Find things to clean" : "Clean now", systemImage: "sparkles") }
                    .buttonStyle(.borderedProminent).disabled(mimo.isCleaning || mimo.isScanning)
                Button { mimo.check(manual: true); mimo.report() } label: { Label("Check", systemImage: "arrow.clockwise") }
                Spacer()
                Menu {
                    Button("Open Mimo window") { AppDelegate.current?.showWindow() }
                    Button("Open log") { NSWorkspace.shared.open(mimo.logURL) }
                    Divider()
                    Button("Quit Mimo") { NSApp.terminate(nil) }
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).fixedSize()
            }
        }
    }

    func banner(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(text).font(.callout) }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.12)))
    }

    var gauge: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.15), lineWidth: 10)
                Circle().trim(from: 0, to: mimo.usedFraction)
                    .stroke(mimo.mood.color.gradient, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeInOut, value: mimo.usedFraction)
                VStack(spacing: 0) {
                    Text("\(mimo.freeGB)").font(.system(size: 24, weight: .bold, design: .rounded))
                    Text("GB free").font(.caption2).foregroundStyle(.secondary)
                }
            }.frame(width: 88, height: 88)
            VStack(alignment: .leading, spacing: 6) {
                stat("internaldrive", "\(mimo.totalGB - mimo.freeGB) of \(mimo.totalGB) GB used")
                stat("trash.circle", "Steps in below \(mimo.cleanBelowGB) GB")
                stat(mimo.askFirst ? "hand.raised" : "bolt", mimo.askFirst ? "Asks before deleting" : "Cleans automatically")
                stat("mappin.and.ellipse", "Looking after \(mimo.enabledTargets.count) places")
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.secondary.opacity(0.08)))
    }

    func stat(_ icon: String, _ text: String) -> some View {
        Label { Text(text).font(.caption) } icon: { Image(systemName: icon).foregroundStyle(.secondary).frame(width: 14) }
    }

    var cleanables: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Ready to clean now").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if mimo.isScanning { ProgressView().controlSize(.mini) }
                Button("Change places") { mimo.tab = .places }.buttonStyle(.link).font(.caption)
            }
            if mimo.enabledTargets.isEmpty {
                Text("I'm not looking after any places yet. Pick some in Places.").font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(spacing: 5) {
                    ForEach(mimo.enabledTargets) { t in
                        HStack {
                            Image(systemName: t.icon).foregroundStyle(.blue).frame(width: 18)
                            Text(t.name).font(.callout).lineLimit(1)
                            Spacer()
                            Text(mimo.findings.first { $0.id == t.id }.map { fmt($0.bytes) } ?? (mimo.isScanning ? "…" : "Zero KB"))
                                .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
            }.frame(maxHeight: 150)
        }
    }

    var activityFeed: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What I've been doing").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(mimo.activity) { a in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: a.icon).font(.caption).foregroundStyle(.blue).frame(width: 16)
                            Text(a.text).font(.caption).fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            Text(a.time, style: .time).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }.frame(maxHeight: 110)
        }
    }
}

struct ReviewTab: View {
    @EnvironmentObject var mimo: Mimo
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if mimo.isScanning {
                HStack { ProgressView().controlSize(.small); Text("Sniffing around for things to clean…").font(.callout) }
                Spacer()
            } else if mimo.findings.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Nothing waiting for review").font(.headline)
                    Text("When space runs low I'll gather everything I want to remove here, so you can choose what goes.")
                        .font(.callout).foregroundStyle(.secondary)
                    Button { mimo.prepareReview(reason: .manual) } label: { Label("Look for things to clean", systemImage: "magnifyingglass") }
                }
                Spacer()
            } else {
                Text(mimo.pendingReview ? "I'd like to clean these. Untick anything you want to keep." : "Here's what I can clean right now. Tick what should go.")
                    .font(.callout).foregroundStyle(.secondary)
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(mimo.findings) { f in findingRow(f) }
                    }
                }
                Divider()
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(fmt(mimo.selectedBytes)) selected").font(.callout.weight(.semibold))
                        Text("\(mimo.selected.count) of \(mimo.findings.count) groups").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Not now") { mimo.dismissReview() }
                    Button { mimo.approve() } label: { Text("Clean selected") }
                        .buttonStyle(.borderedProminent).disabled(mimo.selected.isEmpty || mimo.isCleaning)
                }
            }
        }
    }

    func findingRow(_ f: Finding) -> some View {
        let on = Binding(get: { mimo.selected.contains(f.id) },
                         set: { if $0 { mimo.selected.insert(f.id) } else { mimo.selected.remove(f.id) } })
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Toggle(isOn: on) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(f.target.name, systemImage: f.target.icon).font(.callout.weight(.medium))
                        Text("\(f.items.count) item\(f.items.count == 1 ? "" : "s") · \(f.target.permanent ? "deleted permanently" : "moved to the Bin")")
                            .font(.caption).foregroundStyle(f.target.permanent ? Color.orange : Color.secondary)
                    }
                }.toggleStyle(.checkbox)
                Spacer()
                Text(fmt(f.bytes)).font(.callout.monospacedDigit())
            }
            DisclosureGroup("Biggest items") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(f.items.prefix(8)) { i in
                        HStack {
                            Text(i.label).font(.caption).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(fmt(i.bytes)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        .help(i.url.path)
                        .contextMenu { Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([i.url]) } }
                    }
                    if f.items.count > 8 { Text("and \(f.items.count - 8) more").font(.caption2).foregroundStyle(.tertiary) }
                }
                .padding(.top, 4)
            }
            .font(.caption)
            .padding(.leading, 22)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.07)))
    }
}

struct PlacesTab: View {
    @EnvironmentObject var mimo: Mimo
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                mapCard
                if mimo.map != nil || !mimo.allPlaces.isEmpty {
                    section("Places I recognise", "Safe spots that fill up over time. Ticked ones are mine to look after.") {
                        let rec = mimo.allPlaces.filter { !$0.custom }
                            .sorted { (mimo.knownSize($0) ?? 0) > (mimo.knownSize($1) ?? 0) }
                        ForEach(rec) { t in placeRow(t) }
                    }
                }
                if !mimo.customPlaces.isEmpty {
                    section("Your places", "Folders you added yourself.") {
                        ForEach(mimo.allPlaces.filter { $0.custom }) { t in placeRow(t, removable: true) }
                    }
                }
                if let m = mimo.map, !m.tree.isEmpty {
                    section("Where your space goes", "Your biggest folders. Add any of them as a place for me to clean.") {
                        ForEach(m.tree) { node in folderNode(node, total: m.totalBytes) }
                    }
                }
            }
            .padding(.trailing, 6)
        }
    }

    var mapCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            if mimo.isMapping {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Mapping your Mac…").font(.callout.weight(.semibold))
                    Spacer()
                    Text(fmt(mimo.mapBytes)).font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                }
                Text("\(mimo.mapFolders.formatted()) folders checked").font(.caption).foregroundStyle(.secondary)
                Text(mimo.mapCurrent).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
            } else if let m = mimo.map {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("I've mapped \(m.folders.formatted()) folders").font(.callout.weight(.semibold))
                        Text("\(fmt(m.totalBytes)) in your home folder · updated \(m.date, style: .relative) ago").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Map again") { mimo.runMap(firstTime: false) }.controlSize(.small)
                }
            } else {
                Text("Let me map your Mac").font(.callout.weight(.semibold))
                Text("I'll look through every folder in your home folder to learn where your space goes. Nothing is deleted.")
                    .font(.caption).foregroundStyle(.secondary)
                Button { mimo.runMap(firstTime: true) } label: { Label("Start mapping", systemImage: "map") }
                    .buttonStyle(.borderedProminent).controlSize(.small)
            }
            HStack(spacing: 4) {
                Image(systemName: "lock.shield").foregroundStyle(.secondary)
                Text("For a full map, give Mimo Full Disk Access.").font(.caption2).foregroundStyle(.secondary)
                Button("Open settings") { mimo.openFullDiskAccessSettings() }.buttonStyle(.link).font(.caption2)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.teal.opacity(0.10)))
    }

    func placeRow(_ t: CleanTarget, removable: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Toggle(isOn: Binding(get: { mimo.isOn(t) }, set: { mimo.setOn(t, $0) })) {
                    VStack(alignment: .leading, spacing: 1) {
                        Label(t.name, systemImage: t.icon)
                        Text(t.detail).font(.caption).foregroundStyle(t.permanent && (t.custom || t.id == "bin") ? Color.orange : Color.secondary)
                        if t.mode == .nodeModules, let n = mimo.map?.nodeModules.count {
                            Text("Found in \(n) project\(n == 1 ? "" : "s")").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                .toggleStyle(.checkbox)
                Spacer()
                if let s = mimo.knownSize(t) { Text(fmt(s)).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                if removable {
                    Button { mimo.removeCustomPlace(t) } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless).foregroundStyle(.secondary).help("Remove this place")
                }
            }
            if t.usesDays && mimo.isOn(t) {
                Stepper("Only items older than \(mimo.days(t)) days",
                        value: Binding(get: { mimo.days(t) }, set: { mimo.setDays(t, $0) }), in: 7...730, step: 7)
                    .font(.caption).padding(.leading, 22)
            }
        }
    }

    func folderNode(_ node: FolderNode, total: Int64) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(node.children) { c in folderRow(c, total: node.folder.bytes) }
            }
            .padding(.top, 4)
        } label: {
            folderRow(node.folder, total: total, bold: true)
        }
    }

    func folderRow(_ f: FolderSize, total: Int64, bold: Bool = false) -> some View {
        let name = f.path.replacingOccurrences(of: mimo.home.path, with: "~")
        let covered = mimo.coveredByKnown(f.path)
        let added = mimo.isCustom(path: f.path)
        return VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(bold ? (f.path as NSString).lastPathComponent : name).font(bold ? .callout.weight(.medium) : .caption)
                    .lineLimit(1).truncationMode(.middle).help(name)
                Spacer()
                Text(fmt(f.bytes)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if let covered {
                    Text(covered.name).font(.caption2).foregroundStyle(.teal).lineLimit(1)
                } else if added {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).help("Already one of your places")
                } else {
                    Menu {
                        Button("Move files older than 30 days to the Bin") { mimo.addCustomPlace(path: f.path, clearEverything: false) }
                        Button("Delete everything inside (permanent)") { mimo.addCustomPlace(path: f.path, clearEverything: true) }
                        Divider()
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: f.path)]) }
                    } label: { Image(systemName: "plus.circle") }
                    .menuStyle(.borderlessButton).fixedSize().help("Add as a cleaning place")
                }
            }
            GeometryReader { g in
                RoundedRectangle(cornerRadius: 2).fill(Color.blue.opacity(0.55))
                    .frame(width: max(2, g.size.width * CGFloat(Double(f.bytes) / Double(max(total, 1)))))
            }.frame(height: 4)
        }
    }

    func section<C: View>(_ title: String, _ subtitle: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(subtitle).font(.caption2).foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 10) { content() }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.07)))
        }
    }
}

struct SettingsTab: View {
    @EnvironmentObject var mimo: Mimo
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                section("When to step in") {
                    Stepper(value: $mimo.cleanBelowGB, in: 5...500, step: 5) {
                        HStack {
                            Text("Clean when free space drops below")
                            Spacer()
                            Text("\(mimo.cleanBelowGB) GB").font(.body.monospacedDigit().weight(.semibold))
                        }
                    }
                    Text("I'll send you a heads-up at \(mimo.warnGB) GB.").font(.caption).foregroundStyle(.secondary)
                }

                section("Before deleting") {
                    Picker("", selection: $mimo.askFirst) {
                        Text("Ask me first — gather everything for review").tag(true)
                        Text("Clean automatically").tag(false)
                    }
                    .pickerStyle(.radioGroup).labelsHidden()
                }

                section("What I clean") {
                    HStack {
                        Text("Looking after \(mimo.enabledTargets.count) of \(mimo.allPlaces.count) places")
                        Spacer()
                        Button("Choose places") { mimo.tab = .places }.controlSize(.small)
                    }
                }

                section("Phone") {
                    if let code = mimo.pairCode {
                        HStack(alignment: .top, spacing: 14) {
                            if let qr = mimo.qrImage(mimo.remoteAppURL) {
                                Image(nsImage: qr).interpolation(.none).resizable().frame(width: 120, height: 120)
                                    .background(Color.white).cornerRadius(8)
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Scan with your phone's camera").font(.callout.weight(.semibold))
                                Text("Or open mimo.techtree.lifestyle/app and enter:").font(.caption).foregroundStyle(.secondary)
                                Text(code).font(.system(size: 24, weight: .bold, design: .monospaced)).textSelection(.enabled)
                                if let exp = mimo.pairExpires { Text("Expires \(exp, style: .relative)").font(.caption2).foregroundStyle(.tertiary) }
                                Button("Cancel") { mimo.cancelPairing() }.controlSize(.small)
                            }
                        }
                    } else {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Control Mimo from your phone")
                                Text(mimo.pairedPhones == 0 ? "See your storage and approve cleaning from anywhere." :
                                        "\(mimo.pairedPhones) phone\(mimo.pairedPhones == 1 ? "" : "s") paired")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(mimo.pairedPhones == 0 ? "Pair a phone" : "Pair another") { mimo.startPairing() }.controlSize(.small)
                        }
                        if mimo.pairedPhones > 0 {
                            Button("Unpair all phones") { mimo.unpairAll() }.controlSize(.small)
                        }
                    }
                    if let err = mimo.remoteError { Text(err).font(.caption).foregroundStyle(.orange) }
                    Text("Paired phones see your storage totals, what I found by category and my activity. File names never leave your Mac.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }

                section("Privacy") {
                    Toggle(isOn: $mimo.countInstall) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Share anonymous counts")
                            Text("Counts this install once, and how much space each clean clears by category. Never file names, folder names or anything you made.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.toggleStyle(.checkbox)
                }

                section("Notifications") {
                    HStack {
                        Text("Check in with me every")
                        Spacer()
                        Picker("", selection: $mimo.reportMinutes) {
                            Text("15 min").tag(15); Text("30 min").tag(30); Text("1 hour").tag(60); Text("3 hours").tag(180)
                        }.labelsHidden().fixedSize()
                    }
                    HStack {
                        Button("Send a test notification") { mimo.report() }.controlSize(.small)
                        Spacer()
                        Text("Next in \(mimo.nextReportText)").font(.caption2).foregroundStyle(.tertiary)
                    }
                    if !mimo.notificationsAllowed {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            Text("Notifications are off for Mimo").font(.caption)
                            Spacer()
                            Button("Turn on") { mimo.openNotificationSettings() }.controlSize(.small)
                        }
                    }
                }
            }
            .padding(.trailing, 6)
        }
    }

    func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 10) { content() }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.07)))
        }
    }
}
