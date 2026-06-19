import Foundation

/// Disk persistence for banked (completed + verified) sections, so you can scan
/// a few sections, close the app, and come back later to finish and recombine.
///
/// Layout: <AppSupport>/AQRTransfers/<fileId>/
///           meta.json          whole-file metadata
///           sec_<i>.bin        raw bytes of completed section i
///
/// All calls are made from the receiver's serial queue, so this type does no
/// locking of its own.
final class SectionStore {

    struct Meta: Codable {
        let id: String
        let name: String
        let mime: String
        let alg: String
        let fileHash: String
        let secs: Int
    }

    private let fm = FileManager.default

    private func root() -> URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("AQRTransfers", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func safe(_ s: String) -> String {
        s.replacingOccurrences(of: "/", with: "_")
         .replacingOccurrences(of: "\\", with: "_")
         .replacingOccurrences(of: "..", with: "_")
    }

    private func dir(for id: String) -> URL {
        let d = root().appendingPathComponent(safe(id), isDirectory: true)
        try? fm.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    // MARK: meta

    func loadMeta(id: String) -> Meta? {
        let url = dir(for: id).appendingPathComponent("meta.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Meta.self, from: data)
    }

    func saveMeta(_ meta: Meta) {
        let url = dir(for: meta.id).appendingPathComponent("meta.json")
        if let data = try? JSONEncoder().encode(meta) {
            try? data.write(to: url, options: .atomic)
        }
    }

    // MARK: sections

    private func sectionURL(id: String, sec: Int) -> URL {
        dir(for: id).appendingPathComponent("sec_\(sec).bin")
    }

    func hasSection(id: String, sec: Int) -> Bool {
        fm.fileExists(atPath: sectionURL(id: id, sec: sec).path)
    }

    func completedSections(id: String, secs: Int) -> Set<Int> {
        var done = Set<Int>()
        for s in 0..<secs where hasSection(id: id, sec: s) { done.insert(s) }
        return done
    }

    func saveSection(id: String, sec: Int, bytes: Data) {
        try? bytes.write(to: sectionURL(id: id, sec: sec), options: .atomic)
    }

    func loadSection(id: String, sec: Int) -> Data? {
        try? Data(contentsOf: sectionURL(id: id, sec: sec))
    }

    func clear(id: String) {
        try? fm.removeItem(at: dir(for: id))
    }
}
