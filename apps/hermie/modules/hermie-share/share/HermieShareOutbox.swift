import Foundation

/**
 Writing one share into the place the app will find it.

 This is the producing half of the file format `src/features/share/outbox.ts`
 parses. There is no shared code between the two and there cannot be — one is
 Swift in a process that lives for three seconds, the other is TypeScript in a
 process that may not be running — so the format itself is the contract, it is
 versioned, and both sides spell the directory names out loud.

 ## Everything is written before anything is named

 An entry is a directory containing the copied files and a `manifest.json`. The
 manifest is written LAST, and that ordering is the whole of what makes a
 half-finished entry safe: the app skips a directory with no readable manifest
 in it, so an extension that was killed between copying a photograph and writing
 the manifest leaves something inert rather than something that claims to have
 files it does not have.

 ## The app never sees a name this extension did not sanitise

 A filename comes from whichever app is sharing, and it ends up as a directory
 entry and then as a string in JSON that the app joins onto a container path.
 `safeFileName` is the same rule `isSafeShareFileName` applies on the other
 side — one segment, no separators, no leading dot, no control characters — and
 both sides apply it, because a check made only by the reader is a check that
 was not made when the bytes were written.
 */
enum HermieShareOutbox {
  /** Must match `HermieShareModule.appGroup` and both entitlement files. */
  static let appGroup = "group.dev.hermie.app"

  /** Also spelled in `outbox.ts` as `SHARE_OUTBOX_DIRECTORY`. */
  static let directoryName = "share-outbox"

  /** Also spelled in `outbox.ts` as `SHARE_MANIFEST_FILE`. */
  static let manifestName = "manifest.json"

  /** `SHARE_MANIFEST_VERSION`. Bumped on both sides or neither. */
  static let version = 1

  /** `SHARE_ITEM_LIMIT`, repeated here so the cut happens before any copying. */
  static let itemLimit = 12

  /** What one loaded attachment is, before it has a home. */
  enum Payload {
    /** A file already copied somewhere this process can read. */
    case file(url: URL, name: String, isImage: Bool)
    case url(String)
    case text(String)
  }

  /**
   A share id: a directory name, a URL path component, and nothing else.

   Hex from `UUID` rather than the UUID's own string, because that carries
   hyphens and the id travels through `hermie://share/<id>` where the fewer
   characters that mean anything the better. It satisfies `isSafeShareId` on the
   other side by construction, which is what lets the deep-link parser reject
   anything else outright instead of trying to work out what it meant.
   */
  static func newIdentifier() -> String {
    UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  }

  /**
   The one-segment file name rule, applied.

   Anything outside the allowed set becomes `-`, runs are collapsed, and an
   empty result falls back rather than producing a nameless file. The cap is
   generous because a name is not a path here — it only has to survive a JSON
   round trip and a directory entry.
   */
  static func safeFileName(_ name: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    let mapped = String(
      String(name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }).prefix(120)
    )

    var collapsed = ""
    var previousWasDash = false

    for character in mapped {
      if character == "-" {
        if previousWasDash { continue }
        previousWasDash = true
      } else {
        previousWasDash = false
      }

      collapsed.append(character)
    }

    let trimmed = collapsed.drop(while: { $0 == "." || $0 == "-" })

    return trimmed.isEmpty ? "attachment" : String(trimmed)
  }

  /**
   Write one entry and answer its id, or nil when there is nowhere to write.

   `bot` is the profile name the sheet's list handed back — the HANDLE, never
   the label, because that is what `hermie://chat/<bot>` carries and what the
   gateway addresses a profile by. Passing the display name here would produce
   an entry the app has to guess at, and it would guess wrong on any gateway
   where two bots share a label.

   Files are copied rather than moved: the URLs come from `NSItemProvider`,
   which owns them and may reclaim them the moment the handler returns, and a
   move from a location the system owns is not a move this process is allowed to
   make.
   */
  static func write(bot: String?, note: String, payloads: [Payload]) -> String? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return nil
    }

    let identifier = newIdentifier()
    let entry = container
      .appendingPathComponent(directoryName, isDirectory: true)
      .appendingPathComponent(identifier, isDirectory: true)

    guard (try? FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)) != nil else {
      return nil
    }

    var items: [[String: Any]] = []
    var used = Set<String>()

    for payload in payloads.prefix(itemLimit) {
      switch payload {
      case let .file(url, name, isImage):
        let safe = uniqueName(safeFileName(name.isEmpty ? url.lastPathComponent : name), taken: &used)
        let destination = entry.appendingPathComponent(safe)

        guard (try? FileManager.default.copyItem(at: url, to: destination)) != nil else {
          // One attachment that could not be copied is one attachment fewer,
          // not a share that fails. The person still gets the rest, and the
          // note, which is usually the part they typed.
          continue
        }

        let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0

        items.append([
          "kind": isImage ? "image" : "file",
          "path": safe,
          "filename": safe,
          "size": size,
          "mimeType": mimeType(for: destination)
        ])

      case let .url(value):
        items.append(["kind": "url", "text": value])

      case let .text(value):
        items.append(["kind": "text", "text": value])
      }
    }

    var manifest: [String: Any] = [
      "version": version,
      "id": identifier,
      "note": note,
      "createdAt": Int(Date().timeIntervalSince1970),
      "items": items
    ]

    if let bot, !bot.isEmpty {
      manifest["bot"] = bot
    }

    guard let data = try? JSONSerialization.data(withJSONObject: manifest, options: []) else {
      try? FileManager.default.removeItem(at: entry)

      return nil
    }

    // LAST, and atomic. A directory with no manifest is skipped by the app; a
    // directory with HALF a manifest would be skipped too, because the parse
    // fails — but atomic makes the swap a rename, so the question never arises.
    guard (try? data.write(to: entry.appendingPathComponent(manifestName), options: .atomic)) != nil else {
      try? FileManager.default.removeItem(at: entry)

      return nil
    }

    return identifier
  }

  /**
   Two photographs called `IMG_0001.jpg` are two different files.

   iOS hands a multi-image share a provider per asset and the names collide
   routinely. Without this the second copy fails — `copyItem` refuses an
   existing destination — and the share silently loses half of what was
   selected.
   */
  private static func uniqueName(_ name: String, taken: inout Set<String>) -> String {
    if !taken.contains(name) {
      taken.insert(name)

      return name
    }

    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var index = 2

    while true {
      let candidate = ext.isEmpty ? "\(base)-\(index)" : "\(base)-\(index).\(ext)"

      if !taken.contains(candidate) {
        taken.insert(candidate)

        return candidate
      }

      index += 1
    }
  }

  /**
   A hint, and never more than that.

   The gateway sniffs the bytes it is given, and the upload does not send this
   header at all — so a wrong answer here costs nothing. It is written because
   the manifest is also what a person reads when they are working out why a
   share did not arrive, and "application/octet-stream" for a PDF is a worse
   answer than a guess from the extension.
   */
  private static func mimeType(for url: URL) -> String {
    let byExtension: [String: String] = [
      "png": "image/png",
      "jpg": "image/jpeg",
      "jpeg": "image/jpeg",
      "heic": "image/heic",
      "gif": "image/gif",
      "webp": "image/webp",
      "pdf": "application/pdf",
      "txt": "text/plain",
      "md": "text/markdown",
      "json": "application/json",
      "csv": "text/csv",
      "zip": "application/zip",
      "mp4": "video/mp4",
      "mov": "video/quicktime"
    ]

    return byExtension[url.pathExtension.lowercased()] ?? "application/octet-stream"
  }
}
