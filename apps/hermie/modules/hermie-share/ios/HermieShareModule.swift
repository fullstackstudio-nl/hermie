import ExpoModulesCore

/**
 The app's half of "Share to Hermie": pick up what another process left behind.

 The exact mirror of `HermieWidgetsModule`, and deliberately just as dumb. That
 one puts bytes where a widget can read them; this one reads bytes a share
 extension wrote and deletes them once the app has finished with them. Neither
 decodes anything: the JSON here is handed straight to
 `src/features/share/outbox.ts`, which is pure and tested, and which is where
 every question about what a manifest MEANS is answered.

 Two things follow from that, and both are the point:

  - **There is no shared Swift between this module and the extension.** The file
    format is the contract, it is versioned, and it is written down in
    TypeScript. A `HermieShareOutbox` exists on both sides because both sides
    need to spell the directory names, not because either understands the other.
  - **A manifest this build cannot read is the app's problem, not this
    module's.** Everything here answers a value, including the failures — no
    container, an unreadable directory, a file that vanished between the listing
    and the read. A share that cannot be delivered is a badge; an app that
    crashed on launch because a share sheet wrote something odd is a bug.

 **Nothing here throws.** `listShares()` answers `[]` and `clearShare()` answers
 `false`. The one thing that must never happen is a launch failing because of
 something another application put in a directory.
 */
public class HermieShareModule: Module {
  /**
   The App Group, spelled once — and for the fourth time in this repository.

   It has to match `plugin/with-hermie-share.js`, the extension's entitlements
   and `hermie-widgets`' copy of the same string exactly, and there is no
   compiler that will say so. Both plugins assert the pairing from the other
   side by refusing to build when an entitlements file names something else.
   */
  private static let appGroup = "group.dev.hermie.app"

  /** Also spelled in `outbox.ts` as `SHARE_OUTBOX_DIRECTORY`. */
  private static let outboxDirectory = "share-outbox"

  /** Also spelled in `outbox.ts` as `SHARE_MANIFEST_FILE`. */
  private static let manifestFile = "manifest.json"

  /**
   A ceiling on how much of somebody else's JSON is read into memory.

   A manifest is a few hundred bytes. Anything past this is not a manifest this
   app wrote, and reading it would be reading an arbitrary file another process
   put in the container under a name we chose to trust.
   */
  private static let maxManifestBytes = 256 * 1024

  public func definition() -> ModuleDefinition {
    Name("HermieShare")

    /**
     Every entry waiting, with its files already resolved to local URLs.

     The files are resolved HERE rather than in JavaScript because only this
     side knows where the container is — and because the alternative is handing
     JavaScript a container path and letting it join, which is the same as
     handing it a way to name any file on the device.

     A directory with no readable manifest is skipped rather than deleted. It
     may be an entry a newer build wrote, or one mid-write by an extension that
     is still running: `clearShare` is the only thing that removes anything, and
     it is only ever called for an entry JavaScript has finished with.
     */
    AsyncFunction("listShares") { () -> [[String: Any]] in
      guard let outbox = Self.outbox() else {
        return []
      }

      let manager = FileManager.default

      guard let directories = try? manager.contentsOfDirectory(
        at: outbox,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      ) else {
        return []
      }

      var entries: [[String: Any]] = []

      for directory in directories {
        guard (try? directory.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else {
          continue
        }

        let manifestURL = directory.appendingPathComponent(Self.manifestFile)

        guard let attributes = try? manager.attributesOfItem(atPath: manifestURL.path),
          let size = attributes[.size] as? Int, size > 0, size <= Self.maxManifestBytes,
          let data = try? Data(contentsOf: manifestURL),
          let manifest = String(data: data, encoding: .utf8) else {
          continue
        }

        var files: [String: String] = [:]

        for file in (try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
          let name = file.lastPathComponent

          if name != Self.manifestFile {
            files[name] = file.absoluteString
          }
        }

        entries.append(["id": directory.lastPathComponent, "manifest": manifest, "files": files])
      }

      return entries
    }

    /**
     Delete one entry and everything in it.

     Called after the message has actually been sent, never before — see the
     note in `share-delivery.ts` about which way that gap has to fail.

     The id is checked against the same rule `outbox.ts` applies, because it has
     come back through JavaScript and a directory name is a path component: a
     `..` here is a request to delete something outside the outbox. It is
     compared against the directory's own listing rather than trusted, which
     makes the check total rather than a regular expression somebody has to keep
     in step.
     */
    AsyncFunction("clearShare") { (id: String) -> Bool in
      guard let outbox = Self.outbox() else {
        return false
      }

      let manager = FileManager.default

      guard let directories = try? manager.contentsOfDirectory(
        at: outbox,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
      ), let target = directories.first(where: { $0.lastPathComponent == id }) else {
        return false
      }

      return (try? manager.removeItem(at: target)) != nil
    }

    /**
     Whether a container was actually obtained. Reported on the developer screen.

     The same question — and the same silent failure — as
     `HermieWidgetsModule.hasSharedContainer`: the module is linked into every
     iOS build, and the container is nil whenever the App Group entitlement did
     not make it onto the signed binary. Without this, that is indistinguishable
     from an empty outbox.
     */
    Function("hasSharedContainer") { () -> Bool in
      Self.container() != nil
    }
  }

  private static func container() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
  }

  /** The outbox directory, or nil. Never created here: only a sharer creates one. */
  private static func outbox() -> URL? {
    guard let container = container() else {
      return nil
    }

    let outbox = container.appendingPathComponent(outboxDirectory, isDirectory: true)

    return FileManager.default.fileExists(atPath: outbox.path) ? outbox : nil
  }
}
