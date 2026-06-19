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
        .onChange(of: receiver.allReady) { ready in
            // Every section is banked — stop the camera so it stops flooding the
            // decode queue, which is what made Recombine appear to hang.
            if ready { scanning = false }
        }
        .sheet(isPresented: $showShare) {
            if let url = receiver.rebuiltURL {
                ShareSheet(items: [url])
            }
        }
    }

    private var header: some View {
        VStack(spacing: 2) {
            Text("AQR Transfer").font(.largeTitle.bold())
            Text("AQR3 / sectioned fountain codes — scan section by section")
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
            // Sections banked out of total. With fountain codes each section
            // finishes once enough of ITS frames arrive (any order); the phone
            // verifies and saves it, so progress survives closing the app.
            ProgressView(value: Double(receiver.doneSections.count),
                         total: Double(max(receiver.secs, 1)))

            Text(receiver.secs > 0
                 ? "\(receiver.doneSections.count) / \(receiver.secs) sections  ·  \(receiver.fileName)"
                 : "Waiting for the first frame…")
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(receiver.isComplete ? Color.green : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            SectionGrid(secs: receiver.secs,
                        done: receiver.doneSections,
                        inProgress: receiver.inProgress)

            Text(receiver.statusText)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if receiver.isRecombining {
                VStack(spacing: 3) {
                    ProgressView(value: receiver.recombineProgress)
                        .tint(.blue)
                    Text("Recombining \(Int(receiver.recombineProgress * 100))%")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 2)
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
            } else if receiver.allReady {
                Button(receiver.isRecombining ? "Recombining…" : "Recombine") {
                    receiver.recombine()
                }
                .buttonStyle(.borderedProminent)
                .tint(.blue)
                .disabled(receiver.isRecombining)
            }
        }
    }
}

/// One pill per section: green ✓ when banked, orange % while decoding, grey —
/// when untouched. The frontier tells you which section to keep scanning.
struct SectionGrid: View {
    let secs: Int
    let done: Set<Int>
    let inProgress: [Int: Double]

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 5)

    var body: some View {
        if secs > 0 {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(0..<secs, id: \.self) { s in
                    let isDone = done.contains(s)
                    let frac = inProgress[s] ?? 0
                    VStack(spacing: 1) {
                        Text("S\(s + 1)")
                            .font(.system(size: 10, weight: .bold))
                        Text(isDone ? "✓" : (frac > 0 ? "\(Int(frac * 100))%" : "—"))
                            .font(.system(size: 9, design: .monospaced))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(isDone ? Color.green.opacity(0.85)
                                       : (frac > 0 ? Color.orange.opacity(0.28)
                                                   : Color.secondary.opacity(0.18)))
                    .foregroundStyle(isDone ? Color.black : Color.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
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
