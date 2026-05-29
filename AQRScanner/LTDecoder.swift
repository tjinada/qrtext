import Foundation

/// LT (Luby Transform) fountain decoder. This is a line-by-line port of the
/// LTDecoder class in client/app.debug4.js. Both sides MUST agree on:
///
///   1. The PRNG output bit-for-bit (mulberry32, below)
///   2. The soliton degree distribution
///   3. The rejection-sampling rule for picking distinct indices
///
/// If any of those drift, the decoder will silently fail to converge.
///
/// Wire format (AQR2):
///   AQR2|id|seed|K|totalBytes|alg|fileHash|nameB64|mimeB64|xorPayloadB64
///
/// Each frame is one XOR of a randomly-chosen subset of source blocks. The
/// `seed` deterministically encodes WHICH subset, by reproducing the same
/// PRNG/degree/indices on both sides. The decoder keeps a system of equations
/// and applies belief-propagation substitution as new equations arrive.

// MARK: - mulberry32 PRNG
//
// Bit-identical to the JS implementation:
//
//     s = (s + 0x6D2B79F5) >>> 0
//     t = s
//     t = Math.imul(t ^ (t >>> 15), t | 1)
//     t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
//     return ((t ^ (t >>> 14)) >>> 0)
//
// All arithmetic is unsigned 32-bit. We use UInt32 here with wrap-around
// operators (&+, &*, etc.) to match JS's modulo-2^32 behavior.

struct Mulberry32 {
    private var s: UInt32

    init(seed: UInt32) {
        self.s = seed
    }

    /// Returns the next uint32 sample.
    mutating func nextUInt32() -> UInt32 {
        s = s &+ 0x6D2B79F5
        var t: UInt32 = s
        // Math.imul produces a 32-bit truncated product. UInt32's `&*` does the same.
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return t ^ (t >> 14)
    }

    /// Map uint32 -> Double in [0, 1). Matches `rng() / 4294967296` in JS.
    mutating func nextFloat() -> Double {
        return Double(nextUInt32()) / 4294967296.0
    }

    /// Returns an integer in [0, bound). Same rule as JS: `rng() % bound`.
    mutating func nextInt(below bound: Int) -> Int {
        return Int(nextUInt32() % UInt32(bound))
    }
}

// MARK: - Soliton sampling

enum LTSampling {
    /// Ideal soliton distribution. Returns an integer degree in [1, K].
    ///
    /// P(1) = 1/K, P(i) = 1 / (i * (i-1)) for i in 2..K. Matches sampleDegree()
    /// in the JS encoder.
    static func sampleDegree(rng: inout Mulberry32, K: Int) -> Int {
        let u = rng.nextFloat()
        var cum = 1.0 / Double(K)
        if u < cum { return 1 }
        for i in 2...K {
            cum += 1.0 / (Double(i) * Double(i - 1))
            if u < cum { return i }
        }
        return K
    }

    /// Pick `degree` distinct indices from [0, K) by rejection sampling. The
    /// resulting array is sorted ascending to match JS's stable ordering.
    static func pickIndices(rng: inout Mulberry32, K: Int, degree: Int) -> [Int] {
        var set = Set<Int>()
        while set.count < degree {
            set.insert(rng.nextInt(below: K))
        }
        return set.sorted()
    }
}

// MARK: - LTDecoder

/// Single LT decoder instance. Created when the first AQR2 frame of a transfer
/// arrives, fed every subsequent frame, and queried for completion.
final class LTDecoder {
    let K: Int
    let blockSize: Int
    let totalBytes: Int

    /// One slot per source block. nil = unknown; once decoded, holds the
    /// reconstructed bytes for that block.
    private(set) var blocks: [Data?]

    /// Equations not yet reducible to a single unknown. Each holds the current
    /// (possibly partially-reduced) XOR payload and the set of unresolved
    /// source-block indices that still contribute to it.
    private struct Equation {
        var payload: Data
        var indices: Set<Int>
    }
    private var pending: [Equation] = []

    private(set) var resolvedCount: Int = 0
    private(set) var equationsSeen: Int = 0

    init(K: Int, blockSize: Int, totalBytes: Int) {
        self.K = K
        self.blockSize = blockSize
        self.totalBytes = totalBytes
        self.blocks = Array(repeating: nil, count: K)
    }

    var isComplete: Bool { resolvedCount == K }

    var pendingCount: Int { pending.count }

    /// Ingest one (seed, xorPayload) equation. Cascades any newly resolvable
    /// blocks via belief propagation. Returns true if this equation actually
    /// resolved at least one new block.
    @discardableResult
    func addEquation(seed: UInt32, xorPayload: Data) -> Bool {
        equationsSeen += 1

        // Recompute the index set from the seed using the same RNG/distribution
        // as the encoder. If either side drifts, decoding silently breaks.
        var rng = Mulberry32(seed: seed)
        let degree = LTSampling.sampleDegree(rng: &rng, K: K)
        var indices = Set(LTSampling.pickIndices(rng: &rng, K: K, degree: degree))

        // Reduce by anything we already know.
        var payload = xorPayload
        for i in Array(indices) {
            if let known = blocks[i] {
                payload = LTDecoder.xor(payload, known)
                indices.remove(i)
            }
        }

        if indices.isEmpty {
            return false                    // redundant equation
        }
        if indices.count == 1 {
            let idx = indices.first!
            resolve(index: idx, payload: payload)
            propagate()
            return true
        }
        pending.append(Equation(payload: payload, indices: indices))
        return false
    }

    private func resolve(index idx: Int, payload: Data) {
        if blocks[idx] != nil { return }
        blocks[idx] = payload
        resolvedCount += 1
    }

    /// Walk the pending equations repeatedly, substituting any newly-resolved
    /// blocks. An equation that collapses to a single unknown gets resolved;
    /// that resolution may enable other equations to collapse on the next pass.
    private func propagate() {
        var changed = true
        while changed {
            changed = false
            var stillPending: [Equation] = []
            for eq in pending {
                var indices = eq.indices
                var payload = eq.payload
                for i in Array(indices) {
                    if let known = blocks[i] {
                        payload = LTDecoder.xor(payload, known)
                        indices.remove(i)
                    }
                }
                if indices.isEmpty {
                    continue                    // dropped
                }
                if indices.count == 1 {
                    let idx = indices.first!
                    resolve(index: idx, payload: payload)
                    changed = true
                    continue
                }
                stillPending.append(Equation(payload: payload, indices: indices))
            }
            pending = stillPending
        }
    }

    /// Concatenate all resolved blocks in order and trim trailing padding to
    /// `totalBytes`.
    func rebuild() -> Data? {
        guard isComplete else { return nil }
        var out = Data(capacity: K * blockSize)
        for i in 0..<K {
            // Force-unwrap is safe because isComplete guarantees all slots are set.
            out.append(blocks[i]!)
        }
        if out.count > totalBytes {
            return out.prefix(totalBytes)
        }
        return out
    }

    // MARK: - byte-wise XOR

    /// XOR two equal-length Data values, returning a new Data. The decoder
    /// always passes equal-length payloads here (they're always one full
    /// blockSize), but we still tolerate the smaller of the two lengths
    /// defensively rather than crashing on a malformed frame.
    static func xor(_ a: Data, _ b: Data) -> Data {
        let n = min(a.count, b.count)
        var out = Data(count: n)
        a.withUnsafeBytes { rawA in
            b.withUnsafeBytes { rawB in
                out.withUnsafeMutableBytes { rawOut in
                    let aBuf = rawA.bindMemory(to: UInt8.self)
                    let bBuf = rawB.bindMemory(to: UInt8.self)
                    let oBuf = rawOut.bindMemory(to: UInt8.self)
                    for i in 0..<n {
                        oBuf[i] = aBuf[i] ^ bBuf[i]
                    }
                }
            }
        }
        return out
    }
}
