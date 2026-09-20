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

 **`devLaunchArguments`** is the fourth thing, and the only one that is not about keyboards. It is
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

    Events("onEscape")

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
    }

    OnDestroy {
      if let observer = self.connectObserver {
        NotificationCenter.default.removeObserver(observer)
        self.connectObserver = nil
      }
      GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = nil
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

    input.keyChangedHandler = { [weak self] _, _, keyCode, pressed in
      guard pressed, keyCode == .escape else {
        return
      }

      // HID state does not care which app is in front. Without this guard, a keystroke meant for
      // another window could dismiss a sheet nobody is looking at.
      guard UIApplication.shared.applicationState == .active else {
        return
      }

      self?.sendEvent("onEscape", [:])
    }
  }
}
