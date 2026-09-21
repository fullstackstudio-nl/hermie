import Foundation
import SwiftUI

/**
 The file the app writes, as the extension reads it.

 This is the whole of what a widget knows. There is no gateway here, no socket, no keychain and no
 store: the extension wakes up, reads one JSON file out of the App Group container, draws, and is
 killed again. Everything derived — presence, unread, the clipped last line, the colour initials are
 drawn on — was derived in `src/features/widgets/snapshot.ts` while the app still had the state to
 derive it from, which is why there is no logic in this file beyond decoding and defaulting.

 ## The version check is the point of the version field

 An old extension against a new snapshot is not an edge case, it is what every app update looks
 like for the few minutes before iOS reloads the installed extension. So a snapshot whose `version`
 is not the one this binary understands is treated as no snapshot at all, and the widget draws its
 empty state. Half a row drawn from fields that moved is worse than a line saying "Open Hermie".

 ## Everything optional, nothing fatal

 Each field has a default, and `bots` is the only one whose absence empties the widget. A snapshot
 written by a newer app with a field this binary has never heard of decodes fine and ignores it —
 which is why adding an optional field does not need a version bump, and changing what an existing
 one MEANS does.
 */
struct HermieSnapshot: Decodable {
  /** Bumped in `snapshot.ts`; anything else is drawn as "no snapshot". */
  static let supportedVersion = 1

  let version: Int
  let generatedAt: Double
  let bots: [HermieBot]

  static let empty = HermieSnapshot(version: supportedVersion, generatedAt: 0, bots: [])

  var isUsable: Bool {
    version == Self.supportedVersion
  }

  /** How many bots are waiting on a person — the whole content of the accessory widgets. */
  var needsInputCount: Int {
    bots.filter(\.needsInput).count
  }
}

struct HermieBot: Decodable, Identifiable, Hashable {
  /** The profile name, which is also what `hermie://chat/<bot>` carries. */
  let name: String
  let displayName: String
  /** Relative to the container, when the app has actually written the file. */
  let avatarPath: String?
  let initials: String
  /** Hex from the app's own accent table. White on it is AA; see `snapshot.ts`. */
  let colour: String
  let presence: String
  let lastLine: String
  /** Unix seconds, as the gateway reports `last_active`. */
  let lastAt: Double
  let unread: Int
  let needsInput: Bool

  var id: String { name }

  /**
   Where a tap goes.

   The name is escaped because it is going into a URL path and a profile can be called anything.
   `snapshot.ts` refuses a link whose decoded name contains a slash, so a name that would need one
   simply never opens — which is the right failure for a surface with no way to report one.
   */
  var chatURL: URL? {
    let escaped = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/")))

    return URL(string: "hermie://chat/\(escaped ?? name)")
  }
}

/**
 Reads the snapshot and the avatars out of the shared container.

 Every failure answers the empty snapshot rather than throwing: a timeline provider has nowhere to
 report an error to, and a widget with nothing in it is a widget that says "Open Hermie", which is
 both true and actionable. The three reasons it can be empty are worth keeping apart in your head,
 because only the first is a bug: the App Group entitlement did not make it onto one of the two
 signed binaries; the app has never run since the widget was added; or the version moved.
 */
enum HermieWidgetStore {
  /** Must match `HermieWidgetsModule.appGroup` and both entitlement files. */
  static let appGroup = "group.dev.hermie.app"

  static func load() -> HermieSnapshot {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
      let data = try? Data(contentsOf: container.appendingPathComponent("widget-snapshot.json")),
      let snapshot = try? JSONDecoder().decode(HermieSnapshot.self, from: data),
      snapshot.isUsable else {
      return .empty
    }

    return snapshot
  }

  /**
   One bot's picture, or nil.

   Read every time it is drawn rather than cached: a widget process is short-lived and killed for
   memory before it is killed for anything else, so a cache would be a way to be killed rather
   than a saving. The path came out of the snapshot, so it is already escaped; it is appended
   rather than joined with the file system's own resolution, and a path that climbs out of the
   container answers nil at `standardized` below rather than reading something it should not.
   */
  static func avatar(at path: String?) -> UIImage? {
    guard let path,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return nil
    }

    let url = container.appendingPathComponent(path).standardized

    guard url.path.hasPrefix(container.standardized.path) else {
      return nil
    }

    return UIImage(contentsOfFile: url.path)
  }
}
