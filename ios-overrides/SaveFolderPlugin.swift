// Capacitor plugin: let the user pick a folder (Files app document picker)
// and read/write individual files inside it. Memki keeps its whole
// collection in `memki.json` there so external tools can sync it.
//
// iOS port of android/.../SaveFolderPlugin.java — identical JS contract
// (see web/native-bridge.js), so the web side needs no platform branches:
//
//   pickFolder()            -> { uri, label }          rejects "CANCELLED"
//   getFolder()             -> { uri, label } | { uri: null }
//   readFile({ name })      -> { data: base64 | null }
//   writeFile({ name, data: base64 }) -> { modified }  (atomic tmp+rename)
//   statFile({ name })      -> { exists, modified, size }
//   readMedia({ name })     -> { data: base64 | null }   } media lives in a
//   writeMedia({ name, data: base64 }) -> { modified }   } "memki.media"
//                                                          } subfolder
//   exportFile({ name, data: base64, mimeType }) -> { uri }
//                             "save as" picker (UIDocumentPicker export);
//                             rejects "CANCELLED"
//
// Platform mapping:
//   - Android's persisted SAF tree URI becomes an iOS security-scoped
//     bookmark (Data) stored in UserDefaults. Resolving it yields a URL we
//     must startAccessingSecurityScopedResource() on before any I/O.
//   - `uri` in resolve payloads is the folder URL's absoluteString. It is
//     display/debug only — the bookmark data is the source of truth.
//   - `modified` is milliseconds since 1970, matching File.lastModified.
//
// Registration: Capacitor 6 auto-registers every CAPBridgedPlugin found in
// the app binary at bridge setup, so simply compiling this file into the
// App target (via ios-overrides/inject-into-xcodeproj.rb) is enough.

import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(SaveFolderPlugin)
public class SaveFolderPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "SaveFolderPlugin"
    public let jsName = "SaveFolder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "migrate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportFile", returnType: CAPPluginReturnPromise),
    ]

    private static let bookmarkKey = "SaveFolder.bookmark"
    private static let labelKey = "SaveFolder.label"
    private static let mediaDirName = "memki.media"

    private let defaults = UserDefaults.standard

    // Only one system picker can be meaningfully in flight at a time (the
    // JS side serializes these calls, same as on Android).
    private enum PendingPicker {
        case pickFolder(CAPPluginCall)
        case exportFile(CAPPluginCall, tempURL: URL)
    }
    private var pendingPicker: PendingPicker?

    // ── Folder resolution (security-scoped bookmark) ──────────────

    /// Resolve the persisted bookmark to a folder URL, refreshing the
    /// stored bookmark when the system reports it stale. Returns nil when
    /// no folder was ever chosen or the bookmark no longer resolves (e.g.
    /// the folder was deleted) — the JS side treats that as "no folder"
    /// and shows the pick gate, mirroring a revoked SAF grant on Android.
    private func resolveFolder() -> URL? {
        guard let data = defaults.data(forKey: Self.bookmarkKey) else { return nil }
        do {
            var stale = false
            let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
            if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                defaults.set(fresh, forKey: Self.bookmarkKey)
            }
            return url
        } catch {
            return nil
        }
    }

    /// Run `body` with security scope held on the resolved folder.
    private func withFolder<T>(_ body: (URL) throws -> T) throws -> T {
        guard let url = resolveFolder() else {
            throw PluginError.noFolder
        }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        return try body(url)
    }

    private enum PluginError: Error, CustomStringConvertible {
        case noFolder
        var description: String { "no save folder chosen" }
    }

    // ── pickFolder / getFolder ────────────────────────────────────

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingPicker == nil, let presenter = self.bridge?.viewController else {
                call.reject("a picker is already active", "BUSY")
                return
            }
            let picker: UIDocumentPickerViewController
            if #available(iOS 14.0, *) {
                picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            } else {
                picker = UIDocumentPickerViewController(documentTypes: ["public.folder"], in: .open)
            }
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.pendingPicker = .pickFolder(call)
            presenter.present(picker, animated: true)
        }
    }

    @objc func getFolder(_ call: CAPPluginCall) {
        guard let url = resolveFolder() else {
            call.resolve(["uri": NSNull()])
            return
        }
        call.resolve([
            "uri": url.absoluteString,
            "label": defaults.string(forKey: Self.labelKey) ?? url.lastPathComponent,
        ])
    }

    // ── read / write / stat ───────────────────────────────────────

    @objc func readFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else {
            call.reject("need name", "BAD_INPUT")
            return
        }
        do {
            let data = try withFolder { folder -> String? in
                let file = folder.appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: file.path) else { return nil }
                return try Data(contentsOf: file).base64EncodedString()
            }
            if let data = data {
                call.resolve(["data": data])
            } else {
                call.resolve(["data": NSNull()])
            }
        } catch PluginError.noFolder {
            call.resolve(["data": NSNull()]) // mirrors Android: findFile on null tree -> null
        } catch {
            call.reject("read failed: \(error.localizedDescription)", "IO")
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let data = call.getString("data") else {
            call.reject("need name and data", "BAD_INPUT")
            return
        }
        guard let bytes = Data(base64Encoded: data, options: .ignoreUnknownCharacters) else {
            call.reject("bad base64 data", "BAD_INPUT")
            return
        }
        do {
            let modified = try withFolder { folder -> Int64 in
                try Self.atomicWrite(bytes, to: folder.appendingPathComponent(name))
                return Self.modifiedMillis(of: folder.appendingPathComponent(name))
            }
            call.resolve(["modified": modified])
        } catch PluginError.noFolder {
            call.reject(PluginError.noFolder.description, "NO_FOLDER")
        } catch {
            call.reject("write failed: \(error.localizedDescription)", "IO")
        }
    }

    @objc func statFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else {
            call.reject("need name", "BAD_INPUT")
            return
        }
        // stat is best-effort metadata: no folder / missing file resolves
        // to exists:false rather than rejecting (matches the Java side,
        // which never rejects from statFile).
        let result: [String: Any] = (try? withFolder { folder -> [String: Any] in
            let file = folder.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.path) else {
                return ["exists": false, "modified": 0, "size": 0]
            }
            return [
                "exists": true,
                "modified": Self.modifiedMillis(of: file),
                "size": Self.fileSize(of: file),
            ]
        }) ?? ["exists": false, "modified": 0, "size": 0]
        call.resolve(result)
    }

    // ── Media files (memki.media/ subfolder of the save folder) ──

    @objc func readMedia(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else {
            call.reject("need name", "BAD_INPUT")
            return
        }
        do {
            let data = try withFolder { folder -> String? in
                let file = folder.appendingPathComponent(Self.mediaDirName).appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: file.path) else { return nil }
                return try Data(contentsOf: file).base64EncodedString()
            }
            if let data = data {
                call.resolve(["data": data])
            } else {
                call.resolve(["data": NSNull()])
            }
        } catch PluginError.noFolder {
            call.resolve(["data": NSNull()])
        } catch {
            call.reject("media read failed: \(error.localizedDescription)", "IO")
        }
    }

    @objc func writeMedia(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let data = call.getString("data") else {
            call.reject("need name and data", "BAD_INPUT")
            return
        }
        guard let bytes = Data(base64Encoded: data, options: .ignoreUnknownCharacters) else {
            call.reject("bad base64 data", "BAD_INPUT")
            return
        }
        do {
            let modified = try withFolder { folder -> Int64 in
                let dir = folder.appendingPathComponent(Self.mediaDirName)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let target = dir.appendingPathComponent(name)
                try Self.atomicWrite(bytes, to: target)
                return Self.modifiedMillis(of: target)
            }
            call.resolve(["modified": modified])
        } catch PluginError.noFolder {
            call.reject(PluginError.noFolder.description, "NO_FOLDER")
        } catch {
            call.reject("media write failed: \(error.localizedDescription)", "IO")
        }
    }

    // ── One-time rename from the pre-rename (oss-anki.*) names ────

    @objc func migrate(_ call: CAPPluginCall) {
        try? withFolder { folder in
            renameIfOrphan(in: folder, from: "oss-anki.json", to: "memki.json")
            renameIfOrphan(in: folder, from: "oss-anki-backup.json", to: "memki-backup.json")
            renameIfOrphan(in: folder, from: "oss-anki.media", to: Self.mediaDirName)
        }
        call.resolve()
    }

    private func renameIfOrphan(in folder: URL, from oldName: String, to newName: String) {
        let fm = FileManager.default
        let oldURL = folder.appendingPathComponent(oldName)
        let newURL = folder.appendingPathComponent(newName)
        if fm.fileExists(atPath: oldURL.path) && !fm.fileExists(atPath: newURL.path) {
            try? fm.moveItem(at: oldURL, to: newURL)
        }
    }

    // ── "Save as" export (UIDocumentPicker export mode) ───────────

    @objc func exportFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let data = call.getString("data") else {
            call.reject("need name and data", "BAD_INPUT")
            return
        }
        guard let bytes = Data(base64Encoded: data, options: .ignoreUnknownCharacters) else {
            call.reject("bad base64 data", "BAD_INPUT")
            return
        }
        do {
            // The export picker needs an on-disk source URL it can copy
            // out of the sandbox; stage the bytes in a unique temp dir.
            let staging = FileManager.default.temporaryDirectory
                .appendingPathComponent("memki-export-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            let tempURL = staging.appendingPathComponent(name)
            try bytes.write(to: tempURL)

            DispatchQueue.main.async {
                guard self.pendingPicker == nil, let presenter = self.bridge?.viewController else {
                    try? FileManager.default.removeItem(at: staging)
                    call.reject("a picker is already active", "BUSY")
                    return
                }
                let picker: UIDocumentPickerViewController
                if #available(iOS 14.0, *) {
                    picker = UIDocumentPickerViewController(forExporting: [tempURL], asCopy: true)
                } else {
                    picker = UIDocumentPickerViewController(urls: [tempURL], in: .exportToService)
                }
                picker.delegate = self
                self.pendingPicker = .exportFile(call, tempURL: tempURL)
                presenter.present(picker, animated: true)
            }
        } catch {
            call.reject("export staging failed: \(error.localizedDescription)", "IO")
        }
    }

    // ── UIDocumentPickerDelegate ──────────────────────────────────

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let pending = pendingPicker else { return }
        pendingPicker = nil
        switch pending {
        case .pickFolder(let call):
            guard let url = urls.first else {
                call.reject("Folder pick cancelled", "CANCELLED")
                return
            }
            do {
                let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                defaults.set(bookmark, forKey: Self.bookmarkKey)
                defaults.set(url.lastPathComponent, forKey: Self.labelKey)
                call.resolve(["uri": url.absoluteString, "label": url.lastPathComponent])
            } catch {
                call.reject("could not persist folder access: \(error.localizedDescription)", "IO")
            }
        case .exportFile(let call, let tempURL):
            defer { try? FileManager.default.removeItem(at: tempURL.deletingLastPathComponent()) }
            guard let dest = urls.first else {
                call.reject("Export cancelled", "CANCELLED")
                return
            }
            call.resolve(["uri": dest.absoluteString])
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let pending = pendingPicker else { return }
        pendingPicker = nil
        switch pending {
        case .pickFolder(let call):
            call.reject("Folder pick cancelled", "CANCELLED")
        case .exportFile(let call, let tempURL):
            try? FileManager.default.removeItem(at: tempURL.deletingLastPathComponent())
            call.reject("Export cancelled", "CANCELLED")
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    /// Write via a `<name>.tmp` sibling renamed over the target — a crash
    /// mid-write can never leave a truncated save file, and file watchers
    /// only ever see complete files. Same contract as the Android side.
    private static func atomicWrite(_ bytes: Data, to target: URL) throws {
        let fm = FileManager.default
        let tmp = target.deletingLastPathComponent()
            .appendingPathComponent(target.lastPathComponent + ".tmp")
        try bytes.write(to: tmp, options: [])
        if fm.fileExists(atPath: target.path) {
            try fm.removeItem(at: target)
        }
        try fm.moveItem(at: tmp, to: target)
    }

    private static func modifiedMillis(of url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return Int64((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
    }

    private static func fileSize(of url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values?.fileSize ?? 0)
    }
}
