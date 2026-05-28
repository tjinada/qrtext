import Foundation
import Compression

/// Gzip decompression for payloads produced by pako.gzip() in the web app.
///
/// Why this file exists:
/// pako emits a standard gzip stream — a 10-byte header, a raw DEFLATE body,
/// and an 8-byte trailer (CRC32 + ISIZE). Apple's Compression framework does
/// NOT speak gzip directly; `COMPRESSION_ZLIB` decodes a *raw* DEFLATE stream.
/// So we parse and strip the gzip header (honoring the optional FEXTRA, FNAME,
/// FCOMMENT, FHCRC fields), drop the 8-byte trailer, and hand the raw DEFLATE
/// body to the streaming decoder.
///
/// If you don't want to deal with any of this, just untick "Compress with gzip"
/// in the web encoder. Raw mode skips this path entirely and the transfer still
/// works — gzip only saves QR frames, it isn't required for correctness.
enum Gzip {

    enum GzipError: Error {
        case tooShort
        case badMagic
        case headerOverrun
        case inflateFailed
    }

    /// Decompress a full gzip member. Returns the original bytes.
    static func gunzip(_ data: Data) throws -> Data {
        guard data.count >= 18 else { throw GzipError.tooShort }      // header(10)+trailer(8) minimum
        let bytes = [UInt8](data)

        // --- gzip header ---
        guard bytes[0] == 0x1f, bytes[1] == 0x8b else { throw GzipError.badMagic }
        // bytes[2] == 0x08 (DEFLATE). We don't enforce it; pako always uses 8.
        let flags = bytes[3]
        var offset = 10  // fixed header length

        // FEXTRA: 2-byte length prefix + payload
        if flags & 0x04 != 0 {
            guard offset + 2 <= bytes.count else { throw GzipError.headerOverrun }
            let xlen = Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
            offset += 2 + xlen
        }
        // FNAME: NUL-terminated string
        if flags & 0x08 != 0 {
            offset = try skipNulTerminated(bytes, from: offset)
        }
        // FCOMMENT: NUL-terminated string
        if flags & 0x10 != 0 {
            offset = try skipNulTerminated(bytes, from: offset)
        }
        // FHCRC: 2-byte header CRC
        if flags & 0x02 != 0 {
            offset += 2
        }

        guard offset < bytes.count - 8 else { throw GzipError.headerOverrun }

        // --- raw DEFLATE body (everything between header and 8-byte trailer) ---
        let bodyRange = offset ..< (bytes.count - 8)
        let body = data.subdata(in: bodyRange)

        // ISIZE (last 4 bytes, little-endian) = uncompressed size mod 2^32.
        // We use it to size the output buffer; fall back to a growth loop if 0.
        let isize = Int(bytes[bytes.count - 4])
            | (Int(bytes[bytes.count - 3]) << 8)
            | (Int(bytes[bytes.count - 2]) << 16)
            | (Int(bytes[bytes.count - 1]) << 24)

        return try inflateRaw(body, hintSize: isize)
    }

    private static func skipNulTerminated(_ bytes: [UInt8], from start: Int) throws -> Int {
        var i = start
        while i < bytes.count, bytes[i] != 0 { i += 1 }
        guard i < bytes.count else { throw GzipError.headerOverrun }
        return i + 1  // skip the NUL itself
    }

    /// Inflate a raw DEFLATE stream using the streaming Compression API.
    private static func inflateRaw(_ input: Data, hintSize: Int) throws -> Data {
        var stream = compression_stream(
            dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: -1)!,
            dst_size: 0,
            src_ptr: UnsafeMutablePointer<UInt8>(bitPattern: -1)!,
            src_size: 0,
            state: nil
        )
        var status = compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
        guard status == COMPRESSION_STATUS_OK else { throw GzipError.inflateFailed }
        defer { compression_stream_destroy(&stream) }

        // Decode buffer: grow geometrically if ISIZE was unhelpful.
        let bufferCapacity = max(hintSize > 0 ? hintSize : input.count * 4, 64 * 1024)
        let dstBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferCapacity)
        defer { dstBuffer.deallocate() }

        var output = Data()

        let result: Data? = input.withUnsafeBytes { (rawSrc: UnsafeRawBufferPointer) -> Data? in
            let srcBase = rawSrc.bindMemory(to: UInt8.self).baseAddress!
            stream.src_ptr = srcBase
            stream.src_size = input.count

            repeat {
                stream.dst_ptr = dstBuffer
                stream.dst_size = bufferCapacity

                status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))

                switch status {
                case COMPRESSION_STATUS_OK, COMPRESSION_STATUS_END:
                    let produced = bufferCapacity - stream.dst_size
                    if produced > 0 {
                        output.append(dstBuffer, count: produced)
                    }
                default:
                    return nil
                }
            } while status == COMPRESSION_STATUS_OK

            return output
        }

        guard let out = result, status == COMPRESSION_STATUS_END else {
            throw GzipError.inflateFailed
        }
        return out
    }
}
