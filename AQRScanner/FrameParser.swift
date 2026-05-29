import Foundation
import CryptoKit

/// One decoded AQR2 frame. Mirrors the object returned by parseFrame() in the
/// web app (app.debug4.js, debug9).
///
/// Wire format:
///   AQR2|id|seed|K|totalBytes|alg|fileHash|nameB64|mimeB64|xorPayloadB64
///
/// name/mime/xorPayload are base64url so they can never contain the "|"
/// delimiter. seed/K/totalBytes are decimal integers.
struct AQR2Frame {
    let id: String
    let seed: UInt32
    let K: Int
    let totalBytes: Int
    let alg: String        // "gzip" | "raw"
    let fileHash: String   // full-file SHA-256 (hex)
    let name: String
    let mime: String
    let xorB64: String     // base64url-encoded XOR payload
}

/// Pure functions that mirror the encode/decode helpers in the web app so the
/// two stay byte-compatible.
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
    /// AQR2 frame (random QR codes, malformed payloads, non-numeric seed/K).
    static func parse(_ text: String) -> AQR2Frame? {
        guard text.hasPrefix("AQR2|") else { return nil }
        let parts = text.components(separatedBy: "|")
        guard parts.count == 10 else { return nil }
        // parts[0] == "AQR2"
        let id = parts[1]
        guard let seed = UInt32(parts[2]), seed > 0 else { return nil }
        guard let K = Int(parts[3]), K >= 2 else { return nil }
        guard let totalBytes = Int(parts[4]), totalBytes > 0 else { return nil }

        return AQR2Frame(
            id: id,
            seed: seed,
            K: K,
            totalBytes: totalBytes,
            alg: parts[5],
            fileHash: parts[6],
            name: decodeString(parts[7]),
            mime: decodeString(parts[8]),
            xorB64: parts[9]
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
