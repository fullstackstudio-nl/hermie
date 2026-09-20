import ExpoModulesCore
import GameController
import UIKit

/**
 The three things JavaScript cannot find out for itself about a desktop keyboard.

 **`isMac`** — whether this process is the iOS app running on an Apple Silicon Mac.
 `ProcessInfo.processInfo.isiOSAppOnMac` is the only API that answers it, and React Native exposes
 nothing equivalent: `Platform.isMacCatalyst` reads the compile-time `TARGET_OS_MACCATALYST` flag,
 which is false for the unmodified iOS binary macOS runs as "Designed for iPad". A constant, because
 the answer is fixed for the lifetime of the process and the first render already needs it.

 **`isShiftDown`** — read synchronously while handling a Return, to tell Shift+Return from Return.
 UIKit will not say: a text field's `onKeyPress` payload carries no modifier state on iOS, and by the
 time it fires the insertion has already been accepted. GameController answers from the HID state
 instead, which is independent of the responder chain and of what happens to be first responder.

 **`onEscape`** — for the same reason, inverted. Escape inserts no text, so it never reaches a
 `UITextView` delegate at all, and a `UIKeyCommand` would have to live in the responder chain, which a
 presented `Modal` leaves — exactly the case that matters most, since a sheet is the main thing Escape
 should close. `keyChangedHandler` is below all of that.

 Nothing here needs an entitlement or an Info.plist key; GameController only asks to be linked, which
 the podspec does.

 **`onShortcut`** is the same mechanism as `onEscape`, widened to an allow-list of desktop
 shortcuts — ⌘K, ⌘,, ⌘W, ⌘1…9, ⌘↑/↓ and ⌃Tab. It is deliberately NOT a general key event: nothing
 is emitted unless Command (or Control, for Tab) is held, so ordinary typing never crosses into
 JavaScript and a keystroke cannot be read off this seam. GameController rather than `UIKeyCommand`
 for the same reason Escape is: a presented `Modal` leaves the responder chain, and a shortcut that
 stops working while a sheet is open is a shortcut nobody trusts. The menu bar's own items reach the
 same place — see `HermieMenuBar`.

 **`devLaunchArguments`** is the fifth thing, and the only one that is not about keyboards. It is
 this process's own `ProcessInfo.processInfo.arguments`, which is how `xcrun simctl launch` can tell a
 running app to open on a particular screen — see `src/dev/launch-intent.ts` and the "Driving a
 simulator" section of docs/platform-notes.md. It is inside `#if DEBUG`, so a Release build has no
 such constant: the array is not merely empty, the key is absent, and `launch-intent.ts` then has
 nothing to read even before `__DEV__` gates it. That is deliberate belt and braces — a screen-opening
 back door is not something to leave one flag away from a shipped build.
 */
public class HermieMacModule: Module {
  private var connectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("HermieMac")

    Events("onEscape", "onShortcut")

    #if DEBUG
      Constants([
        "isMac": ProcessInfo.processInfo.isiOSAppOnMac,
        "devLaunchArguments": ProcessInfo.processInfo.arguments
      ])
    #else
      Constants([
        "isMac": ProcessInfo.processInfo.isiOSAppOnMac
      ])
    #endif

    OnCreate {
      self.watchForKeyboards()

      // The menu bar's items and the keyboard's shortcuts are the same actions, so they land on the
      // same event. `install()` is a no-op anywhere but a Mac, where the menu bar exists.
      HermieMenuBar.onCommand = { [weak self] action in
        self?.sendEvent("onShortcut", ["action": action])
      }
      HermieMenuBar.install()
    }

    OnDestroy {
      if let observer = self.connectObserver {
        NotificationCenter.default.removeObserver(observer)
        self.connectObserver = nil
      }
      GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = nil
      HermieMenuBar.onCommand = nil
    }

    /**
     A secondary click's menu, as the platform draws it. See `HermieContextMenuView`.

     `items` is `[Any]` rather than a typed record because a menu is a tree; `HermieMenuNode` walks
     it. A malformed node is dropped rather than thrown: a menu with one line missing is recoverable
     and a chat list that throws while rendering a row is not.
     */
    View(HermieContextMenuView.self) {
      Events("onSelect")

      Prop("items") { (view: HermieContextMenuView, items: [Any]?) in
        view.setItems(items ?? [])
      }

      Prop("menuTitle") { (view: HermieContextMenuView, title: String?) in
        view.setMenuTitle(title)
      }

      Prop("enabled") { (view: HermieContextMenuView, enabled: Bool?) in
        view.setEnabled(enabled ?? true)
      }
    }

    /**
     The Hermie menu in the Mac's menu bar, spelled in the app's own language.

     Titles rather than a structure: the shape is fixed and lives in `HermieMenuBar`, and what
     JavaScript owns is the wording and which chats are visible. Async because it asks UIKit to
     rebuild the menu bar.
     */
    AsyncFunction("setMenuBar") { (titles: [String: String], chats: [String]) -> Void in
      HermieMenuBar.setMenuBar(titles: titles, chats: chats)
    }
    .runOnQueue(.main)

    /** Whether the menu bar hook reached the app delegate's class. Reported on the developer screen. */
    Function("isMenuBarInstalled") { () -> Bool in
      HermieMenuBar.isInstalled
    }

    /**
     Put text on the pasteboard.

     Here rather than through React Native's `Clipboard`, which is extracted from core and logs a
     deprecation warning on first access, and rather than through a new dependency for two lines of
     UIKit. The context menus' Copy items are the only callers.
     */
    Function("setClipboardString") { (text: String) -> Void in
      UIPasteboard.general.string = text
    }

    /**
     Whether either Shift key is down right now.

     Polled rather than pushed, deliberately: the caller already knows a Return happened and only
     needs the modifier that went with it, and a pushed modifier event would have to be raced against
     the Return it belongs to. `false` when nothing is plugged in, which is the honest answer on a
     phone and the reason this needs no platform check of its own.
     */
    Function("isShiftDown") { () -> Bool in
      guard let input = GCKeyboard.coalesced?.keyboardInput else {
        return false
      }

      return input.button(forKeyCode: .leftShift)?.isPressed == true
        || input.button(forKeyCode: .rightShift)?.isPressed == true
    }

    /** Whether a hardware keyboard is attached at all. Reported on the developer screen. */
    Function("hasHardwareKeyboard") { () -> Bool in
      GCKeyboard.coalesced?.keyboardInput != nil
    }

    /**
     Stop a MOUSE drag from scrolling the scroll view behind `viewTag`, without touching the wheel.

     On a Mac the owner drags across the transcript expecting to select text, and the list pans
     instead. That is UIKit doing what it is told: a "Designed for iPad" app gets full pointer
     support, an indirect-pointer drag is delivered to `UIScrollView` as a touch, and
     `panGestureRecognizer` accepts every touch type by default — so press-and-drag scrolls.

     Restricting `allowedTouchTypes` to `.direct` is the whole fix. It is the narrowest lever
     available: it tells that ONE recognizer to ignore a pointer while still accepting a finger, and
     a mouse wheel or a trackpad two-finger scroll never reaches it at all. Those arrive as scroll
     events, gated by `allowedScrollTypesMask`, which this does not touch — which is why the fix can
     stop the drag without also breaking the way everybody actually scrolls.

     Runs on the main queue because it reads the view registry and mutates a view. Returns whether a
     scroll view was actually found, so the caller can be tested and the developer screen can say.
     Never throws: a tag that resolves to nothing is a `false`, not an error, because this is called
     from a `ref` callback during layout and a broken reading surface is worse than an unfixed drag.
     */
    AsyncFunction("useDirectTouchPanOnly") { (viewTag: Int) -> Bool in
      guard let view = self.appContext?.findView(withTag: viewTag, ofType: UIView.self),
            let scrollView = Self.scrollView(for: view) else {
        return false
      }

      scrollView.panGestureRecognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]

      return true
    }
    .runOnQueue(.main)
  }

  /**
   The `UIScrollView` a React Native scroll component's view tag stands for.

   The tag belongs to the wrapper, not to the scroller: under Fabric it resolves to
   `RCTScrollViewComponentView`, whose single subview is the `RCTEnhancedScrollView` that actually
   scrolls, and under the old renderer to `RCTScrollView` with the same shape one level down. Both are
   covered by taking the SHALLOWEST `UIScrollView` at or below the tagged view.

   Shallowest, and depth-capped, on purpose. A transcript row can hold scroll views of its own — a
   wide code block, a markdown table — and an unbounded search would hand back one of those instead of
   the list, which would leave the list panning and quietly break the code block as well.
   */
  private static func scrollView(for view: UIView) -> UIScrollView? {
    if let scrollView = view as? UIScrollView {
      return scrollView
    }

    var level = view.subviews

    for _ in 0..<2 {
      if let scrollView = level.first(where: { $0 is UIScrollView }) as? UIScrollView {
        return scrollView
      }

      level = level.flatMap { $0.subviews }
    }

    return nil
  }

  /**
   A keyboard can arrive after launch — an iPad in a case, a Mac waking a Bluetooth keyboard — and the
   handler belongs to the keyboard rather than to the app, so it has to be reinstalled when one
   connects. All keyboards coalesce into a single object, so this fires once rather than per device.
   */
  private func watchForKeyboards() {
    connectObserver = NotificationCenter.default.addObserver(
      forName: NSNotification.Name.GCKeyboardDidConnect,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.installEscapeHandler()
    }

    installEscapeHandler()
  }

  private func installEscapeHandler() {
    guard let keyboard = GCKeyboard.coalesced, let input = keyboard.keyboardInput else {
      return
    }

    // The handler would otherwise run on GameController's own queue, and the event crosses into
    // JavaScript from here.
    keyboard.handlerQueue = .main

    input.keyChangedHandler = { [weak self] keyboardInput, _, keyCode, pressed in
      guard pressed else {
        return
      }

      // HID state does not care which app is in front. Without this guard, a keystroke meant for
      // another window could dismiss a sheet nobody is looking at.
      guard UIApplication.shared.applicationState == .active else {
        return
      }

      if keyCode == .escape {
        self?.sendEvent("onEscape", [:])

        return
      }

      if let action = Self.shortcut(for: keyCode, input: keyboardInput) {
        self?.sendEvent("onShortcut", ["action": action])
      }
    }
  }

  /**
   The one desktop shortcut this key press stands for, or nothing.

   An ALLOW-LIST, and the reason is privacy rather than tidiness: this handler sees every key on the
   keyboard, below the responder chain and regardless of what is focused. Requiring a modifier and
   then matching a fixed table means a password typed into the composer produces no events at all —
   there is no path from a letter to JavaScript through here.

   Shift disqualifies everything. ⌘⇧K is not ⌘K, and a shortcut that fires for both would steal a
   keystroke some other part of the app may want later.

   ⌃Tab is the one non-Command entry, because that is what it is on every platform.
   */
  private static func shortcut(for keyCode: GCKeyCode, input: GCKeyboardInput) -> String? {
    func down(_ codes: GCKeyCode...) -> Bool {
      codes.contains { input.button(forKeyCode: $0)?.isPressed == true }
    }

    if down(.leftShift, .rightShift) {
      return nil
    }

    if keyCode == .tab, down(.leftControl, .rightControl) {
      return "nextChat"
    }

    guard down(.leftGUI, .rightGUI) else {
      return nil
    }

    switch keyCode {
    case .keyK:
      return "search"
    case .comma:
      return "settings"
    case .keyW:
      return "close"
    case .upArrow:
      return "previousChat"
    case .downArrow:
      return "nextChat"
    case .one:
      return "chat1"
    case .two:
      return "chat2"
    case .three:
      return "chat3"
    case .four:
      return "chat4"
    case .five:
      return "chat5"
    case .six:
      return "chat6"
    case .seven:
      return "chat7"
    case .eight:
      return "chat8"
    case .nine:
      return "chat9"
    default:
      return nil
    }
  }
}
