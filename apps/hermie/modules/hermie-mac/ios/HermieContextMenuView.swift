import ExpoModulesCore
import UIKit

/**
 A view whose secondary click — and whose long press — opens the PLATFORM's context menu.

 This exists because React Native has no secondary-click event at all. `Pressable` offers
 `onLongPress` and nothing else, so before this the chat list's row menu could only be a bottom
 sheet opened by a press and hold: a right click on a Mac or an iPad trackpad did not reach the app,
 and the sheet that did open was our own drawing rather than the menu the rest of the system uses.

 `UIContextMenuInteraction` is the whole answer, and it is worth being explicit about what comes
 free with it, because every one of these is something a custom sheet would have had to reimplement
 and get wrong:

 - a secondary click opens it immediately, a press and hold opens it after the system's own delay,
   and a trackpad's secondary click counts as the former;
 - the menu is the system's glass, at the system's size, in the system's position — including
   flipping above the row near the bottom of a window;
 - arrow keys move the highlight, Return selects, Escape dismisses, and none of that is our code;
 - the view under the pointer lifts into a preview, which is what makes "this menu belongs to THAT
   row" legible without a title.

 ## Children, and why this is a plain `ExpoView`

 The view draws nothing itself. It is a host: React lays its children out through Fabric exactly as
 it would inside a `View`, and the interaction is attached to the host. So the call site wraps what
 it already had rather than replacing it, and the fallback path is the same tree with the wrapper
 taken away.

 ## The menu is built on every open, not on every prop change

 `items` is stored and the `UIMenu` is assembled inside the action provider. A chat row's menu
 carries the row's own state — which colour is ticked, whether it says Archive or Unarchive, which
 sections exist — and that state changes while the menu is closed far more often than the menu is
 opened. Building late means the menu cannot be stale; building early would mean holding a
 `UIMenu` that has to be invalidated by hand.

 ## What it deliberately does not do

 There is no `onOpen`/`onClose` pair. Nothing in the app needs to know, and a JavaScript round trip
 per open is a round trip that can arrive after the menu has already gone.
 */
public final class HermieContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  private let onSelect = EventDispatcher()

  private var items: [HermieMenuNode] = []
  private var menuTitle = ""
  private var enabled = true

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    addInteraction(UIContextMenuInteraction(delegate: self))
  }

  func setItems(_ raw: [Any]) {
    items = HermieMenuNode.parse(raw)
  }

  func setMenuTitle(_ title: String?) {
    menuTitle = title ?? ""
  }

  func setEnabled(_ value: Bool) {
    enabled = value
  }

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    // No items is not an empty menu, it is no menu: returning a configuration would put an empty
    // grey rectangle under the pointer and swallow the gesture.
    guard enabled, !items.isEmpty else {
      return nil
    }

    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else {
        return nil
      }

      return UIMenu(
        title: self.menuTitle,
        children: self.items.map { node in
          node.element { id in
            // The dictionary is the event payload; `id` is what the call site switches on.
            self.onSelect(["id": id])
          }
        }
      )
    }
  }
}
