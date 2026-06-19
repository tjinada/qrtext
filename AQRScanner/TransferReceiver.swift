import Foundation
import Combine

// MARK: - Value snapshots passed engine (background) -> receiver (main)

/// Progress snapshot produced on the background queue and applied to @Published
/// state on main. Plain value type so it crosses threads safely.
struct SectionProgress {
    var secs: Int
    var fileName: String
    var statusText: String
    var done: Set<Int>             // banked (verified, persisted) section indices
    var inProgress: [Int: Double]  // sec -> fraction of blocks resolved (0...1)
    var allReady: Bool             // every section banked
    var contributed: Bool          // this frame advanced a section
}

/// Result of a recombine attempt, produced on the engine queue.
struct LTResult {
    var fileURL: URL?
    var text: String?
    var statusText: String
    var success: Bool
}

// MARK: - SectionReceiver (background-confined, multi-section)

/// Holds one in-flight section LT decoder per section plus the on-disk store of
/// completed sections. NOT main-actor; TransferReceiver confines every call to a
/// single serial queue so LT propagation never runs on the main thread.
final class SectionReceiver {

    private let store = SectionStore()

    private var activeId: String?
    private var secs = 0
    private var name = ""
    private var mime = ""
    private var alg = "raw"
    private var fileHash = ""
    private var decoders: [Int: LTDecoder] = [:]   // in-progress sections
    private var done: Set<Int> = []                // banked sections (also on disk)
    private var lastDecoded = ""

    // MARK: ingest

    func ingest(_ text: String) -> SectionProgress? {
        guard text != lastDecoded else { return nil }
        lastDecoded = text
        guard let f = FrameParser.parse(text) else { return nil }

        if activeId != f.id { adopt(f) }
        guard f.id == activeId else { return nil }

        // Already banked (this run or a previous session) — ignore, but report.
        if done.contains(f.sec) { return snapshot(contributed: false) }

        guard let xor = FrameParser.base64urlDecode(f.xorB64) else { return nil }

        var decoder = decoders[f.sec]
        if decoder == nil {
            decoder = LTDecoder(K: f.K, blockSize: xor.count, totalBytes: f.secBytes)
            decoders[f.sec] = decoder
        }
        guard let dec = decoders[f.sec] else { return nil }
        guard xor.count == dec.blockSize else { return nil }

        let contributed = dec.addEquation(seed: f.seed, xorPayload: xor)

        if dec.isComplete, let secBytes = dec.rebuild() {
            let gotHash = String(FrameParser.sha256Hex(secBytes).prefix(16))
            if gotHash == f.secHash {
                store.saveSection(id: f.id, sec: f.sec, bytes: secBytes)
                done.insert(f.sec)
            }
            decoders[f.sec] = nil   // free either way; rescan to retry on hash mismatch
        }

        return snapshot(contributed: contributed)
    }

    private func adopt(_ f: AQR3Frame) {
        activeId = f.id
        secs = f.secs
        name = f.name
        mime = f.mime
        alg = f.alg
        fileHash = f.fileHash
        decoders = [:]
        // Resume: pick up any sections banked for this id in a previous session.
        done = store.completedSections(id: f.id, secs: f.secs)
        store.saveMeta(SectionStore.Meta(id: f.id, name: f.name, mime: f.mime,
                                         alg: f.alg, fileHash: f.fileHash, secs: f.secs))
    }

    private func snapshot(contributed: Bool) -> SectionProgress {
        var prog: [Int: Double] = [:]
        for (sec, dec) in decoders {
            prog[sec] = dec.K > 0 ? Double(dec.resolvedCount) / Double(dec.K) : 0
        }
        let allReady = secs > 0 && done.count == secs
        let status = allReady
            ? "All \(secs) section(s) captured — tap Recombine."
            : "Receiving \(name)…  \(done.count)/\(secs) sections banked"
        return SectionProgress(secs: secs, fileName: name, statusText: status,
                               done: done, inProgress: prog, allReady: allReady,
                               contributed: contributed)
    }

    // MARK: recombine

    func recombine(progress: (Double) -> Void) -> LTResult {
        guard let id = activeId, secs > 0 else {
            return LTResult(fileURL: nil, text: nil, statusText: "Nothing to recombine.", success: false)
        }
        guard done.count == secs else {
            return LTResult(fileURL: nil, text: nil,
                            statusText: "Missing sections (\(done.count)/\(secs)).", success: false)
        }

        var processed = Data()
        for s in 0..<secs {
            guard let part = store.loadSection(id: id, sec: s) else {
                return LTResult(fileURL: nil, text: nil,
                                statusText: "Section \(s + 1) missing on disk.", success: false)
            }
            processed.append(part)
            progress(0.6 * Double(s + 1) / Double(secs))      // 0 -> 0.6 reading sections
        }

        var bytes = processed
        if alg == "gzip" {
            progress(0.65)
            do { bytes = try Gzip.gunzip(processed) }
            catch {
                return LTResult(fileURL: nil, text: nil,
                                statusText: "Gunzip failed: \(error).", success: false)
            }
        }
        progress(0.85)

        guard FrameParser.sha256Hex(bytes) == fileHash else {
            return LTResult(fileURL: nil, text: nil,
                            statusText: "Whole-file checksum failed.", success: false)
        }
        progress(0.95)

        let safeName = name.isEmpty ? "transfer.bin" : name
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        do { try bytes.write(to: url, options: .atomic) }
        catch {
            return LTResult(fileURL: nil, text: nil,
                            statusText: "Couldn't write file: \(error)", success: false)
        }

        // Build only a CAPPED preview for inline display. SwiftUI's Text view
        // chokes on multi-megabyte strings and freezes the main thread, so we
        // never hand it the whole file — the full content is on disk (url) and
        // goes out through the share sheet. This is what made a 2 MB JSON appear
        // to "stick at 95%": recombine had finished, but rendering the full
        // string as Text wedged the UI.
        var text: String? = nil
        if mime.hasPrefix("text/") || SectionReceiver.isTextyExtension(safeName) {
            let previewCap = 8000
            if bytes.count <= previewCap {
                text = String(decoding: bytes, as: UTF8.self)
            } else {
                let head = bytes.prefix(previewCap)
                text = String(decoding: head, as: UTF8.self)
                    + "\n\n… (truncated preview — use Save / Share for the full \(bytes.count) bytes)"
            }
        }
        store.clear(id: id)   // banked sections no longer needed once recombined
        progress(1.0)
        return LTResult(fileURL: url, text: text, statusText: "Complete — \(safeName)", success: true)
    }

    func reset(clearDisk: Bool) {
        if clearDisk, let id = activeId { store.clear(id: id) }
        activeId = nil
        secs = 0
        name = ""
        mime = ""
        alg = "raw"
        fileHash = ""
        decoders = [:]
        done = []
        lastDecoded = ""
    }

    static func isTextyExtension(_ name: String) -> Bool {
        let exts = ["ts", "tsx", "js", "jsx", "json", "xml", "html", "css",
                    "txt", "md", "log", "yaml", "yml"]
        let lower = name.lowercased()
        return exts.contains { lower.hasSuffix(".\($0)") }
    }
}

// MARK: - TransferReceiver (main-thread observable wrapper)

/// SwiftUI-facing receiver. A plain ObservableObject (not @MainActor) so the
/// off-main GCD plumbing compiles cleanly. `ingest` is called from the VisionKit
/// scanner delegate and returns immediately; the engine decodes on `queue` and
/// publishes progress back on main. `recombine()` is user-triggered.
final class TransferReceiver: ObservableObject {

    @Published var secs = 0
    @Published var fileName = ""
    @Published var statusText = "Waiting for frames…"
    @Published var doneSections: Set<Int> = []
    @Published var inProgress: [Int: Double] = [:]
    @Published var allReady = false
    @Published var isComplete = false
    @Published var isRecombining = false
    @Published var recombineProgress: Double = 0
    @Published var rebuiltURL: URL?
    @Published var rebuiltText: String?

    private let engine = SectionReceiver()
    private let queue = DispatchQueue(label: "aqr.section.engine", qos: .userInitiated)

    // Gate for the ingest flood. Once every section is banked (or a recombine is
    // requested) we stop accepting frames, so already-queued ingest blocks bail
    // at the top instead of piling up ahead of the recombine block. Without this,
    // the camera keeps firing frames onto the same serial queue and recombine
    // can wait minutes behind the backlog.
    private let gate = NSLock()
    private var accepting = true

    private func setAccepting(_ v: Bool) {
        gate.lock(); accepting = v; gate.unlock()
    }
    private func isAccepting() -> Bool {
        gate.lock(); defer { gate.unlock() }; return accepting
    }

    func ingest(_ text: String) {
        guard isAccepting() else { return }                 // don't even queue once captured
        queue.async { [weak self] in
            guard let self = self else { return }
            guard self.isAccepting() else { return }        // drain any backlog cheaply
            guard let p = self.engine.ingest(text) else { return }
            DispatchQueue.main.async { self.apply(p) }
        }
    }

    func recombine() {
        guard !isRecombining else { return }
        setAccepting(false)            // stop the flood so this runs immediately
        isRecombining = true
        recombineProgress = 0
        statusText = "Recombining…"
        queue.async { [weak self] in
            guard let self = self else { return }
            let r = self.engine.recombine(progress: { frac in
                DispatchQueue.main.async { self.recombineProgress = frac }
            })
            DispatchQueue.main.async { self.applyResult(r) }
        }
    }

    func reset() {
        setAccepting(true)
        queue.async { [weak self] in self?.engine.reset(clearDisk: false) }
        secs = 0
        fileName = ""
        statusText = "Waiting for frames…"
        doneSections = []
        inProgress = [:]
        allReady = false
        isComplete = false
        isRecombining = false
        recombineProgress = 0
        rebuiltURL = nil
        rebuiltText = nil
    }

    // MARK: - main-thread state application

    private func apply(_ p: SectionProgress) {
        secs = p.secs
        fileName = p.fileName
        doneSections = p.done
        inProgress = p.inProgress
        if p.allReady && !allReady {
            setAccepting(false)        // capture complete — stop the camera flood
        }
        allReady = p.allReady
        if !isComplete && !isRecombining { statusText = p.statusText }
        if p.contributed { Haptics.tick() }
    }

    private func applyResult(_ r: LTResult) {
        isRecombining = false
        recombineProgress = r.success ? 1.0 : 0.0
        statusText = r.statusText
        if r.success {
            rebuiltURL = r.fileURL
            rebuiltText = r.text
            isComplete = true
            Haptics.success()
        } else {
            Haptics.failure()
        }
    }
}
