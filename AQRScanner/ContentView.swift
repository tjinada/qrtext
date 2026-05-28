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
            Text("Scan the animated QR on your computer screen")
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
            ProgressView(value: Double(receiver.receivedCount),
                         total: Double(max(receiver.total, 1)))

            Text("\(receiver.receivedCount) / \(receiver.total) — \(receiver.statusText)")
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(receiver.isComplete ? Color.green : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            ChunkGrid(total: receiver.total,
                      received: Set(0..<receiver.total).subtracting(receiver.missingIndices))
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
