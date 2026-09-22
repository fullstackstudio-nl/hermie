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

The page the shell shows is the unmodified browser build a Hermie Web serves. The shell adds a
bridge the page can feature-detect, and everything about it is optional in both directions: an
operator updates their Hermie Web on their own cadence and the shell updates on its own, so "a page
newer than the shell" and "a shell newer than the page" are both permanent, normal states.

### The marker

Before any page script runs, on the top frame only, the shell sets:

```js
window.__HERMIE_DESKTOP__ = Object.freeze({ version: 1, platform: 'macos' | 'windows' | 'linux' })
```

That is the whole of "am I in the shell". The app reads it through
`apps/hermie/src/platform/desktop-shell.ts`, which exports `RUNS_IN_DESKTOP_SHELL` and
`DESKTOP_SHELL_PLATFORM` as constants beside `RUNS_IN_BROWSER` and `RUNS_ON_MAC`. A marker whose
shape the app does not recognise — no version, a platform it has never heard of — reads as "not in
the shell", which leaves the app in its plain-browser behaviour rather than branching on a value it
cannot interpret.

The marker is injected on **every** page the window loads, the identity provider's included. It is
an announcement, not a credential; what actually gates the bridge is the origin guard below.

### The six commands

`window.__TAURI__.core.invoke(...)` (the shell sets `withGlobalTauri`; `apps/hermie` imports nothing
Tauri, at module scope or otherwise, so a browser tab's bundle never grows a line for this). Each
answers `{ ok: true, … }` or `{ ok: false, reason }` and never rejects of its own accord.

| Command                | Args                                            | Purpose                                                                 |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `hermie_shell_info`    | —                                               | `{ version, platform, bridge: 1, gatewayId, gatewayName }`              |
| `hermie_set_menu`      | `{ titles: MenuBarTitles, chats: [] }`          | Rebuild the native Chats menu (first nine chats). Stub until Task 6.    |
| `hermie_notify`        | `{ notification: { id, title, body?, link? } }` | OS notification; click focuses the window. Stub until Task 5.           |
| `hermie_set_badge`     | `{ count: number \| null }`                     | Dock badge / overlay icon / tray tooltip. Stub until Task 5.            |
| `hermie_open_gateways` | —                                               | Show the shell's gateway picker. Stub until Task 3.                     |
| `hermie_close_handled` | `{ handled: boolean }`                          | Answer a `close` shortcut; `false` hides the window. Stub until Task 6. |

Six, and exactly six. A seventh is a deliberate design change, not a routine edit —
Task 7 has one candidate (`hermie_save_file`, only if a platform's webview turns out not to raise a
download event for `blob:` URLs).

`version` is the SHELL's version, which `scripts/set-version.mjs` keeps equal to the app's. It is
not the version of the page, which is Hermie Web's and may legitimately differ. `bridge` is the
contract's own number and is what the app keys behaviour on; an incompatible change bumps it and the
app keeps the old path for one release.

### The four events

Tauri events on the main window, delivered only while the window is on a configured origin:

| Event               | Payload                                                        |
| ------------------- | -------------------------------------------------------------- |
| `hermie://shortcut` | `ShortcutEvent` `{ action, typing: false }`, from a menu item. |
| `hermie://link`     | `{ url: 'hermie://…' }`, a deep link or notification click.    |
| `hermie://gateway`  | `{ id, name }`, after a switch and before the navigation.      |
| `hermie://focus`    | `{}`, the window regained focus.                               |

### The origin guard

This is the security core of the feature, and it is two layers, neither of which is sufficient
alone.

**The capability** (`apps/desktop/src-tauri/capabilities/remote-app.json`) says what a page loaded
from the network can reach at all: the six commands, plus `core:event:allow-listen` and
`core:event:allow-unlisten`. Nothing else — no `fs`, no `shell`, no `dialog`, no `opener`, no
`core:window`, and not even the notification plugin's own permission (the shell's `hermie_notify`
wraps it). Its `local` is `false`, so the shell's own pages get none of it either; they have
`local-pages.json`.

Tauri capabilities are **static** URL patterns, and the reader's Hermie Web address is not known
when the app is built, so the patterns have to be `https://*:*` and `http://*:*`. The trailing
`:*` is load-bearing: a URLPattern with no port component matches the scheme's _default_ port only,
so a bare `https://*` would silently exclude every Hermie Web on `:9443`. Verified against
`tauri-utils` 2.9.3's `RemoteUrlPattern`, not assumed.

**The guard** (`apps/desktop/src-tauri/src/bridge.rs`) is what makes that breadth safe. Every
command takes the calling `tauri::Webview`, reads its **current** URL, and compares the origin —
scheme, lowercased host, port always made explicit — against the configured Hermie Web list. A
mismatch is `{ ok: false, reason: 'origin' }`; there is no code path from a command's body to
anything else. Events go out through `emit_to_app` in `src-tauri/src/lib.rs`, which runs the same
check before emitting.

The guard exists because the shell navigates one webview across origins **on purpose**: signing in
walks through an identity provider's pages, a Cloudflare Access page, or Hermie Web's own OIDC
issuer, and every one of those is a page the shell loaded and would otherwise be holding the
capability. Without the guard, such a page could raise OS notifications, read the active gateway's
name, and listen for every deep link the reader follows.

Refused, by construction: `about:blank`, `data:` documents, `file://`, the shell's own
`tauri://localhost` (and `http://tauri.localhost` on Windows and Linux), any unconfigured host, the
same host on a different port, and the same host and port under a different scheme. An empty gateway
list refuses everything, which is the honest answer for a shell with no Hermie Web configured.
`cargo test` in `apps/desktop/src-tauri` covers each of those cases.

### The app-side seams

Everything in `apps/hermie` that knows about the shell is gated on the marker and is a no-op in a
plain tab and on native.

- `src/platform/desktop-shell.ts` — the constants and the typed facade. Reads globals lazily; imports
  nothing Tauri.
- `src/gateway/client.ts` (`attachLifecycle`) and `src/features/chats/ChatRuntime.tsx` — **the shell
  never pauses its connection and never stops its polls**, exactly as the iPad-build Mac app does.
  This matters more here than on the Mac: this is the browser build, and react-native-web reports
  AppState `background` whenever `document.hidden`, so a window that is merely minimised, hidden with
  ⌘H or covered by another window would otherwise tear its socket down on every ⌘Tab. It is also the
  window where a live socket has a second job — it is what raises notifications (Task 5), since a
  webview has no Push API. A browser **tab** still pauses, which is right: a background tab may be
  throttled to a halt.

The menu and shortcut subscription, the deep-link subscription, the notifier and the Settings rows
are Tasks 5 and 6; each is built against the contract above.

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

### Task 2 — the bridge and the origin guard, macOS (2026-09-22)

Bed: a two-origin probe harness rather than the app, because the property under test is about the
WINDOW's current URL and needs two origins in one shell session. Two plain Node servers on
`127.0.0.1:9121` and `127.0.0.1:9122` serve the same page, which reads `window.__HERMIE_DESKTOP__`,
calls all six `hermie_*` commands plus two commands the capability does not carry
(`plugin:opener|open_url`, `plugin:fs|read_text_file`), registers an event listener, POSTs the
result to its own server, and then navigates the window to the other port. The shell ran as
`HERMIE_WEB_URL=http://127.0.0.1:9121 ./target/debug/hermie-desktop`, so `:9121` is the configured
Hermie Web and `:9122` is not. The page-load path was then re-checked against the real bed
(`packages/fake-gateway` on `:9119` plus Hermie Web on `:9120`).

| Check                                                 | Result                | Notes                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marker on the configured origin                       | Pass                  | `{ platform: 'macos', version: 1 }`, and frozen: assigning `version = 99` left it at `1`.                                                                                                                                                             |
| All six commands from the configured origin           | Pass                  | Each answered `{ ok: true }`; `hermie_shell_info` answered `{ ok: true, version: '0.1.0', platform: 'macos', bridge: 1, gatewayId: 'dev', gatewayName: '127.0.0.1' }`.                                                                                |
| All six commands from another origin                  | Pass                  | After a real top-level navigation to `http://127.0.0.1:9122/` in the same window, every one answered `{ ok: false, reason: 'origin' }` — same host, different port, which is the case a path-only check would miss.                                   |
| Commands outside the capability                       | Pass                  | `plugin:opener                                                                                                                                                                                                                                        | open_url`and`plugin:fs | read_text_file` were REJECTED by Tauri's ACL from both origins ("not allowed", "Plugin not found") — they never reach a command body at all. |
| `core:event:allow-listen` from an unconfigured origin | Pass (by design)      | Registering a listener succeeds from any http(s) origin, because the capability grants it and capabilities are static. What that page must never get is a delivered event, and that is `emit_to_app`'s job.                                           |
| An event actually withheld from an unconfigured page  | Reasoned, not watched | Nothing emits yet — the four events are Tasks 5 and 6. `emit_to_app` runs the same `bridge::guard` the commands do, and the guard itself is covered by `cargo test`; this row gets watched in Task 5.                                                 |
| The real app page still loads, with the bridge on     | Pass                  | Against Hermie Web on `:9120`: the export built from this branch opened on onboarding step 1 ("Inloggen", "Geleverd door Hermie Web, verbonden met 127.0.0.1:9119"), so the injected marker script breaks nothing.                                    |
| The shell never pauses its socket                     | Reasoned, not watched | Covered by Jest on both seams (`__tests__/mac-lifecycle.test.ts`, `__tests__/chat-runtime.test.tsx`), each mocked shell-on and shell-off. Watching it means a signed-in session, a hidden window and a reply arriving into it, which is Task 5's bed. |

Window-only screenshot (`screencapture -l <windowid>`) of the app page in the shell: in the agent's
scratch directory, not the repository — see the handoff for this task.
