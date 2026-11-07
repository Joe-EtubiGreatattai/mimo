import SwiftUI
import ServiceManagement
import UserNotifications

@main
struct MimoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @ObservedObject private var mimo = Mimo.shared
    var body: some Scene {
        MenuBarExtra {
            MimoPanel().environmentObject(mimo)
        } label: {
            Image(nsImage: Mimo.menuIcon)
            Text(mimo.isCleaning ? "cleaning…" : "\(mimo.freeGB)GB")
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    static weak var current: AppDelegate?
    var window: NSWindow?
    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.current = self
        _ = Mimo.shared
        showWindow()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow(); return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func showWindow() {
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
        DispatchQueue.main.async { AppDelegate.current?.showWindow() }
        done()
    }
}

// MARK: - Model

struct Activity: Identifiable { let id = UUID(); let time: Date; let icon: String; let text: String }
struct Target: Identifiable { let id = UUID(); let name: String; let icon: String; let path: String; var bytes: Int64? }

final class Mimo: ObservableObject {
    static let shared = Mimo()
    @Published var freeGB = 0
    @Published var totalGB = 0
    @Published var isCleaning = false
    @Published var cleaningStep = ""
    @Published var lastCheck = Date()
    @Published var lastFreed: Int?
    @Published var totalFreed = 0
    @Published var activity: [Activity] = []
    @Published var targets: [Target] = [
        Target(name: "App caches", icon: "shippingbox.fill", path: "Library/Caches"),
        Target(name: "Old WhatsApp media", icon: "message.fill", path: "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media"),
        Target(name: "Xcode build data", icon: "hammer.fill", path: "Library/Developer/Xcode/DerivedData"),
        Target(name: "Gradle caches", icon: "cube.box.fill", path: ".gradle/caches"),
        Target(name: "npm cache", icon: "shippingbox", path: ".npm/_cacache"),
    ]
    @Published var scanning = false

    let limitGB = 15, warnGB = 25
    @Published var reportMinutes: Int = (UserDefaults.standard.object(forKey: "reportMinutes") as? Int) ?? 30 {
        didSet { UserDefaults.standard.set(reportMinutes, forKey: "reportMinutes") }
    }
    var reportEvery: TimeInterval { TimeInterval(reportMinutes * 60) }
    @Published var notificationsAllowed = true
    let home = FileManager.default.homeDirectoryForCurrentUser
    var logURL: URL { home.appendingPathComponent("Library/Logs/mimo.log") }
    private var timer: Timer?
    @Published var lastReport = Date()
    private var warned = false
    private var useNative = false

    static let menuIcon: NSImage = {
        let img = Bundle.main.url(forResource: "menu", withExtension: "svg").flatMap { NSImage(contentsOf: $0) } ?? NSImage(systemSymbolName: "pawprint.fill", accessibilityDescription: nil)!
        img.size = NSSize(width: 18, height: 18); img.isTemplate = true
        return img
    }()
    static let faceIcon: NSImage = Bundle.main.url(forResource: "mimo", withExtension: "png").flatMap { NSImage(contentsOf: $0) } ?? NSApp.applicationIconImage

    init() {
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
        check()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.check() }
    }

    var usedFraction: Double { totalGB == 0 ? 0 : Double(totalGB - freeGB) / Double(totalGB) }
    var mood: (text: String, color: Color, emoji: String) {
        if isCleaning { return ("Cleaning up for you", .blue, "🧹") }
        if freeGB < limitGB { return ("Running low", .red, "😟") }
        if freeGB < warnGB { return ("Getting tight", .orange, "👀") }
        return ("All good", .green, "😊")
    }

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
        activity.insert(Activity(time: Date(), icon: icon, text: text), at: 0)
        if activity.count > 30 { activity.removeLast() }
        log(text)
    }

    func check(manual: Bool = false) {
        readDisk(); lastCheck = Date()
        if manual { add("magnifyingglass", "Checked: \(freeGB) GB free") }
        if freeGB < limitGB && !isCleaning { clean(manual: false); return }
        if freeGB < warnGB && !warned {
            warned = true
            add("exclamationmark.triangle.fill", "Space getting tight: \(freeGB) GB")
            notify("Heads up: only \(freeGB) GB left. I'll start cleaning at \(limitGB) GB.")
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
        if f < limitGB { return "Ruff… only \(f) GB left 😟 I'm on it!" }
        if f < warnGB {
            return ["Sniff sniff 👀 \(f) GB free — getting a bit tight, I'm watching closely.",
                    "Heads up, friend: \(f) GB left. I'll clean at \(limitGB) GB 🧹",
                    "Ears up 🐕 \(f) GB free. Not panicking yet, but I'm close by."].randomElement()!
        }
        return ["Woof! 🐶 Still on patrol — \(f) GB free. All good!",
                "Tail wagging 🐕 You've got \(f) GB free. Nothing to clean.",
                "Mimo checking in 🐾 \(f) GB free and looking healthy.",
                "Good news from your storage dog: \(f) GB free ✅",
                "Just did my rounds 🦴 \(f) GB free. Carry on!",
                "Sniffed every corner 👃 \(f) GB free — all clear."].randomElement()!
    }

    func scan() {
        guard !scanning else { return }
        scanning = true
        let snapshot = targets
        DispatchQueue.global(qos: .utility).async {
            var out = snapshot
            for i in out.indices {
                let isWA = out[i].path.contains("WhatsApp")
                out[i].bytes = self.size(of: self.home.appendingPathComponent(out[i].path), olderThanDays: isWA ? 30 : nil)
            }
            DispatchQueue.main.async { self.targets = out; self.scanning = false }
        }
    }

    private func size(of url: URL, olderThanDays days: Double?) -> Int64 {
        let cutoff = days.map { Date().addingTimeInterval(-$0 * 86_400) }
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .contentModificationDateKey, .isRegularFileKey]) else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e {
            guard let r = try? f.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .contentModificationDateKey, .isRegularFileKey]), r.isRegularFile == true else { continue }
            if let c = cutoff, let d = r.contentModificationDate, d >= c { continue }
            total += Int64(r.totalFileAllocatedSize ?? 0)
        }
        return total
    }

    func clean(manual: Bool) {
        guard !isCleaning else { return }
        isCleaning = true
        let before = freeGB
        add("sparkles", manual ? "You asked me to clean up" : "Low on space (\(before) GB) — started cleaning")
        notify(manual ? "On it! Cleaning up now… 🧹" : "Only \(before) GB left — fetching the broom 🧹")
        let list = targets
        DispatchQueue.global(qos: .utility).async {
            for t in list {
                DispatchQueue.main.async { self.cleaningStep = "Clearing \(t.name.lowercased())…" }
                if t.path.contains("WhatsApp") { self.trashOldFiles(in: t.path, olderThanDays: 30) }
                else { self.emptyFolder(t.path) }
            }
            DispatchQueue.main.async {
                self.readDisk()
                let freed = max(self.freeGB - before, 0)
                self.lastFreed = freed; self.totalFreed += freed
                self.isCleaning = false; self.cleaningStep = ""
                self.lastReport = Date()
                self.add("checkmark.seal.fill", "Cleaned up — freed \(freed) GB")
                self.notify("Good boy report 🐾 Freed \(freed) GB — you now have \(self.freeGB) GB free.")
                self.scan()
            }
        }
    }

    private func emptyFolder(_ rel: String) {
        let url = home.appendingPathComponent(rel)
        let items = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
        for item in items where !item.lastPathComponent.lowercased().contains("mimo") { try? FileManager.default.removeItem(at: item) }
    }

    private func trashOldFiles(in rel: String, olderThanDays days: Double) {
        let url = home.appendingPathComponent(rel)
        let cutoff = Date().addingTimeInterval(-days * 86_400)
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey]) else { return }
        for case let f as URL in e {
            let r = try? f.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
            if r?.isRegularFile == true, let d = r?.contentModificationDate, d < cutoff { try? FileManager.default.trashItem(at: f, resultingItemURL: nil) }
        }
    }

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

    func notify(_ msg: String) {
        if useNative {
            let c = UNMutableNotificationContent(); c.title = "Mimo 🐶"; c.body = msg; c.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        } else {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = ["-e", "display notification \"\(msg.replacingOccurrences(of: "\"", with: "'"))\" with title \"Mimo 🐶\" sound name \"Glass\""]
            try? p.run()
        }
    }

    private func log(_ line: String) {
        let text = "\(Date()): \(line)\n"
        if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(text.data(using: .utf8)!); h.closeFile() }
        else { try? text.write(to: logURL, atomically: true, encoding: .utf8) }
    }
}

// MARK: - UI

struct MimoPanel: View {
    @EnvironmentObject var mimo: Mimo
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            gauge
            if mimo.isCleaning { cleaningBanner }
            cleanables
            activityFeed
            notifyCard
            footer
        }
        .padding(16)
        .frame(width: 340)
        .onAppear { mimo.readDisk(); mimo.scan() }
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
            }.frame(width: 92, height: 92)
            VStack(alignment: .leading, spacing: 6) {
                stat("internaldrive", "\(mimo.totalGB - mimo.freeGB) of \(mimo.totalGB) GB used")
                stat("trash.circle", "Cleans below \(mimo.limitGB) GB")
                stat("arrow.down.circle", mimo.lastFreed.map { "Last clean freed \($0) GB" } ?? "No cleans yet")
                stat("star.fill", "\(mimo.totalFreed) GB freed this session")
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.secondary.opacity(0.08)))
    }

    func stat(_ icon: String, _ text: String) -> some View {
        Label { Text(text).font(.caption) } icon: { Image(systemName: icon).foregroundStyle(.secondary).frame(width: 14) }
    }

    var cleaningBanner: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(mimo.cleaningStep.isEmpty ? "Cleaning…" : mimo.cleaningStep).font(.callout)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.blue.opacity(0.12)))
    }

    var cleanables: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("What I can clean").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if mimo.scanning { ProgressView().controlSize(.mini) }
            }
            ForEach(mimo.targets) { t in
                HStack {
                    Image(systemName: t.icon).foregroundStyle(.blue).frame(width: 18)
                    Text(t.name).font(.callout)
                    Spacer()
                    Text(t.bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "—")
                        .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
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
            }.frame(height: 110)
        }
    }

    var notifyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "bell.badge.fill").foregroundStyle(.blue)
                Text("Check in with me every").font(.callout)
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
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
        .onAppear { mimo.refreshPermission() }
    }

    var footer: some View {
        HStack {
            Button { mimo.clean(manual: true) } label: { Label("Clean now", systemImage: "sparkles") }
                .buttonStyle(.borderedProminent).disabled(mimo.isCleaning)
            Button { mimo.check(manual: true); mimo.report() } label: { Label("Check", systemImage: "arrow.clockwise") }
            Spacer()
            Menu {
                Button("Open Mimo window") { AppDelegate.current?.showWindow() }
                Button("Open log") { NSWorkspace.shared.open(mimo.logURL) }
                Button("Quit Mimo") { NSApp.terminate(nil) }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).fixedSize()
        }
    }
}
