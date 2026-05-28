import Foundation
import CryptoKit

/// One decoded AQR1 frame. Mirrors the object returned by parseFrame() in the
/// web app (app.debug4.js).
struct AQRFrame {
    let id: String
    let index: Int
    let total: Int
    let alg: String        // "gzip" | "raw"
    let fileHash: String   // full-file SHA-256 (hex)
    let chunkHash: String  // first 16 hex chars of this chunk's SHA-256
    let name: String
    let mime: String
    let data: String       // base64url-encoded chunk payload
}

/// Pure functions that mirror the encode/decode helpers in the web app so the
/// two stay byte-compatible. The frame wire format is:
///
///   AQR1|id|index|total|alg|fileHash|chunkHash|nameB64|mimeB64|data
///
/// name/mime/data are base64url, so they can never contain the "|" delimiter.
enum FrameParser {

    // MARK: base64url

    /// Mirror of base64UrlDecode() in app.js.
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

    /// Mirror of decodeString() in app.js (base64url -> UTF-8 String).
    static func decodeString(_ s: String) -> String {
        guard let d = base64urlDecode(s) else { return "" }
        return String(data: d, encoding: .utf8) ?? ""
    }

    // MARK: parsing

    /// Mirror of parseFrame(). Returns nil for anything that isn't a well-formed
    /// AQR1 frame (random QR codes, malformed payloads, out-of-range indices).
    static func parse(_ text: String) -> AQRFrame? {
        guard text.hasPrefix("AQR1|") else { return nil }
        let parts = text.components(separatedBy: "|")
        guard parts.count == 10 else { return nil }
        guard let index = Int(parts[2]),
              let total = Int(parts[3]),
              index >= 0, index < total else { return nil }

        return AQRFrame(
            id: parts[1],
            index: index,
            total: total,
            alg: parts[4],
            fileHash: parts[5],
            chunkHash: parts[6],
            name: decodeString(parts[7]),
            mime: decodeString(parts[8]),
            data: parts[9]
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
