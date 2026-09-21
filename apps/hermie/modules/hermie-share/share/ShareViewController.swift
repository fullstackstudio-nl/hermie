import SwiftUI
import UIKit
import UniformTypeIdentifiers

/**
 The share extension's entry point: load what was shared, ask which chat, write
 it down, hand over to the app.

 `@objc(ShareViewController)` is load-bearing. `Info.plist` names the principal
 class as a plain string and the loader looks it up in the Objective-C runtime;
 without the attribute a Swift class is registered as
 `HermieShareExtension.ShareViewController`, the lookup finds nothing, and the
 share sheet presents an empty panel with no error in any log.

 ## The four seconds

 A share extension is a separate process, presented over another application,
 and the system is willing to kill it. So the order here is: start loading the
 attachments immediately, draw the sheet while they load, and refuse "Send"
 until they have finished. An entry written before the loads complete is an
 entry with fewer files in it than the person selected — which is the one
 failure that looks like it worked.

 ## Why the files are copied twice

 `NSItemProvider` hands over a URL that is valid only inside its completion
 handler; it belongs to the system and may be reclaimed the moment the handler
 returns. So each attachment is copied into this process's own temporary
 directory as it arrives, and copied again into the App Group container if and
 when "Send" is tapped. The alternative — staging straight into the shared
 container and deleting on cancel — is one copy fewer and one leak more: a
 process that is killed between the two leaves bytes in a container nothing
 sweeps. The temporary directory is the system's to clean, and it cleans it.
 */
@objc(ShareViewController)
class ShareViewController: UIViewController {
  private var payloads: [HermieShareOutbox.Payload] = []
  private var loading = true
  private var hosting: UIHostingController<HermieShareSheet>?

  override func viewDidLoad() {
    super.viewDidLoad()

    // Before the sheet, so the loads and the roster read overlap rather than
    // queue: the roster is one small file and comes back immediately, and the
    // attachments are what anyone waits for.
    loadAttachments()
    present(bots: HermieShareRoster.load())
  }

  // MARK: - the sheet

  private func present(bots: [HermieShareBot]) {
    let sheet = HermieShareSheet(
      bots: bots,
      summary: summaryText,
      loading: loading,
      onSend: { [weak self] bot, note in self?.send(to: bot, note: note) },
      onCancel: { [weak self] in self?.cancel() }
    )

    if let hosting {
      // Re-rendered rather than re-presented: this is called again when the
      // loads finish, and swapping the whole controller would throw away
      // whatever the person had already typed or picked.
      hosting.rootView = sheet

      return
    }

    let controller = UIHostingController(rootView: sheet)

    addChild(controller)
    controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(controller.view)
    controller.didMove(toParent: self)
    hosting = controller
  }

  /** One line for the list's header: what is about to be sent. */
  private var summaryText: String {
    if loading {
      return "Preparing…"
    }

    let files = payloads.filter { if case .file = $0 { return true } else { return false } }.count

    if files == 1 {
      return "1 file"
    }

    if files > 1 {
      return "\(files) files"
    }

    return payloads.isEmpty ? "Nothing to send" : "A link or some text"
  }

  // MARK: - loading

  /**
   Every attachment of every input item, in the order the sharing app gave them.

   A `DispatchGroup` rather than a counter, and the results are collected into a
   dictionary keyed by position rather than appended: the providers finish in
   whatever order their bytes arrive, and a share of three screenshots that
   arrives in a different order every time is a share nobody can predict.
   */
  private func loadAttachments() {
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
      .prefix(HermieShareOutbox.itemLimit)

    guard !providers.isEmpty else {
      loading = false

      return
    }

    let group = DispatchGroup()
    let lock = NSLock()
    var loaded: [Int: HermieShareOutbox.Payload] = [:]

    for (index, provider) in providers.enumerated() {
      group.enter()

      load(provider) { payload in
        if let payload {
          lock.lock()
          loaded[index] = payload
          lock.unlock()
        }

        group.leave()
      }
    }

    group.notify(queue: .main) { [weak self] in
      guard let self else {
        return
      }

      self.payloads = loaded.keys.sorted().compactMap { loaded[$0] }
      self.loading = false
      self.present(bots: HermieShareRoster.load())
    }
  }

  /**
   One attachment, as whichever of the four kinds it is.

   The order of the checks is the whole of this function and it is not
   alphabetical. A file URL also conforms to `public.url`, and an image from
   Photos conforms to `public.data`, so asking the general questions first would
   classify almost everything as the most generic answer. Images are asked about
   first because an image is the thing this feature exists for and because it
   travels by a different road in the app — over the socket as bytes, resized —
   than a file does.
   */
  private func load(_ provider: NSItemProvider, completion: @escaping (HermieShareOutbox.Payload?) -> Void) {
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      copyFile(from: provider, typeIdentifier: UTType.image.identifier, isImage: true, completion: completion)

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
      copyFile(from: provider, typeIdentifier: UTType.movie.identifier, isImage: false, completion: completion)

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] value, _ in
        guard let self, let url = value as? URL else {
          completion(nil)

          return
        }

        completion(self.stage(url, name: url.lastPathComponent, isImage: false))
      }

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
        guard let url = value as? URL else {
          completion(nil)

          return
        }

        completion(.url(url.absoluteString))
      }

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
        guard let text = value as? String, !text.isEmpty else {
          completion(nil)

          return
        }

        completion(.text(text))
      }

      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
      copyFile(from: provider, typeIdentifier: UTType.data.identifier, isImage: false, completion: completion)

      return
    }

    completion(nil)
  }

  /**
   `loadFileRepresentation` gives a URL that dies with the completion handler.

   So the copy happens INSIDE it, synchronously, before anything returns. This
   is the one rule of that API and getting it wrong produces a file that exists
   while the share sheet is open and is gone by the time the app looks.
   */
  private func copyFile(
    from provider: NSItemProvider,
    typeIdentifier: String,
    isImage: Bool,
    completion: @escaping (HermieShareOutbox.Payload?) -> Void
  ) {
    provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, _ in
      guard let self, let url else {
        completion(nil)

        return
      }

      completion(self.stage(url, name: provider.suggestedName ?? url.lastPathComponent, isImage: isImage))
    }
  }

  /** Copy into this process's temporary directory, which the system sweeps. */
  private func stage(_ url: URL, name: String, isImage: Bool) -> HermieShareOutbox.Payload? {
    let safe = HermieShareOutbox.safeFileName(name)
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
      .appendingPathComponent(safe)

    do {
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try FileManager.default.copyItem(at: url, to: destination)
    } catch {
      return nil
    }

    return .file(url: destination, name: safe, isImage: isImage)
  }

  // MARK: - finishing

  /**
   Write the entry, ask the system to open the app, and get out of the way.

   The extension's request is completed whether or not the app could be opened,
   and that order matters: the entry is already on disk, so the share has
   HAPPENED — the app will find it at its next launch either way. Holding the
   sheet open to report that an `openURL` did not work would be reporting a
   latency problem as a failure.
   */
  private func send(to bot: HermieShareBot, note: String) {
    guard let identifier = HermieShareOutbox.write(bot: bot.name, note: note, payloads: payloads) else {
      // Nowhere to write means the App Group entitlement is missing from one of
      // the two signed binaries, and nothing this process does can fix it. The
      // share is abandoned rather than reported as sent.
      extensionContext?.cancelRequest(withError: NSError(domain: "dev.hermie.app.share", code: 1))

      return
    }

    if let url = URL(string: "hermie://share/\(identifier)") {
      openApp(url)
    }

    extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
  }

  private func cancel() {
    extensionContext?.cancelRequest(withError: NSError(domain: "dev.hermie.app.share", code: 0))
  }

  /**
   Open the app from inside an extension.

   `UIApplication.shared` is unavailable to an extension, so the application
   object is reached by walking the responder chain and asked through a selector.
   This is the long-standing idiom rather than a supported API, and the honest
   position is written here rather than assumed: if it stops working, the entry
   is STILL in the outbox and the app still delivers it at its next launch. The
   only thing lost is the immediacy, which is why nothing above branches on the
   result.

   `@discardableResult` for that reason, and the selector is built by name
   because the method it names is not one this target can reference.
   */
  @discardableResult
  private func openApp(_ url: URL) -> Bool {
    // `NSSelectorFromString` rather than `#selector`, because `#selector`
    // requires a method this target can name and the whole point is that it
    // cannot: `UIApplication.open(_:options:completionHandler:)` is marked
    // unavailable in an extension.
    let selector = NSSelectorFromString("openURL:")
    var responder: UIResponder? = self

    while let current = responder {
      if current.responds(to: selector) {
        current.perform(selector, with: url)

        return true
      }

      responder = current.next
    }

    return false
  }
}
