import Foundation
import Combine

/// Receives AQR1 frames as they stream in from the scanner, dedupes them by
/// chunk index, verifies per-chunk and whole-file integrity, and rebuilds the
/// original file. This is a direct port of handleQrDecoded() + rebuildTransfer()
/// from the web app (app.debug4.js), expressed as observable state for SwiftUI.
@MainActor
final class TransferReceiver: ObservableObject {

    // Published UI state
    @Published var total = 0
    @Published var receivedCount = 0
    @Published var fileName = ""
    @Published var statusText = "Waiting for frames…"
    @Published var isComplete = false
    @Published var rebuiltURL: URL?            // drives the share sheet
    @Published var missingIndices: [Int] = []
    @Published var rebuiltText: String?        // populated for text payloads

    // Internal transfer state
    private var activeId: String?
    private var fileHash = ""
    private var alg = "raw"
    private var mime = ""
    private var name = ""
    private var received: [Int: String] = [:]  // index -> base64url chunk
    private var lastDecoded = ""

    /// Feed a raw decoded QR string. Safe to call many times per second with
    /// repeats — duplicates are cheaply ignored.
    func ingest(_ text: String) {
        guard text != lastDecoded else { return }
        lastDecoded = text

        guard let f = FrameParser.parse(text) else { return }

        // A new transfer id means a fresh file — reset and adopt its metadata.
        if activeId != f.id {
            reset()
            activeId = f.id
            total = f.total
            name = f.name
            fileName = f.name
            mime = f.mime
            alg = f.alg
            fileHash = f.fileHash
            statusText = "Receiving \(f.name)…"
        }

        guard f.id == activeId else { return }
        guard received[f.index] == nil else { return }   // already have this chunk

        // Per-chunk integrity: first 16 hex chars of SHA-256, same as the web app.
        let computed = String(FrameParser.sha256Hex(f.data).prefix(16))
        guard computed == f.chunkHash else { return }     // garbled scan, drop it

        received[f.index] = f.data
        receivedCount = received.count
        recomputeMissing()
        Haptics.tick()

        if received.count == total {
            rebuild()
        }
    }

    private func recomputeMissing() {
        guard total > 0 else { missingIndices = []; return }
        missingIndices = (0..<total).filter { received[$0] == nil }
    }

    private func rebuild() {
        // Reassemble in index order, then base64url-decode the whole payload.
        let joined = (0..<total).compactMap { received[$0] }.joined()
        guard let rawDecoded = FrameParser.base64urlDecode(joined) else {
            statusText = "Decode error. Reset and rescan."
            Haptics.failure()
            return
        }

        let bytes: Data
        if alg == "gzip" {
            do {
                bytes = try Gzip.gunzip(rawDecoded)
            } catch {
                statusText = "Gunzip failed: \(error). Reset and rescan."
                Haptics.failure()
                return
            }
        } else {
            bytes = rawDecoded
        }

        // Whole-file integrity check.
        guard FrameParser.sha256Hex(bytes) == fileHash else {
            statusText = "Checksum failed. Keep scanning or reset."
            Haptics.failure()
            return
        }

        // Write to a temp file so the share sheet can hand it off anywhere.
        let safeName = fileName.isEmpty ? "transfer.bin" : fileName
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        do {
            try bytes.write(to: url, options: .atomic)
            rebuiltURL = url
        } catch {
            statusText = "Rebuilt OK but couldn't write file: \(error)"
            Haptics.failure()
            return
        }

        // Surface text payloads inline for quick copy.
        if mime.hasPrefix("text/") || isTextyExtension(safeName) {
            rebuiltText = String(data: bytes, encoding: .utf8)
        }

        isComplete = true
        statusText = "Complete — \(safeName)"
        Haptics.success()
    }

    private func isTextyExtension(_ name: String) -> Bool {
        let exts = ["ts", "tsx", "js", "jsx", "json", "xml", "html", "css",
                    "txt", "md", "log", "yaml", "yml"]
        let lower = name.lowercased()
        return exts.contains { lower.hasSuffix(".\($0)") }
    }

    func reset() {
        received.removeAll()
        receivedCount = 0
        total = 0
        activeId = nil
        fileHash = ""
        alg = "raw"
        mime = ""
        name = ""
        fileName = ""
        lastDecoded = ""
        missingIndices = []
        rebuiltURL = nil
        rebuiltText = nil
        isComplete = false
        statusText = "Waiting for frames…"
    }
}
