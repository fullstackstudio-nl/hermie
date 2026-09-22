# Hermie Desktop

`apps/desktop` is a downloadable Hermie client for macOS, Windows and Linux, built with Tauri 2 on
the system webview (WKWebView, WebView2, WebKitGTK). It is a shell: one window, one webview,
pointed at a Hermie Web instance an operator already runs. Why that shape and not a bundled export
that talks to a gateway directly is [ADR-0027](adr/0027-desktop-is-a-webview-over-hermie-web.md).

This page is filled in task by task, alongside the code. A section with nothing under it yet says
so rather than being left out — the same rule applies to
the manual test matrix at the bottom.

## What v1 does not do

- No direct gateway connection without Hermie Web; no address step; no native PKCE; no Cloudflare
  service token; no extra headers. Put Access in front of Hermie Web instead.
- No notifications while the app is not running; no Web Push in the shell.
- No multiple windows, no tabs, no per-gateway windows; no picture-in-picture of two gateways.
- No store distribution (Mac App Store, Microsoft Store, Snap, Flatpak, Homebrew cask, winget); no
  `.rpm`.
- No app lock / biometrics; no keychain; no proxy settings UI (the webview uses the system proxy).
- No translation of the shell's two pages beyond English (the app page is translated already).
- No Intel-only or ARM-only Mac build: one universal DMG.

## Running it locally

```sh
npm run fake-gateway -- --auth token --token demo   # or your own gateway
npm run web                                          # Hermie Web, defaults to 127.0.0.1:9120
HERMIE_WEB_URL=http://127.0.0.1:9120 npm run desktop # opens the shell on that address
```

`npm run desktop` is `tauri dev`; `npm run desktop:build` is `tauri build`. Without `HERMIE_WEB_URL`
set, the window opens on the bundled placeholder page (`connect.html`) instead — there is no gateway
list yet (Task 3 builds it); the environment variable is the only way in for now.

The Tauri CLI is a build-time tool, not an npm dependency the shared `node_modules` can carry (this
repository never runs `npm install` inside an agent worktree). Install it once with:

```sh
cargo install tauri-cli --version "^2" --locked
```

and either run `cargo tauri dev` / `cargo tauri build --debug` directly from `apps/desktop`, or, once
a real `npm install` has populated `node_modules/.bin/tauri` from `@tauri-apps/cli` in
`apps/desktop/package.json`, the `npm run desktop*` scripts above.

## The bridge

The API the page can call once it detects the shell (`hermie_shell_info`, `hermie_set_menu`,
`hermie_notify`, …), the origin guard, and the `window.__HERMIE_DESKTOP__` marker. Not built yet —
Task 2.

## Gateways

The connect page, the list of Hermie Web URLs, the Gateway menu. Not built yet — Task 3.

## Sign-in

The auth matrix (ungated, gateway password, gateway OAuth, the built-in OIDC issuer, Cloudflare
Access), one row per mode, dated. Not built yet — Task 4.

## Notifications

The decision table for when a live-connection event becomes an OS notification, and the badge.
Not built yet — Task 5.

## Menu bar, shortcuts, window state, deep links

Task 1 covers the Edit menu roles (Cut/Copy/Paste reaching the webview) and window state
persistence only — see the matrix below. The Chats menu built from the page's own shortcut table,
the rest of the native menu, and `hermie://` deep links are not built yet — Task 6.

## Files: drop, paste, picker, downloads, external links

Drag-and-drop, the picker, downloads and reveal, external links to the system browser. Not built
yet — Task 7 (paste is covered in Task 1's matrix below, since it is what the shell exists for).

## Known limits

- `cargo tauri build --debug`'s DMG step (`hdiutil create` inside `bundle_dmg.sh`) hung
  indefinitely in the sandboxed agent worktree this task was built in — the raw `.dmg` was written
  in full (46 MB, matching the payload) and then `hdiutil` never returned, with no further disk
  activity. `cargo check` and the `.app` bundle it produces are unaffected: `Hermie.app` built,
  carried the right `Info.plist` (identifier, name, version, `icon.icns`, `LSMinimumSystemVersion`),
  and ran correctly through the whole manual pass below. Reasoned, not watched: this looks like a
  disk-arbitration restriction specific to the sandbox (`diskarbitrationd`, which `hdiutil` needs),
  not a bug in the desktop shell's own config — Task 8, which does real DMG signing/notarization on
  the owner's own Mac, is where this gets a real answer.

## Manual verification matrix

One row per platform, dated, for what has actually been watched happen — not inferred from reading
the code. "Reasoned, not watched" is written as such rather than left blank and rather than claimed
as tested.

### Task 1 — scaffold, macOS (2026-09-22)

Bed: `packages/fake-gateway` in cookie-auth mode on `127.0.0.1:9119` and Hermie Web on
`127.0.0.1:9120` (both via `npm run web`), the shell launched as
`HERMIE_WEB_URL=http://127.0.0.1:9120 ./Hermie.app/Contents/MacOS/hermie-desktop` — the built debug
binary directly, since `npm run desktop` needs a real `npm install` in the main checkout to
populate `node_modules/.bin/tauri` (see "Running it locally" above; this agent's worktree shares
`node_modules` with the main checkout and never runs `npm install` itself).

| Check                                   | Result                | Notes                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window opens on `HERMIE_WEB_URL`        | Pass                  | Opened straight to the Hermie Web sign-in page at 1100×760, real title bar reading "Hermie".                                                                                                                                                                                                                   |
| Sign in, connection test, onboarding    | Pass                  | Not a Task 1 acceptance criterion, but walked end to end (password sign-in, REST/WebSocket/profiles test, notifications step, done) to reach a chat — the shell is a plain webview here, nothing shell-specific to it.                                                                                         |
| Drag-select text in a bubble, then ⌘C   | Pass                  | Selected "I am researcher, at your service." in a bot's bubble with a mouse drag and copied it; `pbpaste` afterwards returned exactly that string. This is the one the whole task exists for: `dragDropEnabled: false` plus the Edit menu's native Copy role is what makes it possible in a bare Tauri window. |
| ⌘V pastes into the composer             | Pass                  | Pasted the same string into the message field; it landed as typed text and the send button enabled.                                                                                                                                                                                                            |
| Window size/position survive a relaunch | Pass                  | Moved the window to (164, 143) and resized it to 886×617, quit with ⌘Q, relaunched: `CGWindowListCopyWindowInfo` reported the identical bounds on the new process — `tauri-plugin-window-state`.                                                                                                               |
| Cookie session survives a relaunch      | Reasoned, not watched | Not this task's job (Task 4's auth matrix covers it) and not confirmed either way here — the fake gateway's own session had already expired by the second launch, which reads as that test session's short lifetime, not the shell.                                                                            |

Window-only screenshot (`screencapture -l <windowid>`, never the whole screen) of the paste landing
in the composer, taken after the copy above: see the handoff for this task for the file path (it
lives in the agent's scratch directory, not the repository).
