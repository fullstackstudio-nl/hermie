import UIKit

/**
 Whether the window the reader is looking at is the one they are working in.

 On a phone this is a question with one answer. On a Mac it is the difference the owner photographed:
 click another app and Hermie's chrome visibly changes, because a `UIVisualEffectView` — which is
 what both glass materials in this app are — takes its appearance from the window it is in, and a
 window that is not key is drawn with the dimmed variant of that material. Nothing in the app asks
 for that and nothing in the app can style it.

 ## The API that does not exist

 Looked for rather than assumed, in the iOS 27 SDK this app builds against:

 - `UIVisualEffectView` (`UIVisualEffectView.h`) has exactly three members — `contentView`, `effect`
   and the designated initialiser. There is no state, no appearance mode, and nothing about window
   activation.
 - `UIGlassEffect` (`UIGlassEffect.h`, iOS 26) has `interactive`, `tintColor` and `init(style:)`.
   Again nothing.
 - Nothing anywhere in `UIKit.framework/Headers` names an inactive appearance. AppKit's equivalent
   knob is `NSVisualEffectView.state = .active`, and an app running as "Designed for iPad" has no
   AppKit surface to reach it through: it is an unmodified iOS binary, so `TARGET_OS_MACCATALYST` is
   false and `NSApplication` is not linked.

 So a visual effect view cannot be told to ignore window inactivity, and the only lever left is not
 to have one on screen while the window is inactive. That decision is made in JavaScript, in
 `GlassSurface`, because the fallback it switches to is the app's own elevation ladder and the ladder
 is defined there. This class only reports the fact.

 ## What it reports, and where the fact comes from

 `UIScene.activationState`. The scene life cycle is the app's since `hermie-scene`, and
 `foregroundActive` is precisely "this window is the one receiving events". Four notifications move
 it, and all four are observed rather than only the pair that looks sufficient: on a Mac a window
 that is merely behind another reports `foregroundInactive` (`willDeactivate`), while one that is
 minimised or on another Space reports `background` — and a build that watched only the deactivate
 pair would come back from a minimise still believing it was inactive.

 ## Mac only, deliberately

 `foregroundInactive` is a state every iPhone enters several times a minute: the Control Centre
 sheet, the notification shade, an incoming call banner, the app switcher. Reporting those would
 make the glass on a phone blink to its solid rung every time somebody pulled down the shade, which
 is the very bug this exists to stop — one platform over. So off a Mac the answer is the constant
 `true` and no observer is installed at all.
 */
final class HermieWindowActivity {
  static let shared = HermieWindowActivity()

  /// Called on the main queue whenever the answer changes. Never called for a repeat of the same value.
  var onChange: ((Bool) -> Void)?

  /// True on every platform that is not a Mac, and on a Mac while the window is key.
  private(set) var isActive = true

  private var observers: [NSObjectProtocol] = []

  /**
   Only a Mac has a window that can stop being key while the app stays on screen.

   A stored constant rather than a call per notification: `isiOSAppOnMac` is fixed for the life of
   the process and this is read on a path that also runs during scene transitions.
   */
  private let runsOnMac = ProcessInfo.processInfo.isiOSAppOnMac

  private init() {}

  /// Idempotent: the module calls this from `OnCreate`, which a Fast Refresh can run again.
  func start() {
    guard runsOnMac, observers.isEmpty else {
      return
    }

    for name in [
      UIScene.didActivateNotification,
      UIScene.willDeactivateNotification,
      UIScene.didEnterBackgroundNotification,
      UIScene.willEnterForegroundNotification
    ] {
      observers.append(
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          self?.refresh()
        }
      )
    }

    refresh()
  }

  func stop() {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }

    observers = []
    onChange = nil
  }

  /**
   Any foreground-active window scene means the app is the one in front.

   ANY rather than "the key window's": an iPad in Split View and a Mac with two Hermie windows both
   have more than one scene, and the material is a process-wide decision here — a second window that
   is still key is a window whose glass must not drop to a solid rung because the first one lost
   focus.
   */
  private func refresh() {
    let active = UIApplication.shared.connectedScenes.contains { $0.activationState == .foregroundActive }

    guard active != isActive else {
      return
    }

    isActive = active
    onChange?(active)
  }
}
