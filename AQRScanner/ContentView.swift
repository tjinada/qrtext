import SwiftUI

struct ContentView: View {
    @StateObject private var receiver = TransferReceiver()
    @State private var scanning = false
    @State private var showShare = false

    var body: some View {
        VStack(spacing: 14) {
            header

            scannerArea

            progressArea

            controls

            if let text = receiver.rebuiltText {
                ScrollView {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(8)
                }
                .frame(maxHeight: 160)
                .background(Color.secondary.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            Spacer(minLength: 0)
        }
        .padding()
        .sheet(isPresented: $showShare) {
            if let url = receiver.rebuiltURL {
                ShareSheet(items: [url])
            }
        }
    }

    private var header: some View {
        VStack(spacing: 2) {
            Text("AQR Transfer").font(.largeTitle.bold())
            Text("AQR2 / fountain codes — scan until complete")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var scannerArea: some View {
        if scanning {
            if ScannerAvailability.isSupported {
                ScannerView { payload in
                    receiver.ingest(payload)
                }
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .frame(maxHeight: 420)
            } else {
                unsupportedPlaceholder
            }
        } else {
            RoundedRectangle(cornerRadius: 16)
                .fill(Color.black)
                .frame(height: 420)
                .overlay(
                    Text("Tap Start Camera Scan")
                        .foregroundStyle(.white.opacity(0.8))
                )
        }
    }

    private var unsupportedPlaceholder: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(Color.black)
            .frame(height: 420)
            .overlay(
                Text("Scanning needs iOS 16+ on an A12 device or newer.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.8))
                    .padding()
            )
    }

    private var progressArea: some View {
        VStack(spacing: 8) {
            // Progress is now "blocks resolved out of K" rather than "chunks
            // captured out of N". With fountain codes, every successful frame
            // contributes useful information toward decoding — even though only
            // some frames flip another block to "resolved", the rest sit in the
            // pending pool and cascade later.
            ProgressView(value: Double(receiver.resolvedCount),
                         total: Double(max(receiver.K, 1)))

            Text("\(receiver.resolvedCount) / \(receiver.K) blocks  ·  \(receiver.framesSeen) frames seen")
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(receiver.isComplete ? Color.green : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(receiver.statusText)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !receiver.isComplete && receiver.pendingEquations > 0 {
                Text("\(receiver.pendingEquations) equations pending — keep scanning, they'll cascade")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button(scanning ? "Stop" : "Start Camera Scan") {
                scanning.toggle()
            }
            .buttonStyle(.borderedProminent)

            Button("Reset") {
                receiver.reset()
            }
            .buttonStyle(.bordered)

            if receiver.isComplete {
                Button("Save / Share") {
                    showShare = true
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
            }
        }
    }
}

/// Minimal UIActivityViewController bridge for the native share sheet (Files,
/// AirDrop, Messages, etc.).
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

#Preview {
    ContentView()
}
