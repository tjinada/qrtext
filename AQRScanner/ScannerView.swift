import SwiftUI
import VisionKit

/// SwiftUI wrapper around VisionKit's DataScannerViewController. VisionKit drives
/// the camera with Apple's own autofocus/exposure pipeline (the same one the
/// Camera app uses), which is exactly the capability the browser version could
/// not reach. Requires iOS 16+ and an A12 Bionic device or newer.
struct ScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,                 // .fast trades accuracy for throughput
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true              // draws the box on the QR for free
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {
        try? vc.startScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        // didAdd fires when a new code enters frame; didUpdate fires as the same
        // code's payload changes across frames (i.e. the animation advancing).
        // We funnel both into the receiver, which dedupes by chunk index.
        func dataScanner(_ dataScanner: DataScannerViewController,
                         didAdd addedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            handle(addedItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController,
                         didUpdate updatedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            handle(updatedItems)
        }

        private func handle(_ items: [RecognizedItem]) {
            for item in items {
                if case let .barcode(barcode) = item,
                   let payload = barcode.payloadStringValue {
                    onScan(payload)
                }
            }
        }
    }
}

/// Convenience check the UI can use to show a friendly message on unsupported
/// hardware instead of a blank camera.
enum ScannerAvailability {
    static var isSupported: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }
}
