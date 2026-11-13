import SwiftUI
import UIKit

// Everything is appended to Documents/*.jsonl as it happens, so a USB disconnect or an
// out-of-memory kill still leaves the data on the device.
final class Runner: ObservableObject {
    @Published var status = "starting"
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let t0 = Date()

    func append(_ file: String, _ obj: [String: Any]) {
        var o = obj; o["t"] = Date().timeIntervalSince(t0)
        let line = (try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) + Data("\n".utf8)
        let url = docs.appendingPathComponent(file)
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line); try? h.synchronize(); try? h.close() }
        else { try! line.write(to: url) }
    }
    func log(_ s: String) { NSLog("MNBENCH %@", s); DispatchQueue.main.async { self.status = s } }

    func start() {
        UIApplication.shared.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        for f in ["events.jsonl", "thermal.jsonl", "ksweep.jsonl"] { try? FileManager.default.removeItem(at: docs.appendingPathComponent(f)) }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        timer.schedule(deadline: .now(), repeating: 1.0)
        timer.setEventHandler { [self] in
            append("thermal.jsonl", ["thermal": ProcessInfo.processInfo.thermalState.rawValue, "battery": UIDevice.current.batteryLevel,
                                     "battery_state": UIDevice.current.batteryState.rawValue, "low_power": ProcessInfo.processInfo.isLowPowerModeEnabled])
        }
        timer.resume()
        DispatchQueue.global(qos: .userInitiated).async { self.run(timer) }
    }

    func run(_ timer: DispatchSourceTimer) {
        let res = Bundle.main.resourceURL!
        let params = res.appendingPathComponent("params").path
        var s = utsname(); uname(&s)
        let model = withUnsafeBytes(of: &s.machine) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        append("events.jsonl", ["event": "start", "device": model, "os": UIDevice.current.systemVersion,
                                "cores": ProcessInfo.processInfo.processorCount, "ram_gb": Double(ProcessInfo.processInfo.physicalMemory) / 1e9])

        log("wallet circuits: 10 rounds, 6 threads")
        let p = mn_bench_run(params, 10, 6)!
        let json = String(cString: p); mn_bench_free(p)
        append("events.jsonl", ["event": "wallet", "result": (try? JSONSerialization.jsonObject(with: Data(json.utf8))) ?? json])
        log("wallet done")

        let ks = (10...20).map(String.init).joined(separator: ",")
        log("k sweep \(ks), 3 rounds, 6 threads, 60 s limit per proof")
        let out = docs.appendingPathComponent("ksweep.jsonl").path
        let done = mn_ksweep_run(params, res.appendingPathComponent("ksweep-keys").path, ks, 3, 6, out)
        append("events.jsonl", ["event": done == 1 ? "ksweep_complete" : "ksweep_timeout"])
        timer.cancel()
        append("events.jsonl", ["event": "end"])
        log("DONE")
        // A timed-out proof is still running on a background thread and can't be cancelled: exit to stop it.
        if done != 1 { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) } }
    }
}

@main
struct BenchApp: App {
    @StateObject var r = Runner()
    var body: some Scene {
        WindowGroup {
            Text(r.status).font(.system(.footnote, design: .monospaced)).padding().onAppear { r.start() }
        }
    }
}
