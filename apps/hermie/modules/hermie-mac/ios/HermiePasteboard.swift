import Foundation
import UIKit
import UniformTypeIdentifiers

/**
 What `UIPasteboard.general` is holding, the moment ⌘V reports itself.

 `HermieMacModule` reports the CHORD off GameController's HID state — see its own comment — and
 reports it for every text field in the app, not only the composer. This is deliberately a second
 step rather than folded into that handler: the shortcut is cheap to detect and free of any real
 work, and asking the pasteboard for an image only makes sense for the ONE caller that has
 somewhere to put one. JavaScript decides that; this only answers what is there.

 ## Not an interception

 Nothing here touches the responder chain, and that is the point rather than a limitation. A
 plain-text ⌘V has already been handled by the focused `UITextView` through the ordinary paste path
 by the time JavaScript even hears the shortcut happened, because this runs on a REPORT of the key
 having gone down, not on the paste action itself. An image or a file pasteboard, which a plain
 `UITextView` cannot paste at all — `canPerformAction(_:withSender:)` returns `false` for one with no
 string representation — is the ONLY case this adds anything to.

 ## The copy, again

 Same reasoning as `HermieDropView`: an image is written out fresh because there is no file behind
 it at all, and a file URL from `UIPasteboard.general.urls` is copied into the app's own tmp
 directory rather than referenced in place, because the upload this feeds starts several turns
 later and a security-scoped URL from another app's pasteboard entry is not guaranteed to still
 resolve by then.
 */
enum HermiePasteboard {
  /**
   Every image or file attachment the general pasteboard is holding, in the same
   `{uri, name, size, mimeType}` shape `HermieDropView` hands JavaScript.

   Both kinds are collected rather than the first one found: a paste can carry more than one image
   at once — several photos copied together — and a Finder copy of one file alongside a caption
   string should still hand over the file. A pasteboard holding neither returns an empty array,
   which is the same thing to a caller as "nothing worth pasting" and not an error.
   */
  static func attachments() -> [[String: Any]] {
    let pasteboard = UIPasteboard.general
    var results: [[String: Any]] = []

    for image in pasteboard.images ?? [] {
      if let attachment = writeImage(image) {
        results.append(attachment)
      }
    }

    for url in pasteboard.urls ?? [] where url.isFileURL {
      if let attachment = copyFile(url) {
        results.append(attachment)
      }
    }

    return results
  }

  /**
   Write one pasted image out as its own file.

   PNG rather than a compressed format: `attachments.ts` re-encodes as JPEG at 0.85 quality and a
   resized edge once it knows the pixel size, so compressing twice here would only cost quality for
   no smaller an upload. `image.scale` folds in because `UIImage.size` is in POINTS — a Retina
   screenshot's `size` alone would under-report its actual pixel count, and that pixel count is the
   one thing `resizeToBase64` needs to decide whether to resize at all.
   */
  private static func writeImage(_ image: UIImage) -> [String: Any]? {
    guard let data = image.pngData() else {
      return nil
    }

    guard let destination = temporaryDestination(named: "pasted-image-\(UUID().uuidString.prefix(8)).png") else {
      return nil
    }

    do {
      try data.write(to: destination)
    } catch {
      return nil
    }

    return [
      "uri": destination.absoluteString,
      "name": destination.lastPathComponent,
      "size": data.count,
      "mimeType": "image/png",
      "width": Double(image.size.width * image.scale),
      "height": Double(image.size.height * image.scale)
    ]
  }

  /** Copy one pasted file URL somewhere it will still exist when the upload gets to it. */
  private static func copyFile(_ source: URL) -> [String: Any]? {
    guard let destination = temporaryDestination(named: source.lastPathComponent) else {
      return nil
    }

    let scoped = source.startAccessingSecurityScopedResource()

    defer {
      if scoped {
        source.stopAccessingSecurityScopedResource()
      }
    }

    do {
      try FileManager.default.copyItem(at: source, to: destination)
    } catch {
      // A pasteboard entry this process cannot read is not an error worth throwing into a keyboard
      // shortcut: the reader gets no attachment for that one item rather than a crash.
      return nil
    }

    let size = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? Int) ?? nil
    let mimeType = UTType(filenameExtension: destination.pathExtension)?.preferredMIMEType

    return [
      "uri": destination.absoluteString,
      "name": destination.lastPathComponent,
      "size": size ?? 0,
      "mimeType": mimeType ?? "application/octet-stream"
    ]
  }

  /** `tmp/hermie-paste/<uuid>/<name>` — a directory per paste, as `HermieDropView` uses per drop. */
  private static func temporaryDestination(named name: String) -> URL? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("hermie-paste", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)

    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      return nil
    }

    return directory.appendingPathComponent(name)
  }
}
