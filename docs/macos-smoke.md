# macOS smoke checklist

The macOS project is maintained by hand, so it does not get the safety net that continuous native
generation gives iOS and Android. Walk this list after changing anything under `apps/hermie/macos/`,
after a dependency bump that touches a native module, and before tagging a release.

Ticking a box means you saw it happen. Write down what you skipped.

## Build

- [ ] `npm ci` at the repository root completes.
- [ ] `cd apps/hermie/macos && pod install` completes without a version conflict. Run it after
      **every** `npm ci` or `npm install`: the Pods project points into `node_modules`, and a stale
      one fails deep inside a dependency rather than at the project level.
- [ ] `Podfile.lock` gained or lost pods only where you expected it to.
- [ ] `xcodebuild -workspace Hermie.xcworkspace -scheme Hermie-macOS -configuration Debug build`
      succeeds.
- [ ] The build produced no new warnings about deployment targets.

## Launch

- [ ] `npm run start --workspace @hermie/app` is running before you launch a Debug build.
- [ ] The app launches and shows a window with content — not an empty grey window. An empty window
      with no error usually means the registered root component name and `moduleName` in
      `AppDelegate.mm` disagree.
- [ ] The Metro log shows a `macos` bundle being served to the app.
- [ ] No red box on launch.
- [ ] The window title is "Hermie" and the app appears in the Dock under that name.

## Layout

- [ ] The sidebar and the detail pane are both visible.
- [ ] Resizing the window reflows the detail pane and leaves the sidebar at its fixed width.
- [ ] Making the window very narrow does not switch to the phone layout — macOS is always the
      regular shell.
- [ ] Switching the system appearance between light and dark changes the app's colours without a
      restart.

## Input

- [ ] Text can be typed into a text field, and the system keyboard shortcuts work: select all, copy,
      paste, undo.
- [ ] Tab moves focus between controls.
- [ ] Scrolling with a trackpad and with a mouse wheel both work in a long list.
- [ ] Clicking a sidebar item changes the detail pane.

## Native modules

Only check what the current milestone actually uses.

- [ ] Key-value storage survives a relaunch (AsyncStorage).
- [ ] Secret storage reads back what it wrote **within one run**. It is expected _not_ to survive a
      relaunch securely on macOS — see `docs/platform-notes.md`.
- [ ] The SQLite cache opens and reads back a row.
- [ ] A web view loads a page.

## Housekeeping

- [ ] `git status` shows no unexpected changes under `apps/hermie/macos/` — in particular no
      `Pods/`, no `xcuserdata/`, no `build/`.
- [ ] Anything you changed in the macOS project is reflected in `docs/platform-notes.md`.
