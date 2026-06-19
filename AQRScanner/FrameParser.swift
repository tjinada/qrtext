import Foundation
import CryptoKit

/// One decoded AQR3 frame. Mirrors parseFrame() in client/app.js (debug12).
///
/// Wire format:
///   AQR3|id|sec|secs|seed|K|secBytes|secHash|alg|fileHash|nameB64|mimeB64|xorPayloadB64
///
/// A file is gzipped, then split into `secs` contiguous sections; each section
/// is its own independent LT stream. `sec`/`secs` route the frame; `seed`/`K`/
/// `secBytes` are this section's LT params; `secHash` verifies the section the
/// moment its decode completes; `fileHash`/`name`/`mime`/`alg` are whole-file.
/// name/mime/xorPayload are base64url so they never contain the "|" delimiter.
struct AQR3Frame {
    let id: String
    let sec: Int
    let secs: Int
    let seed: UInt32
    let K: Int
    let secBytes: Int
    let secHash: String
    let alg: String        // "gzip" | "raw"
    let fileHash: String   // whole-file SHA-256 (hex)
    let name: String
    let mime: String
    let xorB64: String     // base64url-encoded XOR payload
}

/// Pure functions that mirror the encode/decode helpers in the web app so the
/// two stay byte-compatible.
enum FrameParser {

    // MARK: base64url

    static func base64urlDecode(_ s: String) -> Data? {
        var str = s
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = str.count % 4
        if remainder > 0 {
            str += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: str)
    }

    static func decodeString(_ s: String) -> String {
        guard let d = base64urlDecode(s) else { return "" }
        return String(data: d, encoding: .utf8) ?? ""
    }

    // MARK: parsing

    /// Returns nil for anything that isn't a well-formed AQR3 frame.
    static func parse(_ text: String) -> AQR3Frame? {
        guard text.hasPrefix("AQR3|") else { return nil }
        let parts = text.components(separatedBy: "|")
        guard parts.count == 13 else { return nil }

        let id = parts[1]
        guard let sec = Int(parts[2]),
              let secs = Int(parts[3]),
              let seed = UInt32(parts[4]),
              let K = Int(parts[5]),
              let secBytes = Int(parts[6]) else { return nil }
        guard secs > 0, sec >= 0, sec < secs, seed > 0, K >= 2, secBytes > 0 else { return nil }

        return AQR3Frame(
            id: id,
            sec: sec,
            secs: secs,
            seed: seed,
            K: K,
            secBytes: secBytes,
            secHash: parts[7],
            alg: parts[8],
            fileHash: parts[9],
            name: decodeString(parts[10]),
            mime: decodeString(parts[11]),
            xorB64: parts[12]
        )
    }

    // MARK: hashing (CryptoKit == crypto.subtle.digest)

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func sha256Hex(_ s: String) -> String {
        sha256Hex(Data(s.utf8))
    }
}
