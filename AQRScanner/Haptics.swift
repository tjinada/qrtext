import UIKit

/// Thin wrapper over UIKit's feedback generators. A "tick" fires when a new
/// chunk is captured (so you feel progress without watching the screen); a
/// "success" notification fires when the whole transfer verifies.
enum Haptics {
    private static let impact = UIImpactFeedbackGenerator(style: .light)
    private static let notify = UINotificationFeedbackGenerator()

    static func tick() {
        impact.prepare()
        impact.impactOccurred()
    }

    static func success() {
        notify.prepare()
        notify.notificationOccurred(.success)
    }

    static func failure() {
        notify.prepare()
        notify.notificationOccurred(.error)
    }
}
