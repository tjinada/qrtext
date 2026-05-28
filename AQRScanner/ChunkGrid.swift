import SwiftUI

/// A compact grid of squares, one per chunk, that fills in green as frames are
/// captured. Gives instant visual feedback on which parts of the transfer are
/// in — the native equivalent of the "Chunks: 12 / 33" line plus a sense of
/// *which* 12.
struct ChunkGrid: View {
    let total: Int
    let received: Set<Int>

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 12)

    var body: some View {
        if total > 0 {
            LazyVGrid(columns: columns, spacing: 3) {
                ForEach(0..<total, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(received.contains(i) ? Color.green : Color.secondary.opacity(0.25))
                        .aspectRatio(1, contentMode: .fit)
                }
            }
        }
    }
}
