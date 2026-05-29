import Foundation
import Combine

/// Receives AQR2 frames as they stream in from the scanner, feeds them to the
/// LT decoder, and once enough have been collected, reconstructs and verifies
/// the original file.
///
/// This is the AQR2/fountain-codes port of handleQrDecoded() + rebuildTransfer()
/// from the web app (app.debug4.js, debug9), expressed as observable state for
/// SwiftUI.
@MainActor
final class TransferReceiver: ObservableObject {

    // Published UI state
    @Published var K = 0
    @Published var resolvedCount = 0
    @Published var framesSeen = 0
    @Published var pendingEquations = 0
    @Published var fileName = ""
    @Published var statusText = "Waiting for frames…"
    @Published var isComplete = false
    @Published var rebuiltURL: URL?            // drives the share sheet
    @Published var rebuiltText: String?        // populated for text payloads

    // Internal transfer state
    private var activeId: String?
    private var fileHash = ""
    private var alg = "raw"
    private var mime = ""
    private var name = ""
    private var decoder: LTDecoder?
    private var lastDecoded = ""

    /// Feed a raw decoded QR string. Safe to call many times per second with
    /// repeats — duplicates are cheaply ignored.
    func ingest(_ text: String) {
        // Cheap dedupe: VisionKit's didUpdate fires every frame the same payload
        // is visible, so the same frame text comes in repeatedly. Skipping here
        // saves us from running the LT-reduction loop on identical equations.
        guard text != lastDecoded else { return }
        lastDecoded = text

        guard let frame = FrameParser.parse(text) else { return }

        // A new transfer id means a fresh file — reset and adopt its metadata.
        if activeId != frame.id {
            reset()
            activeId = frame.id
            K = frame.K
            name = frame.name
            fileName = frame.name
            mime = frame.mime
            alg = frame.alg
            fileHash = frame.fileHash

            // Block size has to be inferred from the first frame's xor payload
            // (the encoder doesn't include it explicitly — it's deterministic
            // given the payload bytes and K, but reconstructing that calculation
            // on the receiver is more brittle than just looking at the bytes
            // we've actually received).
            guard let firstXor = FrameParser.base64urlDecode(frame.xorB64) else {
                statusText = "First frame's payload was not valid base64url."
                Haptics.failure()
                return
            }
            decoder = LTDecoder(
                K: frame.K,
                blockSize: firstXor.count,
                totalBytes: frame.totalBytes
            )
            statusText = "Receiving \(frame.name)…"
        }

        guard frame.id == activeId, let decoder = decoder else { return }

        guard let xor = FrameParser.base64urlDecode(frame.xorB64) else {
            // One garbled frame is normal — just drop it; the LT decoder will
            // converge from other frames.
            return
        }

        // Sanity: payload length should match the established block size. If
        // it doesn't, something is very wrong (frame from a different transfer
        // with a recycled id, or wire corruption that snuck past the QR ECC).
        guard xor.count == decoder.blockSize else { return }

        let contributed = decoder.addEquation(seed: frame.seed, xorPayload: xor)
        framesSeen = decoder.equationsSeen
        resolvedCount = decoder.resolvedCount
        pendingEquations = decoder.pendingCount

        if contributed {
            Haptics.tick()
        }

        if decoder.isComplete {
            rebuild()
        }
    }

    private func rebuild() {
        guard let decoder = decoder, decoder.isComplete else { return }
        guard var bytes = decoder.rebuild() else {
            statusText = "Decoder reported complete but rebuild returned nil."
            Haptics.failure()
            return
        }

        if alg == "gzip" {
            do {
                bytes = try Gzip.gunzip(bytes)
            } catch {
                statusText = "Gunzip failed: \(error). Reset and rescan."
                Haptics.failure()
                return
            }
        }

        // Whole-file integrity check.
        guard FrameParser.sha256Hex(bytes) == fileHash else {
            statusText = "Checksum failed. Reset and rescan."
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
        decoder = nil
        K = 0
        resolvedCount = 0
        framesSeen = 0
        pendingEquations = 0
        activeId = nil
        fileHash = ""
        alg = "raw"
        mime = ""
        name = ""
        fileName = ""
        lastDecoded = ""
        rebuiltURL = nil
        rebuiltText = nil
        isComplete = false
        statusText = "Waiting for frames…"
    }
}
