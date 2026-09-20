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
public final class HermieContextMenuView: ExpoView, UIContextMenuInteractionDelegate, UIPointerInteractionDelegate {
  private let onSelect = EventDispatcher()

  private var items: [HermieMenuNode] = []
  private var menuTitle = ""
  private var enabled = true
  private var hoverEffect = true
  private var cornerRadius: CGFloat = 0

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    addInteraction(UIContextMenuInteraction(delegate: self))
    // Ours, and it is what gives `hoverEffect` somewhere to be answered. A view with no pointer
    // interaction of its own inherits whatever the context-menu interaction decides to draw under
    // the pointer; with one, this delegate is asked first and can say "nothing".
    addInteraction(UIPointerInteraction(delegate: self))
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

  /**
   Whether the pointer may draw anything on this view while it merely passes over.

   ON for a LIST ROW, which is what this view was built for: a chat row, a cron row, a bot in the
   sidebar. A row-sized highlight under the pointer is what tells a reader the row is a thing they
   can act on, and it is the same effect the rest of the system draws.

   OFF for a TRANSCRIPT row, and the owner's report is why: a transcript row is as wide as the
   window and as tall as a reply, so the same effect is a blurred platter the size of the message,
   appearing and disappearing as the mouse crosses the conversation. Nothing about a paragraph of
   text is a button, and a reader moving the pointer towards the composer should not set off a
   highlight on the way past.

   Two levers, because the effect has two halves: the pointer style, answered below, and the
   highlight preview UIKit composites behind the view — which is the blur itself, and is cleared by
   handing back preview parameters with no background.
   */
  func setHoverEffect(_ value: Bool) {
    hoverEffect = value
  }

  public func pointerInteraction(
    _ interaction: UIPointerInteraction,
    styleFor region: UIPointerRegion
  ) -> UIPointerStyle? {
    guard hoverEffect else {
      // NOT `UIPointerStyle.hidden()`, which hides the CURSOR — over a wall of text the cursor is
      // the one thing that must stay. An empty style is "the system arrow, and no effect".
      return UIPointerStyle(shape: nil, constrainedAxes: [])
    }

    return nil
  }

  /**
   The corners the platter is cut to, when there is one.

   UIKit's default highlight is a RECTANGLE around the whole host view, and the owner's report is
   what that looks like on a chat row: a square grey block under a row whose own selected state is a
   rounded pill. The row knows its radius and this view does not, so the row hands it over — the
   same `radii.card` its selected surface uses, which is what makes the two states look like one
   control in two moods.

   Zero means "no radius given", and the platter keeps UIKit's square default.
   */
  func setCornerRadius(_ value: Double?) {
    cornerRadius = value.map { CGFloat($0) } ?? 0
  }

  /**
   The platter UIKit draws behind the view while the menu is coming up — and, on a pointer, while
   the pointer is merely over it.

   `nil` hands back UIKit's own: the whole view, on a SQUARE background. Preview parameters are the
   only way to change either half, so both `hoverEffect` and `cornerRadius` are answered here.
   */
  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    // No effect at all, and no radius worth having: leave UIKit its default.
    guard !hoverEffect || cornerRadius > 0 else {
      return nil
    }

    let parameters = UIPreviewParameters()

    // Clear where the effect is off — nothing is drawn behind the view at all. Where it is ON, the
    // platter stays and only its corners change, because the platter IS the affordance on a row.
    if !hoverEffect {
      parameters.backgroundColor = .clear
    }

    parameters.visiblePath =
      cornerRadius > 0
        ? UIBezierPath(roundedRect: bounds, cornerRadius: cornerRadius)
        : UIBezierPath(rect: bounds)

    return UITargetedPreview(view: self, parameters: parameters)
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
