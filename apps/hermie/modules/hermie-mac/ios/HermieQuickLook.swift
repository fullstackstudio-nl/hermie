import QuickLook
import UIKit

/**
 A file, previewed the way the platform previews files.

 What a tap on an attachment chip did before this was open the share sheet, on every Apple target.
 That is the right surface for "send this somewhere" and the wrong one for "let me look at it": it
 is a list of destinations, and reading a PDF through it means picking an app first. On a Mac — where
 Quick Look is a thing people press Space for — it is conspicuously the wrong answer.

 `QLPreviewController` is an iOS class, not a Mac one, so this is not a Mac-only addition even though
 the Mac is what prompted it. It lives in `hermie-mac` because that module is already the app's
 Apple-side lever and a second local module for one view controller would be a second podspec, a
 second autolink entry and a second thing to keep in the `.easignore`.

 ## Presented, not returned

 The controller is presented from here rather than handed to JavaScript, because React Native has no
 way to host a `UIViewController` that owns its own navigation chrome, and wrapping one would mean a
 view manager, a measured frame and a dismissal path — for a controller whose entire job is to appear
 modally over everything. It is put up over the TOPMOST presented controller, so it appears over a
 bottom sheet rather than behind one: a sheet is a presented `UIViewController` and presenting from
 the root while one is up throws "which is already presenting".

 ## The cache copy

 `QLPreviewItem` is a URL, and the controller reads it directly — so it has to be a URL the process
 can read, which in practice means a `file://` one. Every caller today hands over exactly that: the
 only attachment URIs this app ever has are the local ones from its own picker, because the gateway
 stores a file on its own disk and serves nothing back (see `ChatScreen`'s `sentImages`).

 An `http(s)` URI is still accepted and is fetched to the caches directory first, for two reasons.
 The first is that it is the only correct thing to do with one: handing a remote URL to
 `QLPreviewController` shows an empty sheet on some types and nothing at all on others. The second
 is that when the gateway does grow a route that serves an attachment back, this is the half that
 would otherwise have to be written under time pressure — and the caches directory is where a copy of
 somebody else's file belongs, because the system may delete it and nothing here depends on it
 surviving.

 The fetch carries no credentials and no headers. That is a limit worth stating rather than papering
 over: a gateway that needs an `Authorization` header to serve a file is a gateway this cannot
 preview, and the honest answer then is `false` — which sends the caller back to the share sheet.
 */
/*
 `@MainActor` on the class rather than on the two static entry points: the data source and delegate
 methods touch UIKit as well, and isolating the type is what lets the conformances be written
 plainly. `QLPreviewControllerDelegate` is declared `@preconcurrency` because its own methods carry
 no isolation in the SDK, so a main-actor conformance to it is a data-race warning today and an
 error in the Swift 6 language mode — UIKit only ever calls these on the main thread.
 */
@MainActor
final class HermieQuickLook: NSObject, QLPreviewControllerDataSource, @preconcurrency QLPreviewControllerDelegate {
  /**
   The one live preview, held so ARC does not take its data source away mid-scroll.

   `QLPreviewController` holds its data source WEAKLY, and this object is the data source. Without
   this reference the previewer would come up and then blank the first time it asked for its item
   again, which is what happens on a rotation or a page turn.
   */
  private static var presenting: HermieQuickLook?

  private let url: URL
  private let title: String?

  private init(url: URL, title: String?) {
    self.url = url
    self.title = title
  }

  // MARK: - Presenting

  /**
   Show `uri`, and say whether it was shown.

   `false` rather than a throw for every refusal — an unreadable path, a type Quick Look has no
   previewer for, a download that failed, no window to present from. The caller's fallback is the
   share sheet, and a rejected promise there would mean a caller that has to tell an expected answer
   from a real failure by reading a message.
   */
  static func present(uri: String, title: String?) async -> Bool {
    guard let source = URL(string: uri) else {
      return false
    }

    let local: URL?

    if source.isFileURL {
      local = FileManager.default.isReadableFile(atPath: source.path) ? source : nil
    } else if source.scheme == "http" || source.scheme == "https" {
      local = await cached(from: source, title: title)
    } else {
      // A `data:`, `ph:` or `content:` URI is not something `QLPreviewController` reads, and
      // inventing a conversion for one nothing in this app produces would be code with no caller.
      local = nil
    }

    guard let local, QLPreviewController.canPreview(local as QLPreviewItem) else {
      return false
    }

    guard let host = topmostViewController() else {
      return false
    }

    let previewer = HermieQuickLook(url: local, title: title)
    let controller = QLPreviewController()

    controller.dataSource = previewer
    controller.delegate = previewer
    Self.presenting = previewer

    host.present(controller, animated: true)

    return true
  }

  /**
   A copy of a remote file in the caches directory, or nothing.

   Named after the URL's own last path component, or after the caller's filename when it has one,
   because Quick Look picks its previewer from the EXTENSION and a URL ending in `/download` would
   otherwise be previewed as nothing at all. Written under a per-fetch directory so two attachments
   with the same name cannot overwrite each other while both are open.
   */
  private static func cached(from source: URL, title: String?) async -> URL? {
    let name = (title?.isEmpty == false ? title : nil) ?? source.lastPathComponent
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(
      "quick-look/\(UUID().uuidString)",
      isDirectory: true
    )

    do {
      let (data, response) = try await URLSession.shared.data(from: source)

      if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        return nil
      }

      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

      let file = folder.appendingPathComponent(name.isEmpty ? "attachment" : name)

      try data.write(to: file, options: .atomic)

      return file
    } catch {
      return nil
    }
  }

  /**
   The controller a modal should be presented from.

   The key window's root, walked down through whatever it is already presenting. Anything less
   presents from underneath a bottom sheet — or throws, because a controller that is already
   presenting cannot present again.
   */
  private static func topmostViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }

    guard var controller = window?.rootViewController else {
      return nil
    }

    while let presented = controller.presentedViewController {
      controller = presented
    }

    return controller
  }

  // MARK: - QLPreviewControllerDataSource

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    Item(url: url, title: title)
  }

  // MARK: - QLPreviewControllerDelegate

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    // The previewer is gone, so the only reason to hold this object is gone with it. A cached copy
    // is left where it is: it is in the temporary directory, the system reclaims it, and deleting it
    // here would race a "Save to Files" the reader started from inside the preview.
    if Self.presenting === self {
      Self.presenting = nil
    }
  }

  /**
   One item, with the name the app knows rather than the one the path happens to carry.

   `QLPreviewItem` is a protocol on `NSObject`, and `URL` conforms to it already — but a bare URL
   titles the preview with its last path component, which for a cached copy is a name this class
   invented. The app has the real filename; this is where it goes.
   */
  private final class Item: NSObject, QLPreviewItem {
    let previewItemURL: URL?
    let previewItemTitle: String?

    init(url: URL, title: String?) {
      previewItemURL = url
      previewItemTitle = title?.isEmpty == false ? title : nil
    }
  }
}
