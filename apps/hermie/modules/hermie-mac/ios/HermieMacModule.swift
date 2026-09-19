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
