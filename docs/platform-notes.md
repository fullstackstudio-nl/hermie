# Platform notes

What actually works on each platform, what had to be changed to get there, and what is still unknown.
Findings are dated, because the answers change with every SDK bump.

Everything below was measured on: macOS 27.0 (Darwin 27.0.0, Apple Silicon), Xcode 27.0, Node 26.8.2,
npm 11.19.1, CocoaPods 1.17.0, Expo SDK 54.0.37, React Native 0.81.5.

There are four targets and three builds. iOS and Android are what you expect; the Mac is the **iOS
build** running as "Designed for iPad" (ADR-0011); the browser is a separate Expo web export served
by Hermie Web (ADR-0015), and it is the only one nobody installs. Sections dated before 2026-09-19
that talk about a native macOS target described a platform that no longer exists — they were removed
rather than rewritten, and git history has them.

## A horizontal ScrollView with no width does not scroll (2026-09-21)

The owner photographed a Markdown table on the phone: cells ending mid-word at the
bubble's right edge, and no way to drag it sideways. Both blocks that can be wider
than a bubble — a table and a fenced listing — were ALREADY wrapped in a horizontal
`ScrollView`, and neither of them scrolled. What was actually wrong is a layout rule
that is invisible from the JSX, so it is written down here.

A bubble's body sits under `alignItems: 'flex-start'`, because `Bubble` needs the
body's natural width to decide whether the clock fits on its last line. A flex item
under `flex-start` gets its CONTENT width, and a content width is allowed to overflow
its container. A `ScrollView` has no intrinsic width to stop that — its content is
its content — so the scroll view came out exactly as wide as the table inside it.
`contentSize == bounds`, the pan recogniser never fires, and the only thing clipping
the table was the bubble's own `overflow: 'hidden'` several ancestors up.

Measured on an iPhone 17 Pro simulator against a six-column table:

- **`maxWidth` on an ancestor does not fix it.** Capping the bubble's body box at
  `max - paddingX * 2` changed nothing: it clamps that ancestor's reported size
  without handing the scroll view a definite width to stretch into.
- **An explicit `width` on the scroll view does.** A hard-coded 280 made the same
  table scroll immediately, which is what identified the rule.
- **Nothing under the `flex-start` boundary can measure the number**, because
  everything down there is sized by the content asking the question. So it comes from
  outside: `useBubbleContentWidth` in `Bubble`, through `<Markdown maxContentWidth>`,
  into `MarkdownContext.contentWidth`.

`DiffView` inside a tool card was never affected and scrolled all along, which is the
control that confirms the diagnosis: a tool card is a stretched box with a `maxWidth`,
so its scroll view is stretched to a definite width by the ordinary `stretch` rule.

Also settled in the same pass, on the simulator rather than by reading:

- A vertical drag that starts ON a table still scrolls the transcript.
  `directionalLockEnabled` plus `nestedScrollEnabled` is enough, and the inverted
  `FlatList` does not fight it.
- iOS breaks an unbreakable prose token — a 64-character digest, a long URL, a long
  path — per character inside the paragraph, so nothing there had to change.
  react-native-web gives `Text` `word-wrap: break-word` by default, which is the same
  rule; that half is read, not run.
- The indicator stays hidden, so the overflowing side carries a 22pt gradient into the
  surface behind it. It appears from the real `contentSize`, not from the estimate
  that sized the box.

**Unverified:** the ledger hosts (`CronDeliveryCard`, `BotDmOutLine`) pass no content
width and therefore keep the frameless scroll. They are stretched boxes like the tool
card, so the `DiffView` control says they should already be fine — but no wide table
was put in one and photographed.

## The chat chrome floats, and the glass is the real material (2026-09-20)

The header was one glass surface spanning the column. It is now three separate
floating elements — the leading button, a contact pill, the trailing button — laid
OVER the transcript, with the list padding its own content clear of whatever the
chrome measured. On an inverted list that padding is `paddingBottom`: the content
container's top is at the screen's bottom, which is the kind of thing that is
obvious once and wrong twice.

The header row is `pointerEvents="box-none"`, so the gaps between the three
elements pass drags and taps down to the transcript. A transparent view that
swallows touches is worse than an opaque one, because nothing on screen explains
what stopped the finger.

`GlassSurface` now takes `interactive`, which reaches `UIGlassEffect.isInteractive`
— the flex and brighten a Liquid Glass control does under the finger. It is on for
the round buttons and off for anything holding content; a panel carrying a
scrolling list must not squirm when the reader drags it. The developer screen
prints both probes (`liquid glass:` / `effect API:`) beside the material, because
"older than iOS 26" and "an iOS 26 beta with a broken initialiser" both come out
as `blur` and the first question about a surface that is not transparent enough is
which of the two it was.

**Unverified:** every line above was read and tested, not watched. Whether the
material actually reaches the transparency of the Messages search field on this
Mac is a question for that Mac.

## An inactive Mac window (2026-09-20) — read, not settled

The requirement is that the app does not change its look when its window is not
key. What was checked, and what it leaves open:

- **Nothing in this app dims itself.** The two places that watch `AppState` —
  `ChatRuntime` and the gateway client — act on `background` only, and both guard
  the Mac out of the branch that stops polling (`RUNS_ON_MAC`). No code path
  reacts to `inactive` at all, so a resigned window changes nothing we draw.
- **Our own layers are constant by construction.** The border, the tint, the solid
  rung and the shadow in `GlassSurface` are theme values with no window state in
  them. On the `blur` and `solid` materials there is therefore nothing left that
  could dim.
- **What is open is the native material.** On the `native` path the surface is a
  `UIVisualEffectView` carrying a `UIGlassEffect`, and whether UIKit dims that for
  a non-key window in a "Designed for iPad" app is exactly what cannot be answered
  here — there is no Mac window in this environment, and the two candidate
  behaviours (dims like AppKit vibrancy, or does not) are indistinguishable from
  the code. If it does dim, the lever is not `GlassSurface`: UIKit exposes no
  inactive-appearance override, so the fix would be to hold the window key-looking
  from `modules/hermie-mac` or to drop that surface to the `blur` material on a
  Mac, and choosing between those without seeing the dim would be guessing.

So: no change was made for this, on purpose. The finding is that there is nothing
of ours to fix, and the one thing that might need fixing cannot be seen from here.

## The wide layout is edge to edge (2026-09-20)

The sidebar and the chat column used to be two rounded glass panels floating in a
14pt wallpaper gutter. The owner sent a screenshot of the Mac window and rejected
it — he does not like the space around everything — and set Messages on the Mac as
the reference, with iPadOS 26 Messages in dark mode for the detail.

So `RegularShell` draws: sidebar flush to the window's leading edge and the full
height of the window, chat column flush to the other three, **one** hairline
between them, no outer gutter and no rounding on either. The wallpaper is the chat
column and nothing else; the sidebar is a glass pane over the app's own floor.

Two consequences worth knowing before touching that file:

- **The safe area moved inside the columns.** There is no row left to inset: the
  glass has to reach the window's edges and under the title bar, and only its
  content may be pushed clear. Both columns apply the same `insets` object to
  their own content box, from one hook call, which keeps the property the old rule
  was protecting — they cannot disagree about a number neither computes.
- **The chat column provides a glass depth of 1** (`GlassDepthProvider`). It is
  the wallpaper rather than a `GlassSurface` now, and without that the header and
  composer would drop to a level-3 tint and `Screen` would paint the wallpaper's
  own rung over the wallpaper — which is the exact bug the depth rule was added
  for in the first place.

The compact shell is untouched: at 393pt there was never a gutter to remove.

And in the same pass, **no gradients anywhere**. The owner's verdict was that they
look generated. A wallpaper is one flat fill per scheme, a glass recipe and a
bubble recipe are one wash each, and an accent's outgoing bubble is one colour.
Every value kept is the one `npm run contrast:check` was already measuring, so no
floor moved — it still reports 186 pairs at or above theirs. The only
`LinearGradient` left in the app is the reading fold's mask, which is an alpha ramp
doing a job rather than decoration.

**Unverified:** none of this was seen in a real Mac window. It was read, typechecked
and covered by the RNTL shell tests; how the hairline and the under-title-bar glass
actually land is a question for a Mac.

## Summary

| Question                                          | Answer                                          | Date       |
| ------------------------------------------------- | ----------------------------------------------- | ---------- |
| Does the iOS app build for a Mac?                 | Yes — Release, signed, wrapped, `npm run mac`   | 2026-09-19 |
| Is the empty strip under the title bar gone?      | Chat column yes, sidebar no — now fixed         | 2026-09-19 |
| Does a bare Return send on a Mac?                 | **Yes** — used by hand                          | 2026-09-19 |
| Is Shift+Return a newline on a Mac?               | **Yes** — used by hand                          | 2026-09-19 |
| Does Escape close a sheet on a Mac?               | **Yes** — used by hand                          | 2026-09-19 |
| Is `GCKeyboard` populated for an iOS app on Mac?  | **Yes** — the three keys above prove it         | 2026-09-19 |
| Is `expo-secure-store` keychain-backed on a Mac?  | **Yes** — signed in across a quit and relaunch  | 2026-09-19 |
| Does the app launch on iOS 27?                    | **Yes, since scene adoption** — simulator       | 2026-09-20 |
| Does `AppState` survive the scene life cycle?     | **Yes** — measured, background and foreground   | 2026-09-20 |
| Can a Release build reach a gateway over http?    | **Yes, since the ATS key** — iOS 27 simulator   | 2026-09-20 |
| Can it reach a REAL tailnet name over http?       | **Yes** — Headscale `.internal`, iOS 27         | 2026-09-20 |
| Does a simulator get the tailnet's split DNS?     | **Yes** — resolved over `utun8`, from the app   | 2026-09-20 |
| Can the app tell a bad certificate from no host?  | **No** — both arrive as one flat failure        | 2026-09-20 |
| What AppState does a Mac window report?           | **Unverified** — see "A Mac never pauses"       | 2026-09-19 |
| Does a mouse drag still scroll a list on a Mac?   | Fixed in code; **unverified** — no Mac window   | 2026-09-20 |
| Can a drag SELECT text in a bubble?               | **No** — RN copies the whole block; see below   | 2026-09-20 |
| Why does replacing the .app sign the owner out?   | **Unresolved** — group made explicit; see below | 2026-09-20 |
| Can the simulators here be tapped and typed in?   | **Yes**, through the dedicated simulator tool   | 2026-09-20 |
| Can a simulator be given a LANDSCAPE iPad window? | **No, not any more** — the plist trick is dead  | 2026-09-20 |
| Can a screenshot reach a connected app, no taps?  | **Yes** — `--hermieGateway` / `--hermieToken`   | 2026-09-20 |
| Is the dev launch argument inert in Release?      | **Yes** — folded; its parser string survives    | 2026-09-20 |
| Is the sidebar tab strip present in portrait?     | **Yes** in the real shell; the gallery lied     | 2026-09-20 |
| Does `contrast:check` cover avatar tints?         | **No** — measure those by hand                  | 2026-09-20 |
| Is `TextDecoder` present at runtime?              | Not verified; the guard ships either way        | 2026-09-18 |
| Does the Android app build, Debug and Release?    | **Yes** — both, with no change to the project   | 2026-09-20 |
| Is the Android release APK shippable?             | **Yes** when the upload key signs it            | 2026-09-21 |
| Does a RELEASE build reach http on Android?       | **Yes** — measured on an emulator, not read     | 2026-09-20 |
| Does Android's back button close a panel?         | **Yes, since `useHardwareBack`** — it did not   | 2026-09-20 |
| Does a default AVD report Reduce Motion?          | **Yes** — its animation scales ship at 0        | 2026-09-20 |
| Does the Android native sign-in work?             | **Unverified** — `--auth native` was not run    | 2026-09-20 |
| Can a launch argument open one Android screen?    | **Yes** — Intent extras, `hermie-dev-launch`    | 2026-09-20 |
| Is that Android channel absent from Release?      | **No** — present but gated on `FLAG_DEBUGGABLE` | 2026-09-20 |
| Does the wide layout need a tablet AVD?           | **No**, but two were built anyway; see below    | 2026-09-20 |

"Unverified at runtime" is exact: the app builds, is signed and is wrapped, and the code path was read
rather than watched. Several rows that said so were closed on 2026-09-19 by a hand session in a real
Mac window — see "What a hand session in a Mac window settled" at the end of the Mac section. The
rows still marked unverified below were not part of that session.

## TextDecoder

**Not verified.** Whether the Hermes JavaScript engine provides `TextDecoder` and `TextEncoder` was
not measured on device for any platform. `src/polyfills.ts` installs `fast-text-encoding` only when
they are missing, so the app is correct either way; the cost of the guard is one conditional at
startup. Worth measuring when the gateway client starts decoding frames for real, because the native
implementation is meaningfully faster on a hot stream.

## iOS

Builds and runs. Two things needed fixing:

- **Deployment target floor.** Xcode 27 refuses anything below iOS 15, and
  `@react-native-async-storage/async-storage` still declares 13.4 in its podspec. `platform :ios` in
  the Podfile covers the pod targets but not the resource-bundle targets CocoaPods synthesises from a
  podspec, so a stock prebuild fails with _"The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET'
  is set to 13.4, but the range of supported deployment target versions is 15.0 to 27.0.x"_. The
  config plugin `apps/hermie/plugins/with-ios-deployment-target-floor.js` raises the floor for every
  target in the Pods project. Drop it once the dependencies ship supported minimums.
- **`expo-system-ui`** is required for `userInterfaceStyle` to take effect on Android; `expo prebuild`
  warns without it.

Verified: `npx expo prebuild --platform ios --no-install`, `pod install`, and a Debug build for the
iPhone 17 Pro simulator with `xcodebuild`.

## iOS runtime

Verified on 2026-09-19 on the iPhone 17 Pro simulator (iOS 26.5): the app installs, launches, loads
its bundle from Metro and renders the compact shell — native stack with a "Bots" header and the
placeholder screen below it, in light mode. Re-verified after the gateway client landed: Settings →
Connection test probes the fake gateway, connects in session-token mode through
`disconnected → authenticating → connecting → ready`, and lists its two bots.

Two things about this machine rather than about the project:

- `pod install` aborts with `Unicode Normalization not appropriate for ASCII-8BIT` unless the
  locale is UTF-8. Run it as `LANG=en_US.UTF-8 pod install`, or export that in your shell profile —
  CocoaPods says as much in its own warning.
- An `xcodebuild` destination of `name=iPhone 17 Pro` resolves `OS:latest` to a runtime that device
  does not exist on. Pass the simulator's UDID (`-destination 'id=<udid>'`) instead.

## Android

`npx expo prebuild --platform android --no-install` succeeds. When this was first written a Gradle
build had **not** been run: there is no JDK on this machine (`java -version` reports no runtime), so
`assembleDebug` could not be attempted. The Android SDK is present at `~/Library/Android/sdk`.

That gap has since been closed — see "Android runtime (2026-09-19)" at the end of this file for how
to get a JDK, how the emulator was set up, and what an actual run on a device found.

### The sign-in WebView is not given the gateway's extra headers on Android

`react-native-webview`'s `source.headers` are applied per load. On WKWebView they stay with the
request that carried them. Android's WebView re-sends them on cross-origin redirects
instead of dropping them at the origin boundary.

A native sign-in redirects to the identity provider by design — that is the whole flow — so on
Android a `CF-Access-Client-Secret` (or any other header the user configured for the _gateway_) would
travel to the IdP's domain. That is a credential leaving the host it authenticates to.

`NativeSignInWebView` therefore refuses the in-app page on Android **when extra headers are
configured**: `webViewMayCarryHeaders()` returns false there, and the component opens on the existing
system-browser fallback — open the page in the browser, paste the `127.0.0.1` redirect it fails to
load back into the app. The system browser never sees the gateway headers at all, and the loopback
code exchange is a plain `fetch` from the app, which does send them, safely.

Consequences worth knowing:

- An Android user behind Cloudflare Access signs in through their browser, not in the app. The
  redirect-paste step is the same one the web view's error boundary falls back to on any platform.
- Android **without** extra headers is unaffected and still signs in inside the app.
- If `react-native-webview` ever grows a per-origin header API, this is the place to revisit; the
  seam is one exported predicate.

## Chat UI kit: inverted lists, Modal sheets and text input (2026-09-19)

Verified while building `src/chat-ui`, `src/markdown` and `src/ui/sheets`. Everything below was seen
on a device or in a crash report, not inferred from documentation.

### `FlatList` inverted + `maintainVisibleContentPosition`

- **iOS (iPhone 17 Pro simulator, iOS 26.5): works.** `TranscriptList` is an inverted `FlatList` with
  `maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 32 }}`. Offset 0
  is the bottom of the conversation, so "stick to the bottom while streaming" needs no code: a list
  already at 0 stays there when content grows. `onScroll` reports the distance from the bottom
  directly, which is what drives the jump-to-latest pill.
- **Windowing is real and it bites tests.** The default `initialNumToRender` is 10, so a list of
  every item kind only mounts the newest ten and the rows further up are simply absent from the tree.
  `__tests__/chat-ui/transcript-list.test.tsx` therefore renders one list per kind rather than one
  list of everything.

### Nested scroll views

Two traps, both found on the developer gallery and both fixed in the components rather than in the
gallery:

- **A horizontal `ScrollView` defaults to `flexGrow: 1`.** React Native's `baseHorizontal` style sets
  `flexGrow: 1, flexShrink: 1`. Inside a scrollable column that means the code block, the Markdown
  table, the diff and the composer's attachment tray each expanded to the height of the _viewport_
  instead of hugging their content — on screen, a grey rectangle roughly 2000pt tall that swallowed
  the rest of the page. Every horizontal `ScrollView` in the kit now sets `style={{ flexGrow: 0 }}`.
- **A `FlatList` inside a vertical `ScrollView` warns and measures wrong.** The gallery shows the
  transcript as its own screen for that reason, not as a section.

### `Modal`-based bottom sheets

- **iOS: works.** `src/ui/BottomSheet.tsx` is `Modal` + `Animated.timing` on the JS driver
  (`useNativeDriver: false` — layout properties are not native-driver eligible). The approval sheet
  was driven end to end on the simulator:
  it slides up, dims the content behind it, and renders exactly the server's `choices` in the
  server's order.
- **Dismissal is taps only.** No gesture library is involved anywhere in the app, which is an
  ADR-0010 requirement: a swipe that lands on "Allow" is not consent.
- **`blocking` really does block.** The backdrop `Pressable` is `disabled`, and `onRequestClose` is
  left undefined so a hardware back press cannot answer an agent's question either.

## Bot-to-bot and sub-agents (2026-09-19)

### The blue "Refreshing…" bar over the chat header is Metro, not the app

A screenshot from the M3 run showed a blue bar across the top of the chat, covering the header and
the status bar, reading `Refreshing…`. It looks exactly like a pull-to-refresh spinner that escaped
its list, and it is not: it is React Native's own Fast Refresh banner
(`Libraries/Utilities/HMRClient.js` → `DevLoadingView.showMessage('Refreshing...', 'refresh')`),
which every development build draws over the whole window while Metro pushes a new bundle. It cannot
appear in a release build, and no app code can move it.

The chat screen has no pull-to-refresh at all, so there was nothing to fix there. Where a refresh
control genuinely exists (the chats list, Activity, Routines) it is a `refreshControl` on the list,
which iOS draws inside the list's own bounds under whatever header sits above it.

### `scrollToIndex` on a virtualised list has to handle failure

Opening another bot's chat scrolled to the matching message is `scrollToIndex`, and on a `FlatList`
that can fail outright: a row whose height has never been measured has no offset to scroll to. The
documented recovery is `onScrollToIndexFailed` — scroll to the estimated offset, let a frame render,
then try the index again — and without it the tap silently does nothing at all.

The same call also only works for a row that is currently in the list. Verbosity is a read-time
filter, so a chat on Quiet genuinely does not contain every item; `scrollToItem` reports that with a
`false` rather than scrolling somewhere plausible.

### Never call a parent's setter from inside a state updater

`TranscriptList` reported "scrolled away from the bottom" by calling the screen's callback from
inside its own `setAway(current => …)` updater. React runs updaters during the render phase, so that
is a `setState` during another component's render: LogBox reports "Cannot update a component while
rendering a different component", and the update can be dropped. The fix is an effect on the state
that changed — the value is the trigger, not the call site.

### A locally sent turn needs text matching, or it appears twice

`prompt.submit` answers with a status, not a row id. The optimistic user bubble and the streamed
reply therefore carry no `rowId`, and the rows the gateway persists carry no client id — nothing
links them. The next `sessions.changed` sweep reads the tail, finds two rows it has never seen, and
appends them: every sent message shows up a second time a moment after it was sent.

`reconcile` (full re-hydration) already matched on normalised text for this reason; `reconcileTail`
did not, and that is where the duplicate came from. The tail now pairs a fresh row against a live
item of the same kind with the same text and no `rowId` yet, and adopts the durable id onto it.

### iPadOS does not tell React Native whether a keyboard is physical

A bare Return that sends is safe on a desktop and not on a tablet: neither iOS nor iPadOS exposes
whether the attached keyboard is hardware, so sending on Return would leave a touch user with no way
to type a newline at all. Hermie therefore only does it where the window IS a desktop window — see
"Enter-to-send" under the Mac section below, which is where that turned out to be harder than it
looks.

### U+21A9 renders as an emoji on iOS unless you ask for text

The Activity timeline reads `writer ↩ researcher`. Written plainly, iOS gives U+21A9 its emoji
presentation and the arrow comes out as a blue glyph in the middle of a sentence. Appending the text
variation selector (U+FE0E) is what makes it render as text.

### `expo-haptics` is wired through a platform seam

M4 asked for haptics on send, approve/deny and `message.complete`. `expo-haptics` (`~15.0.8`, the
Expo 54 bundled version) is a dependency, behind `src/platform/haptics.ts`.

The seam is a closed set of three moments rather than a pass-through of the Expo API, and one rule:
`haptic()` swallows everything. The engine is absent on a simulator, switchable off in system
settings, missing on some Android builds, and there is nothing under a cursor on a Mac to buzz — and
none of those is a reason for a message not to send. That is also why the Mac needs no branch here:
the call is already allowed to do nothing.

Only three moments buzz — a submitted message, an answered approval or clarify, and a reply landing
while the chat is on screen. The last one lives in a `ChatScreen` effect rather than in the
controller, which is what keeps a bot answering in a chat nobody is looking at silent.

`npx expo-doctor` stays at 18/18 with the module added.

## Android runtime (2026-09-19)

The first time Hermie was driven end to end on an Android device. Everything below was observed on a
booted emulator, not reasoned about from the source.

### Building without a system JDK

`java -version` still reports no runtime on this machine, and Gradle needs one. The documented way to
get it:

```sh
brew install --cask temurin@17
```

Homebrew puts it where `/usr/libexec/java_home -v 17` can find it, and the Gradle wrapper picks it up
with no further configuration. Any JDK 17 works — React Native 0.81 / AGP 8 want 17, not 21 and not 11.

If the JDK is not on the default search path, point Gradle at it explicitly rather than editing
`gradle.properties` (which is a prebuild output and gets overwritten):

```sh
export JAVA_HOME=/path/to/jdk-17/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
npx expo run:android            # or: cd android && ./gradlew assembleDebug
```

`android/` is a prebuild output and is gitignored: a clean checkout has to run `npx expo prebuild
--platform android` before any of this.

### Emulator setup

The SDK at `~/Library/Android/sdk` already carries `emulator`, `platform-tools` and an arm64 system
image. Creating one from scratch, if `emulator -list-avds` comes back empty:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "system-images;android-36;google_apis;arm64-v8a"
avdmanager create avd -n hermie -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
emulator -avd hermie -no-snapshot -no-boot-anim -gpu swiftshader_indirect &
adb wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
```

Two things that are easy to get wrong:

- **The gateway host is `10.0.2.2`, not `localhost`.** That alias maps to the host machine's loopback
  interface, so `npm run fake-gateway` on `127.0.0.1:9119` is reachable at `http://10.0.2.2:9119`
  with no extra flags. `adb reverse` is only needed for Metro (`adb reverse tcp:8081 tcp:8081`).
- **A new `*.android.tsx` file needs Metro's cache cleared.** Metro memoises the resolution of
  `../platform/safe-area` to the file it found first; adding a platform variant beside it changes
  nothing until `npx expo start --clear`. Fast Refresh will happily keep serving the old graph, and
  the symptom is a fix that "does not work" while the file is plainly correct.

### The status bar had no ink of its own (fixed)

iOS derives the status bar's ink from the view controller, so nothing in the app ever had to say it.
Android does not. The window starts with `windowLightStatusBar` unset — white icons — and
edge-to-edge (on by default since SDK 54) makes the bar transparent, so those white icons sit
straight on the app's own background. Prebuild's `styles.xml` even writes
`<item name="android:statusBarColor">#F2F2F7</item>` and no matching `windowLightStatusBar`, which is
the bug in one line: a light bar with light ink.

In practice, in light mode: the clock, battery and signal bars were a pale grey smudge on the chats
list (`#F2F2F7`) and **completely invisible** on a native stack header, which is plain white.

`src/platform/safe-area.android.tsx` rendered `<StatusBar style="auto" />` from `expo-status-bar`
inside the provider. That provider is the only wrapper already present on every Android screen and it
sits above the navigator, so the setting survives screen changes. Verified dark-on-light in light
mode and light-on-dark in dark mode, on both the chats list and a native header.

> **Superseded the same week.** That file no longer exists: the status bar moved into `ThemeProvider`
> (see "The status bar belongs to the theme" below) because `style="auto"` follows the SYSTEM scheme
> and a reader who pins the app to Light on a Dark phone gets the wrong ink. The 2026-09-20 Android
> section confirms the replacement on a device.

One caveat is left: `style="auto"` follows the _system_ scheme, which is the same source the theme
uses while Appearance is on "System" (the default). A user who pins the app to Light while the phone
is Dark gets the system's ink rather than the app's. Fixing that needs the status bar driven by
`useTheme().scheme`, which lives _below_ this provider.

### `adjustResize` is a no-op under edge-to-edge — the composer hides behind the keyboard

**Not fixed; it needs a change to shared code.** This is the worst thing found on Android.

> **Fixed the following day, and watched a day after that.** `KEYBOARD_AVOID_BEHAVIOR` is `'padding'`
> everywhere (see "`padding` is the keyboard behaviour on Android too"), and the 2026-09-20 Android
> section is the emulator run that confirms the composer, the sheets and the onboarding footer all
> clear the keyboard. The diagnosis below is kept because it is why the constant exists.

`AndroidManifest.xml` carries `android:windowSoftInputMode="adjustResize"`, and the app's keyboard
avoidance is built on it:

```tsx
<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
```

`undefined` on Android means "do nothing, the window will resize under me". Since Android 15 / edge-to-edge
that is no longer true: the system stopped resizing the window for the IME and expects the app to
consume `WindowInsets.ime` itself. Measured directly, with `dumpsys window windows`:

|               | app window frame   |
| ------------- | ------------------ |
| keyboard down | `[0,0][1080,2400]` |
| keyboard up   | `[0,0][1080,2400]` |

The window does not move. So the `KeyboardAvoidingView` has nothing to react to, and everything
anchored to the bottom stays underneath the keyboard:

- **Chat composer** — the field, the `+` button and Send are all covered. You cannot see what you are
  typing and you cannot reach Send; the only way to send a message is to dismiss the keyboard first.
- **Onboarding footer** — Continue and Back are covered on every step with a text field.

The fix is to give Android `behavior="padding"` as well. RN drives `padding` from the
`keyboardDidShow` metrics rather than from a window resize, so it works whether or not the window
moves. Three call sites: `src/chat-ui/Composer.tsx`, `src/features/chats/ChatScreen.tsx` and the sheet
body, which lived in `src/ui/bottom-sheet/SheetBody.tsx` at the time and is part of
`src/ui/BottomSheet.tsx` now. It was deliberately **not** applied in this round — those are shared
files and the change wants to be made and re-verified together with the rest of the UI pass.

### What a full pass did confirm

Driven with `adb shell input` against `npm run fake-gateway -- --auth token --token demo`:

- Onboarding all four steps, gateway probe (`Hermes 0.21.3-fake · session token required`), token
  entry (masked), **Connected · 2 bots**, and the config surviving a cold restart.
- Chats list, a chat, sending a message and getting a reply, the approval sheet (Allow once), a
  delegation to `@writer` with its reply, the chat options sheet, Activity, Routines, Settings.
- **Back button.** Correct on all four cases: dismisses the keyboard without leaving the step; is
  swallowed by the blocking approval sheet; dismisses the options sheet without leaving the chat;
  leaves a chat for the chats list.
- **Edge-to-edge insets.** No overlap anywhere. The tab bar clears the gesture pill, the native stack
  header insets itself below the status bar, the composer and the bottom sheets clear the pill.
- **The picker asks for no permission.** `+` opens the Android photo picker (`ACTION_PICK_IMAGES`),
  which needs no runtime grant on Android 13+. `READ_EXTERNAL_STORAGE` is declared by
  `expo-image-picker` but stays `granted=false` and is never needed.
- **Text fields.** Every address/token/search field sets `autoCapitalize="none"` and
  `autoCorrect={false}`; nothing was auto-capitalised and the token field masks.
- **No crashes.** Zero `FATAL EXCEPTION` in logcat across the whole session. The only
  `W/ReactNativeJS` lines were "Cannot connect to Metro" from a deliberate Metro restart.

### One thing that is probably shared, not Android

On the very first hand-off from onboarding into the app, the chats list showed **"The bot list could
not be loaded: gateway not connected"** while the header next to it already said "● Connected", and
it stayed that way — `retry: 1` and `staleTime: 30_000` mean nothing re-runs the query when the
socket finally comes up. Navigating away and back remounted it and it loaded; a cold start never
showed it. It reads as a race between the bots query and the connection, which the emulator's slower
startup widens rather than causes. Worth a look on iOS before it is called an Android bug.

## The UI pass of 2026-09-19

A round of UI fixes that touched all four targets. What is worth keeping is not the list of changes
— the diff has that — but the handful of platform facts the round uncovered, and the two places
where the fix is a shape rather than a line.

### One sheet per chat, not four

`ChatScreen` used to render four sheets side by side and let each decide its own visibility. On iOS
that is four sibling `Modal`s: the first one presented wins and the rest are never shown. A
permission request arriving while the options sheet was open was therefore dropped on the floor, and
the agent waited on a question the user was never offered. It reproduces in one tap on a real
device and in `__tests__/chat-screen.test.tsx`.

`ChatSheetHost` now mounts at most one of them, and `features/chats/sheet-host.ts` decides which:
priority (a blocked agent outranks anything the reader opened) and the close-then-open swap live
there as a pure reducer. The swap waits for the outgoing sheet's `onClosed`, which the sheet fires
when its slide-out animation completes — with a `SHEET_ANIMATION_MS * 4` fallback, because `Animated`
on the JS driver stops ticking while the app is in the background and that callback really can be
minutes late.

The host also holds the question it is showing **by id** rather than taking it from
`chat.requests`. `chat.requests` is `openRequests`, so a question vanishes from it the instant it
resolves; the sheet's own "Answered elsewhere" / "Timed out" branch had been unreachable since it was
written. A question answered on this device closes itself after two seconds; one answered somewhere
else, or withdrawn, waits for the reader, because they never saw what happened to it.

### `padding` is the keyboard behaviour on Android too

The Android section above worked out why `adjustResize` is a no-op under SDK 54's edge-to-edge
layout, and left the fix for this round. It is now `src/ui/keyboard.ts`:
`KEYBOARD_AVOID_BEHAVIOR` is `'padding'`, everywhere. Four call sites use it: the composer, the chat screen, the sheet body and the
onboarding wizard — which had no keyboard avoidance at all, so its Continue button sat under the
keyboard on **every** platform, iOS included.

A `KeyboardAvoidingView` with no `behavior` renders as a plain `View`. That is what lets `Composer`
take a `keyboardAvoiding` prop (default off) without a second component: a chat screen already has an
avoiding view around the transcript, and two nested ones each added the keyboard's height.

### The status bar belongs to the theme, not to the safe-area provider

Android leaves `windowLightStatusBar` unset (white icons) and edge-to-edge makes the bar
transparent, so on Hermie's light background the clock and the battery disappear. The Android pass
put `<StatusBar style="auto" />` in a `safe-area.android.tsx`; that follows the SYSTEM scheme, which
is the wrong one for a reader who pinned the app to Light while the phone is Dark.

It now lives in `ThemeProvider`, which is the one component that knows which of the pinned and the
system scheme won, and which sits above every screen so it survives navigation.
`safe-area.android.tsx` was deleted — there is one status bar and one place that decides its ink. On a
Mac there is no status bar to paint and the call is inert.

### `Subagent.startedAt` is milliseconds

The reducer stores it in milliseconds and the agents sheet reads it that way. `AgentsBar` took unix
seconds, so `ChatScreen` handed it a number a thousand times too large and the bar read `0s` for an
entire run. The prop is now named `startedAtMs`, because the previous name is exactly how this
happened.

### The photo picker needs no permission

`launchImageLibraryAsync` goes through PHPicker on iOS and the Android photo picker on Android. Both
run out of process: the app only ever sees the one item handed back, and neither platform requires a
grant. The Android pass confirmed the Android half; the iOS half is the same contract.
`requestMediaLibraryPermissionsAsync` was therefore removed — it put a full-library prompt in front
of someone attaching one screenshot, and a "Limited" answer came back as `granted: false` and refused
a picker that would have worked. A refusal on an older OS is still caught, and
`openAppSettings()` is offered for it.

### The roster is read when the socket is up, not when the connection object exists

`ChatRuntimeProvider` used to call `bots.refresh()` the instant a `GatewayConnection` was
constructed, which on a fresh device is well before the socket is open. It failed with "gateway not
connected", nothing retried, and the chats list sat on that error under a header that said
Connected — the race the Android pass flagged as "probably shared, not Android". It was shared. The
refresh now runs on the transition to `status === 'ready'`, which also covers every reconnect.

### The composer field is one line box, not three independent controls

The send button poked through the top of the rounded field and sat off-centre. Three things inside
it were sized independently — a 38pt circle, a 44pt "+" and a 40pt input in 3pt of padding — so the
row was as tall as its tallest child rather than as tall as one line of text, and `radii.sheet` (28)
on a ~42pt box curved through most of the field's height, which is what the circle was crossing.

`Composer` now has one line box. `COMPOSER_LINE_HEIGHT` (32) is a single line of input; both buttons
occupy a slot exactly that tall and draw a `COMPOSER_BUTTON_SIZE` (30) circle centred inside it, and
the row is `alignItems: 'flex-end'`, so at one line the circles are centred in the field and once the
input grows they ride the bottom line the way iMessage does. The 44pt touch target comes from
`hitSlop`, the way every other small control in the kit gets one.

The radius is `COMPOSER_FIELD_RADIUS` — half the SINGLE-LINE field height, so the field is a true
pill at one line and keeps those same caps as it grows. `radii.pill` is wrong here for the same
reason `radii.sheet` was: a 999pt radius on a four-line field makes both ends full semicircles and
the "+" on the bottom line ends up inside the left one. That was caught on the simulator between two
attempts at this fix, which is why the number is derived rather than picked.

`__tests__/chat-ui/composer.test.tsx` asserts the invariant rather than pixels — the test renderer
lays nothing out — and the two heights that make overflow impossible: the button is never taller than
the line box, and the buttons, the input and the field all agree on that one number.

## Mac: the iPad build (2026-09-19)

The day the native macOS target was deleted. [ADR-0011](adr/0011-mac-via-the-ipad-build.md) is the
decision and the list of what react-native-macos cost; this is what the replacement actually does.

### The destination string, and where the product lands

```sh
xcodebuild -workspace Hermie.xcworkspace -scheme Hermie -configuration Release \
  -destination 'platform=macOS,variant=Designed for iPad' \
  -derivedDataPath build/MacDerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$HERMIE_APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic build
```

`npm run mac` is that, plus the prebuild and the pods and the wrapping below. Two things about it:

- **The products directory is `Release-iphoneos`**, not `Release-maccatalyst` and not anything with
  `macos` in it. The Mac build is the iOS slice; only the destination differs.
  `apps/hermie/scripts/run-mac.mjs` reads the directory rather than hard-coding that name.
- **Signing is not optional.** The App Store validation step runs on this configuration, so
  `CODE_SIGNING_ALLOWED=NO` is not a way out — the build needs a real Apple Developer team, automatic
  signing, and `-allowProvisioningUpdates` to mint the profile. The team identifier comes from
  `HERMIE_APPLE_TEAM_ID` or `--team`, never from a file: this is a public repository. The resulting
  bundle is signed `Apple Development`, with `application-identifier` set to
  `<team>.dev.hermie.app`.

### A bare iOS .app will not launch — it has to be wrapped

Opening the built `Hermie.app` directly fails with _"has an incorrect executable format"_. macOS
expects the shape the App Store installs:

```
Hermie.app/
  Wrapper/Hermie.app     ← the iOS bundle, unchanged
  WrappedBundle -> Wrapper/Hermie.app
```

The symlink is **relative**; an absolute one only works on the machine that built it. `ditto` does the
copy rather than `cp -R`, because a `.app` is a bundle of symlinks and extended attributes. Verified
by hand before this change, and reproduced by the script: `open` on the wrapped bundle is accepted.

### `isiOSAppOnMac`, and why `Platform.isMacCatalyst` is not it

React Native exposes no way to tell a Mac window from an iPad. `Platform.isMacCatalyst` looks like the
answer and is not: `RCTPlatform.mm` sets it from `#if TARGET_OS_MACCATALYST`, a **compile-time** flag,
and a "Designed for iPad" app is an unmodified iOS binary, so it is false. Nothing in `node_modules`
exposes `isiOSAppOnMac` either — checked across every installed package.

So there is a local Expo module, `apps/hermie/modules/hermie-mac`, exporting one constant from
`ProcessInfo.processInfo.isiOSAppOnMac`, read through `src/platform/runs-on-mac.ts`. Four things about
it are worth knowing:

- **`apps/hermie/modules/` is autolinked with no configuration.** Expo's
  `nativeModulesDir` defaults to `./modules` relative to the package that holds `package.json`.
  Verified: `HermieMac` appears in `ios/Podfile.lock`, in `Pods-Hermie.release.xcconfig`, in the
  generated `ExpoModulesProvider.swift`, and `HermieMacModule.o` is linked into the app binary.
  `ios/` stays fully generated — nothing in it is edited by hand.
- **It is Apple-only.** `expo-module.config.json` declares no Android platform, so autolinking resolves
  25 modules for Apple and 24 for Android with the module absent from the second. That is one less
  Kotlin file and one less `build.gradle` than an Android stub that could only ever return `false`.
- **`requireOptionalNativeModule` returns `null`, it does not throw.** Measured under Jest. So the
  JavaScript reads `false` on Android and in tests without any mock, and a test that wants the Mac
  case mocks the module (`__tests__/mac-safe-area.test.tsx`).
- **`.easignore` needed teaching.** Its `ios/` and `android/` patterns are unanchored — they match at
  any depth — so they also swallowed `modules/hermie-mac/ios/`, which would have produced an EAS build
  with no native module in it. `npx expo-doctor` fails on exactly this, which is how it was found. The
  patterns now name their parent directory.

### The empty strip under the title bar

A Mac window showed a band of roughly 25pt between the macOS title bar and Hermie's own header, on
every screen. It is the **iPad status-bar safe-area inset**: an iOS app on a Mac is told it has one,
`Screen` turns `insets.top` into `paddingTop`, and nothing occupies the result because the title bar
is outside the app's window.

`src/platform/safe-area.tsx` now drops the top inset when `RUNS_ON_MAC`. Only the top: the other three
are either zero on a Mac already or genuinely describe the window, and zeroing them would be a guess.
iPhone and iPad are untouched, which is what `__tests__/mac-safe-area.test.tsx` asserts.

**Half right.** Confirmed in a Mac window on 2026-09-19: the strip was gone above the CHAT column and
still there above the sidebar. The inset itself was fine; `RegularShell` was adding a top padding of
its own to the sidebar pane, which nothing Mac-aware ever reached.

The fix is structural rather than another branch. Both panels are siblings in one row, and the row
carries the safe-area padding once; neither panel adds any. Two columns cannot disagree about a
number they do not each own, which is the part a test can hold on to —
`__tests__/regular-shell.test.tsx` asserts that the row has the inset and that both panels have none,
with the Mac seam mocked both ways.

One thing left open: in a Mac window dragged narrow enough for the compact shell, the native stack
draws its own header and insets itself from the same safe area. That inset is applied natively, below
JavaScript, and this fix does not reach it.

### Enter-to-send: `submitBehavior`, not `onKeyPress`

This is the part that did not work the way the old macOS code implied, and the reason is worth writing
down because it is invisible from the JavaScript side.

**On iOS, `onKeyPress` carries no modifier state.** React Native derives the event's `key` from the
text the field is about to insert (`TextInputEventEmitter::keyPressMetricsPayload`) and the payload it
builds is exactly `{ key, eventCount }`. `shiftKey`, `metaKey` and `ctrlKey` only ever arrived from
react-native-macos. `Composer` still handles them — the branches are correct if a platform ever
delivers them — but on the platforms Hermie ships they do not fire. The same goes for `Escape`, which
inserts no text and so never reaches a `UITextView` delegate at all.

**`preventDefault` does not suppress a Return, either.** By the time `onKeyPress` runs the insertion
has been accepted.

**What does work is `submitBehavior`.** In `RCTBackedTextInputDelegateAdapter`, a multiline field
intercepts a replacement text of exactly `"\n"`, asks the delegate whether to submit, and on
`'submit'` fires `onSubmitEditing` and returns `NO`: no newline, no `onKeyPress`, and no blur — only
`'blurAndSubmit'` blurs. On `'newline'`, the multiline default, it falls through and the newline lands.

So the composer sets `submitBehavior` from `RUNS_ON_MAC` and sends from `onSubmitEditing`. The two
modes are mutually exclusive by construction, which is what makes a double send impossible rather than
guarded against.

**Shift+Return is the half `submitBehavior` cannot answer.** It inserts the same `"\n"` as Return, so
both arrive at `onSubmitEditing` identically — and suppressing the insertion suppresses it for both.
The first version of this shipped with no newline key on the Mac at all, which is not acceptable: a
prompt is often more than one line. It is closed natively instead — see the next section.

**Verified by hand on 2026-09-19** in a real Mac window: Return sends, Shift+Return inserts a
newline, Escape closes a sheet.

### Shift+Return and Escape come from GameController, below the responder chain

Two keys UIKit will not hand to a React Native `TextInput`, and one mechanism for both.

**Shift, because the modifier is missing.** `onSubmitEditing` fires for Return and Shift+Return alike,
so the composer asks the keyboard directly: `isShiftDown()` in the local module reads
`GCKeyboard.coalesced?.keyboardInput` and reports whether either Shift key is pressed. Polled rather
than pushed, because the caller already knows a Return happened and only wants the modifier that came
with it — a pushed modifier event would have to be raced against the Return it belongs to. Shift down
means the composer writes the newline into the draft itself, at the caret, replacing any selected range
the way typing a character would. `selection` is controlled for exactly one round trip so the caret
lands after the newline rather than at the end of the draft, and is released on the next
`onSelectionChange` — which the field fires because the selection changed.

**Escape, because the key never arrives at all.** It inserts no text, so it never reaches a
`UITextView` delegate. A `UIKeyCommand` would have to live in the responder chain, and a presented
`Modal` leaves that chain — exactly the case that matters, since a sheet is the main thing Escape should
close. `GCKeyboardInput.keyChangedHandler` is below all of it: HID state, delivered regardless of what
is first responder. It is guarded on `applicationState == .active`, because HID state does not care
which app is in front and a keystroke meant for another window must not dismiss a sheet nobody is
looking at.

`useEscapeKey(handler, enabled)` decides who gets it: a stack, last registered wins, one native
subscription for the whole app. A **blocking** sheet registers a handler that does nothing, which
swallows the key rather than ignoring it — ADR-0010 says an agent's question is answered by an explicit
tap, and letting Escape fall through would stop the very turn that is waiting for the answer. The order
today, lowest first: a running turn, the slash popover, a sheet, the full-screen sign-in page.

What is known, and what is only reasoned:

- **The SDK says GameController needs nothing but linking.** `GCKeyboard.h`: "available to an
  application that links to GameController.framework". No entitlement, no Info.plist key. The podspec
  declares the framework and `otool -L` confirms it in the built Mac app.
- **A keyboard can arrive after launch**, so the handler is installed on
  `GCKeyboardDidConnectNotification` as well as immediately. All keyboards coalesce into one object, so
  that fires once rather than per device.
- **`GCKeyboard.coalesced` IS populated for an iOS app on a Mac.** Verified by hand on 2026-09-19,
  and not by reading a constant: Shift+Return inserted a newline and Escape closed a sheet, and
  neither is reachable at all unless GameController hands this process the keyboard. The nil path is
  still there — every branch is a `guard let` that falls back to false — but it is now the unexpected
  one.
- **None of this is gated on `RUNS_ON_MAC`**, deliberately. Keyboard presence is the question, not the
  operating system, so an iPad with a Magic Keyboard gets Escape too, which is what a reader with that
  keyboard expects. `hardwareKeyboard` still gates Shift+Return, because it only means anything where a
  bare Return already sends.
- **Cmd+Return sends**, by not being special-cased: the only branch is Shift, so a Return arriving with
  any other modifier falls through to the send. Whether macOS delivers Cmd+Return to a text view as a
  Return at all is unverified; if it does, it sends.
- **A note on reading the binary.** `strings` does not find `isShiftDown` in the compiled module while
  it does find `hasHardwareKeyboard`. That is not a missing registration: Swift stores a string literal
  of 15 UTF-8 bytes or fewer inline as immediates rather than as a constant, so an 11-byte name leaves
  no contiguous bytes to find. Reproduced with a standalone file under the same `-O -wmo` settings.

### A Mac never pauses: AppState and the socket

The native macOS target ignored `AppState` outright — "macOS windows stay live" — and deleting that
target nearly deleted the rule with it. It matters more than it looks:

`GatewayConnection.pause()` calls `teardown()`. It closes the socket. On a phone that is the right
trade, because the OS is about to kill a half-open socket anyway and a backgrounded app should not
hold one. On a Mac it is the difference between a window you Cmd+Tab away from and a window that says
**"This conversation could not be opened: gateway not connected"** when you come back — which the
owner reports seeing on the Mac build, and which is exactly what a socket closed on every loss of the
front looks like.

So `RUNS_ON_MAC` gates the pause, in two places:

- `src/gateway/client.ts`, `attachLifecycle` — `background` does not pause on a Mac. `active` still
  calls `resume()` everywhere, which is free: it returns immediately unless the connection really is
  paused or stopped, so on a Mac it is a no-op and anywhere else it is the recovery.
- `src/features/chats/ChatRuntime.tsx` — `background` does not call `controller.onBackground()` on a
  Mac. That call clears `foregrounded`, which stops the approval and subagent polls; with the socket
  still up, stopping them would leave an agent's question unanswered while the window sat behind
  another app. `foregrounded` starts `true`, so not calling it leaves a Mac in the state the old
  target was permanently in. `persistAll()` still runs on both — writing the cache when the window is
  hidden costs nothing and is the one moment worth writing at.

`__tests__/mac-lifecycle.test.ts` and the AppState block in `__tests__/chat-runtime.test.tsx` pin both
halves, with the seam mocked either way.

**What AppState actually reports in a Mac window is unverified.** Nothing was launched (see Summary),
so this has not been watched. What the code assumes, and what would falsify it:

- A window that merely loses focus reports `inactive`, which neither place acts on. If a Mac reports
  `background` for a simple app switch, the guard above is what saves the socket — that case is
  covered either way.
- A minimised or hidden window is assumed to report `background` rather than terminating. If macOS
  ever suspends the process outright the socket dies with it regardless of this code, and the
  connection's own reconnect ladder is what brings it back on `active`.
- The one thing worth measuring when the app can next be run: log every `AppState` change while
  hiding, minimising, Cmd+Tabbing and switching Spaces. Until then this is reasoning from iOS's
  documented values, not an observation.

### Layout: nothing macOS-specific was lost

`Shell.macos.tsx` selected the sidebar shell unconditionally because react-native-screens had no macOS
slice, so the compact shell could not be bundled there at all. `useLayoutMode` already gives any window
at or above `REGULAR_LAYOUT_MIN_WIDTH` (700) the sidebar shell and anything narrower the compact stack,
and a Mac window is just a window — so deleting the variant changed nothing a Mac user sees at a normal
size, and a narrow Mac window now folds the same way a narrow iPad split view does.

`RegularShell` had its own one-pane fallback for a Mac window dragged narrow. That is now unreachable —
`useLayoutMode` gates the same threshold from the same `useWindowDimensions` in the same render — so it
was removed rather than left as code that cannot run.

### What the Mac build does and does not prove

Proved, on this machine, today:

- `npm run mac -- --no-open` ends in `** BUILD SUCCEEDED **`, signed, and produces the wrapped bundle.
- The local native module is compiled into that binary, and `GameController.framework` is linked into
  it (`otool -L`).
- The iPhone 17 Pro simulator still builds with the module present (`** BUILD SUCCEEDED **`).
- `npx expo prebuild --platform android --no-install` succeeds and Android's module set is unchanged.

Not proved:

- Anything at runtime in a Mac window: the strip, Return-to-send, Shift+Return, Escape, whether
  `GCKeyboard` reports a keyboard at all, the keychain, the sign-in web view on THIS build. The owner's
  Hermie was running and two copies of one bundle identifier cannot coexist, so nothing was launched.
- The Android APK. There is still no JDK on this machine (`/usr/libexec/java_home -v 17` finds none),
  so Gradle was not run. "Building without a system JDK" above is how to get one.

## The Liquid Glass pass, part 1 (2026-09-19)

Tokens, the glass primitive, the two shells and the chat list. What follows is what was MEASURED on
an iPhone 17 Pro simulator (iOS 26.5) and an iPad Pro 13" simulator against
`npm run fake-gateway -- --auth token --token demo`, not what the documentation promises.

### `expo-glass-effect` is real on iOS 26, and the app can tell you which material it drew

`expo-glass-effect@~0.1.10` (the SDK 54 line) resolves to `native` on iOS 26.5 — both
`isLiquidGlassAvailable()` and `isGlassEffectAPIAvailable()` answer true, and the panels draw a real
`UIGlassEffect` behind a `UIVisualEffectView`. That is not visible from a screenshot, because the
native material and the `expo-blur` fallback look similar over a light wallpaper, so
**Settings → Connection test now prints it**: `glass material: native | blur | solid`, next to the
Reduce Transparency and Reduce Motion flags. It is the first thing to read when a surface looks flat.

Four things the API costs you, all of them found by reading the module's Swift rather than its
README:

- **Two checks, not one.** `isGlassEffectAPIAvailable()` exists because some iOS 26 betas ship the
  design without a working `UIGlassEffect` initialiser, and constructing one there crashes. A build
  that passes the first check and fails the second must fall back.
- **Both calls throw when the module is not linked.** They reach for a native module through
  `requireNativeModule`, which raises rather than returning undefined — so a JavaScript bundle running
  against an older binary, or a test renderer, takes an exception at the first glass surface.
  `src/ui/glass/material.ts` catches it and degrades to `blur`.
- **A `GlassView` renders nothing on Android and on older iOS.** The package's own fallback is a bare
  `View` with no background, so the surface has to bring its own colour; that is what the elevation
  ladder is for.
- **The effect does not apply until the view has been laid out.** The module works around it with an
  `isMounted` flag in `layoutSubviews`, which matters for anything mounted hidden.

### Do not lay the fallback's gradient over the real material

This one cost a rebuild to see. The tokens document describes glass as a blur plus one or two
translucent white gradients, and says to use the native material on iOS 26 and `expo-blur` **plus the
same gradient layers** on older iOS. The first implementation drew the gradient in both cases.

On device that is the lightening applied twice: the Blue wallpaper behind the chat list came out as a
flat near-white field, with none of the colour the material is supposed to refract. The gradient is
what turns a FLAT blur into glass; the real material already does it, and better. `GlassSurface` now
draws the gradient only for the `blur` and `solid` materials.

### A level-3 tint must stay translucent even where nothing blurs

Every glass variant names the opaque rung it collapses to without a blur. Applying that to the
level-3 tints as well — a chip, a list row, the gateway card — paints them as opaque `e4`, which on a
light theme is pure white: the gateway card read as a white rectangle stuck to the bottom of the
panel. The rung exists so a tint composites onto a known colour, not so the tint becomes it. Only the
surfaces that have to hide a wallpaper take the rung, and only when they cannot blur.

### An unsigned simulator build cannot reach the keychain

`CODE_SIGNING_ALLOWED=NO` builds and installs and launches, and then onboarding fails on its last
step with _"Calling the 'setValueWithKeyAsync' function has failed → Caused by: A required entitlement
isn't present."_ Entitlements are attached at signing, so an unsigned build has no keychain access
group and `expo-secure-store` cannot write the session token. Build the simulator target ad-hoc
signed instead — no team needed:

```sh
xcodebuild -workspace Hermie.xcworkspace -scheme Hermie -configuration Debug \
  -destination 'id=<udid>' -derivedDataPath build/SimDerivedData \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO build
```

`npx expo run:ios` does this correctly on its own but needs Simulator.app to be openable; on this
machine it stops at _"Can't determine id of Simulator app"_ and never reaches the build. `xcodebuild`
plus `xcrun simctl install` / `launch` is the path that works headlessly.

### Wallpapers: React Native has no radial gradient, and the obvious substitute is worse

The mockup builds each wallpaper from a diagonal base plus four or five radial blooms. `expo-linear-gradient`
has no radial mode, and drawing a bloom as a circle with a gradient inside it is worse than no bloom
at all: the circle clips while its colour is still at full strength, so what you see is a lit disc
with a hard rim. Every bloom in the mockup is anchored near an edge, so each is drawn instead as a
full-bleed wash that starts opaque at its own corner and is transparent well before the opposite one.
No clip, no rim, and nothing to measure at layout time.

### `Pressable` has no secondary click, on any platform Hermie ships

The row context menu was specified to open on long press on touch and on right click where there is a
pointer. React Native exposes no secondary-click event — `onContextMenu` is web only — so a right
click on a Mac or an iPad trackpad does not reach the app at all. Long press is the whole gesture; it
works with a mouse as well as a finger. Hover IS available, through `onPointerEnter` / `onPointerLeave`
(W3C pointer events), which is what the list rows use.

### Gateway latency is not measurable from the app today

The sidebar's gateway card shows host and connection state, and the mockup also shows `· 12 ms`. The
vendored channel does send a `gateway.ping` keepalive, but it does so inside
`packages/hermes-shared`'s JSON-RPC channel and never surfaces the round trip;
`packages/gateway-client` exposes nothing for it. The only typed RPC that looks cheap enough to time,
`gateway.capabilities`, is not side-effect free — it DECLARES what the client handles, and re-sending
it with empty parameters would be a live risk to approval delivery. So the card omits latency rather
than inventing it. Surfacing the keepalive's own round trip is a change to `gateway-client`.

### Not measured

- **Android.** `npx expo prebuild --platform android --no-install` was run; no Gradle build and no
  emulator run. The solid fallback is therefore unverified on a device — it is the path with no blur
  at all, and the one the elevation ladder exists for.
- **Reduce Transparency and Reduce Motion.** Both are read and both feed the theme, and the developer
  screen prints them, but neither was switched on in the simulator, so the solid swap and the static
  amber ring were not watched.
- **The wide layout on a Mac.** Not run; the owner's own Hermie holds that bundle identifier.
- **Performance in a long transcript.** No frame timings were taken. The nesting limit and the
  blur-free list rows are the mitigations the tokens document asks for, not measurements.

## Sending files, not only images (2026-09-19)

Upstream at `b9c2660`. There is no file-attach RPC: `image.attach` / `image.attach_bytes` take
images and nothing else, so a file has to be **uploaded over HTTP and then referenced from the
prompt text**. Both halves of that have constraints that do not line up by default, and the whole
design turns on making them line up, so this is what the code was written against.

### The upload endpoint has no idea what a profile is

`POST /api/files/upload-stream` (multipart: `file`, `path`, `overwrite`) and
`POST /api/files/upload` (`{path, data_url, overwrite}`) both resolve `path` through
`hermes_cli/web_server_files.py::_resolve_managed_path`, and that function takes a `Request` — never
a profile. There is no header, no query parameter and no session binding: the managed-files surface
is one filesystem, browsed as the OS user running `hermes serve`.

`_managed_files_policy` (`web_server_files.py:122`) picks the root in three cases:

| Condition                                     | `locked_root` | What `path` may be                             |
| --------------------------------------------- | ------------- | ---------------------------------------------- |
| `HERMES_DASHBOARD_FILES_ROOT` is set          | that root     | relative (resolved under it) or under it       |
| the Hermes root is `/opt/data` (hosted image) | `/opt/data`   | same                                           |
| otherwise — the ordinary self-hosted case     | `None`        | **absolute only**, anywhere the user can write |

That last row is the one that matters and it is easy to get wrong: with no locked root,
`_resolve_managed_path` answers **400 "Path must be absolute"** for a relative `path`
(`web_server_files.py:159`). So a client cannot hardcode `uploads/hermie/…` — and it cannot hardcode
an absolute path either, because a locked root would answer 403 "Path outside managed files root".

`display_path` in the response is `str(resolved)` — the absolute, symlink-resolved path on the
gateway host. `_managed_write_result` returns `{ok, entry, path, root, locked_root, can_change_path}`,
so the response itself tells the client both where the file landed and whether a root is locked.

Cap: `_MANAGED_FILE_MAX_BYTES = 100 * 1024 * 1024` (`hermes_cli/web_server.py:821`), enforced as the
stream is written, in `_UPLOAD_CHUNK_BYTES` (1 MB) chunks, with a 413 when it is passed. The stream
endpoint writes a sibling temp file and renames, so a cancelled upload cannot clobber an existing
file.

### `@file:` is expanded by the gateway, and it is confined to the session's cwd

`@file:<path>` is real and it is not CLI-only. The gateway expands it for every prompt in
`tui_gateway/prompt_turn.py:533-548`:

```python
ctx = preprocess_context_references(
    prompt, cwd=cwd, allowed_root=cwd, context_length=ctx_len)
```

`cwd` there is `_session_cwd(session)`. **`allowed_root=cwd` is the whole problem.**
`agent/context_references.py::_resolve_path` (line 345) resolves the target — keeping an absolute
one as-is — and then raises `"path is outside the allowed workspace"` unless the result is under
`allowed_root`. The CLI passes no `allowed_root` and is therefore unrestricted; the gateway is not.

So the obvious design does **not** work: upload to the managed-files root (`$HOME` in the ordinary
case) and reference it, and the reference is refused, because `$HOME/uploads/…` is not under the
session's `$HOME/projects/whatever`. The containment runs the wrong way.

What makes it work is to **upload into the session's own working directory**, which the client
already knows: `SessionLiveInfo.cwd` arrives with `session.resume` and Hermie already keeps it as
`chat.info`. Uploading to an absolute path under `info.cwd` satisfies both sides at once — the
managed-files policy accepts an absolute path (no locked root), and the reference is inside
`allowed_root` by construction. That is what `uploadFile` does, and why it refuses rather than
guesses when `info.cwd` is missing.

Two consequences worth knowing:

- **A locked-root gateway can still refuse the upload.** If `HERMES_DASHBOARD_FILES_ROOT` or
  `/opt/data` is in force and the session's cwd is not under it, the upload is a 403 and there is no
  path that would satisfy both constraints. The client cannot fix this; it reports it.
- **The file lands in the workspace, not in a scratch area.** That is the price of the `allowed_root`
  rule, so the directory convention has to be obviously ours and collision-proof:
  `uploads/hermie/<yyyy-mm-dd>/<random>-<sanitised name>` under the session cwd.

### What the agent does with the reference

`_expand_path_reference` (`agent/context_references.py:272`) inlines a text file as a fenced block
and, for a binary, returns `_binary_reference_block` — a block that tells the model the file is on
disk where its tools can reach it rather than a dead "unsupported" warning. Either way the
`@file:` token stays in the sentence where the user put it; upstream stopped stripping it on purpose,
because clients render it as an inline chip. Size is bounded twice: a single file over 50% of the
context window is not inlined (the reference survives, the bytes do not), and a total injection over
50% blocks the turn with `ctx.blocked`, which the gateway turns into an `error` event.

`_ensure_reference_path_allowed` refuses credential paths (`~/.ssh`, `HERMES_HOME/.env`, the
canonical read deny-list) whatever the workspace says, so an upload named to look like one of those
is rejected at reference time rather than at upload time.

### Auth

Nothing special: the files routes sit behind the same `auth_middleware` as the rest of `/api`, so the
bearer token and any configured extra headers are all that is needed. `GatewayHttp` already attaches
both, which is why the upload reuses it for the URL and header construction instead of building a
second client.

### The picker on a Mac

`expo-document-picker` is back in `apps/hermie/package.json`; it had gone out with the native macOS
target, where it had no slice. It is needed again because the Mac now runs the iPad build, and that
build is an iOS app: the module's iOS implementation presents `UIDocumentPickerViewController`, which
UIKit provides for "Designed for iPad" apps on a Mac and renders as the ordinary macOS open panel.
There is no `.macos` variant and no `RUNS_ON_MAC` branch, for the same reason `attachments.ts` no
longer has one — one implementation covers every target this builds for.

**Reasoned from the SDK, not watched.** Nothing has picked a file in a Mac window. If UIKit declines
to present the picker there, the "+" long-press does nothing rather than failing loudly, which is the
same degradation `GCKeyboard` has. `copyToCacheDirectory` is on, so the URI handed to the upload
outlives the picker; whether the Mac's panel honours that the way iOS does is part of what is
unverified.

### What a real-gateway test still has to confirm

Everything above is read from upstream source and exercised against the fake gateway. Nothing in the
upload path has been run against a real `hermes serve`. Specifically unverified: that
`multipart/form-data` from React Native's `fetch` with a `file://` URI is accepted by FastAPI's
`UploadFile` as-is; that `info.cwd` is populated for a Hermie session rather than arriving `lazy`;
that an absolute `path` under that cwd is accepted by `_resolve_managed_path`; and that
`@file:<abs path>` then expands rather than being refused.

## The Liquid Glass pass, part 2 (2026-09-20)

Everything below was measured or seen on the iPhone 17 Pro simulator (iOS 26.5) against
`npm run fake-gateway -- --auth token --token demo`, not inferred from documentation.

### A bubble tail has to be one path, drawn BEHIND the bubble

The previous build drew the tail as a small `View` with one rounded corner, offset `-5`, tucked under
the bubble's edge and rendered on every bubble. On the owner's Mac build that showed as a ~10pt
square of bubble colour protruding past the bottom-right corner with a notch in it, plus a dark
vertical sliver where the tail's box was wider than the bubble's own. Two separate causes:

- A rectangle has square corners. At bubble heights where the rounding did not cover them, one
  escaped.
- Two sibling views meeting at an edge both anti-alias that edge, and the Mac renders the iPad build
  **scaled**, so a sub-point offset that is invisible at 3× is a visible sliver there.

The replacement is `react-native-svg` (`15.12.1`, installed with `npx expo install`) drawing the
mockup's own path, positioned as a sibling BEFORE the bubble so the bubble's opaque fill covers the
overlapping part. Only the part that escapes the rounded corner is ever visible, so the join cannot
show as a seam even though the tail is a flat colour and the bubble is a gradient — which it would if
the tail were drawn on top, as a 5pt strip of the bottom stop over a lighter part of the gradient.
Every offset is a whole point for the same scaling reason.

### `transparent` is transparent BLACK, and a fade mask travels through it

The reading fold clips a long reply and lays a gradient over the seam. Written the obvious way —
`colors={['transparent', surface]}` — the mask interpolates from `rgba(0,0,0,0)`, so it travels
through dark grey and paints a dirty band across the last two lines. On the dark theme it was plainly
visible over the bubble with the clipped line ghosting through it. A mask has to fade a colour to
**itself**: the first stop is the surface colour at zero alpha.

A second, smaller trap on top of that one: the fold lives inside the bubble's padded content box, so
a mask spanning only that box leaves the bubble's padding unmasked around it and reads as a rectangle
rather than as a fade. The clip box is pulled out by the padding and padded back in by the same
amount, which works because `overflow: hidden` clips the box, not what the box's own padding covers.

### The system photo picker's delay is UIKit's, and the only fix is to stop pretending

The owner measured 1.5–2 s between tapping `+` and the system photo picker appearing on the Mac.
Nothing in the app can shorten that. Measured here by capturing timestamped `xcrun simctl io
screenshot` frames (~420 ms apart, which is that command's own cost) while driving the simulator:

- The `+` menu is present in the first frame after the tap. It is local state with no `await` in it,
  so it paints in the same frame.
- The chosen entry's busy mark is present in the first frame after ITS tap.
- The picker's sheet has begun animating in ~0.8 s later and is fully presented at ~1.6 s.

So the two seconds are real and they are the platform's. What changed is that they are now spent
looking at a menu with a busy mark on the entry you chose, rather than at a screen where nothing
happened. The menu deliberately stays open for the whole of it and closes on the FALLING edge of the
busy flag, so a cancelled picker does not leave it standing over the composer.

### Per-row disclosure state cannot live in the row

`FlatList` unmounts a row that scrolls out of its window. Any `useState` in that row — a tool card's
expanded flag, a fold, a bot-to-bot exchange — is therefore reset by scrolling, with a delay, which
reads as the app forgetting what you opened. The state belongs in one set above the list, keyed by
item id (`src/chat-ui/expanded.tsx`). It also has a second benefit worth naming: the list can then
guarantee that expanding something never moves the viewport, because nothing calls a scroll method.

### Memoizing a per-row prop is not enough; it has to be STABILISED

`TranscriptRow` is memoized on a tuple that now includes the row's grouping layout. A streaming delta
produces a new `items` array, so the grouping pass runs again and hands every row a freshly allocated
layout object — a different identity for an identical value, which breaks the memo and re-renders
every settled bubble on every token. `useMemo` does not help: the input really did change. The fix is
to keep the previous object for every key whose value is unchanged, which
`__tests__/chat-ui/transcript-memo.test.tsx` catches when it regresses.

### The simulator build needs React Core from source once a Fabric component is added

Adding `react-native-svg` made the Debug simulator build fail at link time with undefined
`facebook::react::Sealable`, `RCTPackagerConnection` and `RCTPerfMonitor`. Expo SDK 54 defaults to
`RCT_USE_PREBUILT_RNCORE=1`, and the prebuilt React Core artefact does not export those. Building the
pods with that flag off links cleanly:

```sh
RCT_USE_PREBUILT_RNCORE=0 LANG=en_US.UTF-8 npx pod-install ios
```

It is an environment choice rather than a file edit, which matters because `ios/` is generated: the
alternative is `ios.buildReactNativeFromSource` in `Podfile.properties.json`, and `expo prebuild`
would throw that away.

### What this pass did NOT verify

- **The wide layout.** An iPad simulator is booted on this machine and can be driven with
  `xcrun simctl` alone, but nothing in this pass was looked at on one: the wide bubble cap
  (`min(68%, 640pt)`), the sheet width constraint and the header's two-button group are unverified at
  that width.
- **Android.** Not built, not run. The bubble recipes are defined so the solid fallback keeps the
  hierarchy, and no per-bubble blur view exists to fall back FROM, but that is reasoning.
- **A long multi-word inline code chip.** The chip's padding and internal gaps are now non-breaking
  characters, with `U+200B` as the only break opportunity. If a platform ignores `U+200B` as a break,
  a long chip overflows instead of wrapping. Not seen either way.

## Messages shown twice, or out of order (2026-09-20)

Reported from a real gateway, real use: _"Sometimes messages trip: things are shown twice or in the
wrong order. Same behaviour as the original Hermes desktop app."_ The screenshot: the bot's previous
reply finished at 23:29, the owner sent one long multi-paragraph message (plain text, blank lines, an
IP address, a URL), and the transcript showed that same message as two outgoing bubbles stamped 23:30
and 23:31, with the typing indicator running and the composer showing Stop.

The one fact everything below follows from: **`prompt.submit` answers with a status, never a row id.**
A turn you sent and the row the gateway writes for it have nothing in common but their text, so every
path that can re-describe that turn is a chance to paint it twice. Four of them did, and none was the
one already documented under "A locally sent turn needs text matching" above — `reconcileTail`'s text
matching was working.

### The reported bubble was a resume projection landing beside its own row

`session.resume` answers with two overlapping truths: the gateway's live view of the running turn
(`inflight`), and the rows it has already written. Those overlap for the user's prompt, because the
gateway persists that row **at submit time**, not when the turn ends:

- `tui_gateway/methods_prompt.py:684` calls `_persist_session_row_for_submit` before the agent build.
- `tui_gateway/session_workdir.py:345` `_persist_submit_user_row` writes the row and stages the dict,
  so the turn adopts it rather than writing a second one. Its docstring says why: quitting a frozen
  app during a slow first build used to leave a session row with no message (upstream #111868).
- `tui_gateway/session_auto_continue.py:346` `_inflight_snapshot` then reports that same prompt as
  `inflight.user` for as long as the turn runs.

`applyResumeSnapshot` added both halves unconditionally. So any resume arriving while the turn was
still un-persisted **or already persisted** painted the prompt again, and the reply with it. The
second copy is stamped when the resume landed, which is the minute between the two bubbles in the
report. Two ordinary things trigger it on a phone:

- a dropped socket and a reconnect, which is `recoverAfterReconnect` → `session.resume`;
- leaving the chat and coming back, or a cold start, which is `hydrate`: step 3 reads history (which
  by then carries the row) and step 4 applies the snapshot on top of it.

The second matches the screenshot exactly, and it needs no network trouble at all.

Upstream has machinery for this and Hermie's port did not bring it. In
`apps/desktop/src/app/session/hooks/use-session-actions/utils.ts`:
`appendLiveSessionProjection` refuses the projection when the latest user run already carries that
text, `dedupeInflightUserAgainstTranscript` marks an already-flushed `inflight.user` for suppression,
`removeRepresentedLocalLiveProjection` drops the local rows the projection replaces, and
`preserveLocalPendingTurnMessages` decides which of two copies of a streamed reply to keep. That is
some 300 lines, each branch commented with the issue it was written for (#70209, #70449, #73793,
#75825, #76444). The port kept the item model and the reconcilers and left the resume path naive. The
owner's "same behaviour as the desktop app" is the desktop still getting the remainder wrong in ways
those helpers patch one at a time — not a place to copy the answer from.

Hermie's version is one rule rather than four helpers, because our item model already carries what
upstream has to infer. The prompt is suppressed when the newest authored item holds the same text; a
durable reply after that item means the turn is over, so the projection is a NEW turn and gets its own
bubble — unless that reply is the projection's own assistant text, which is a retained failure being
replayed. It is deliberately better than upstream's rule in one case and deliberately equal in
another:

- **Better:** a repeat sent from another client after an answer gets its own bubble. Upstream's
  latest-user-run walk suppresses it.
- **Equal, and on purpose:** a repeat from another client with no answer between is suppressed. The
  ambiguity is real and unresolvable from the projection alone, so the tie goes to the recoverable
  mistake: the row arrives with its own durable id on the next tail sweep and is appended, whereas a
  duplicate nothing ever removes stays for the life of the chat.

### A send carrying a file never matched its own row

`send` composes the body with `withFileReferences`, which appends the `@file:` token the gateway
expands, and the controller's own comment says the painted text and the submitted text have to be
byte-identical or the bubble appears twice. They were identical — and it appeared twice anyway,
because the comparison is not against the submitted text. It is against the row's **projection**, and
`stripUserText` lifts `@file:` and `@image:` directives out of the text into `attachments`. So the
bubble held `look at this\n\n@file:"…"`, the row projected to `look at this`, and nothing paired them.
The optimistic item now goes through `stripUserText` too: one projection for a user turn, whichever
side it arrives from.

An image send was already fine, for the same reason in reverse — the gateway appends its `@image:`
directive at persist time (`tui_gateway/session_history.py:45`
`_build_persist_message_with_image_refs`) and the projection strips it back off.

### Rows were shown in the order they reached us, not the gateway's order

`reconcileTail` splices rows it has never seen in front of the live tail. That is right for a row
written after everything on screen and wrong for one written before it: a teammate's delivery or a
cron turn that landed while the user was still typing carries a LOWER row id than the message they
then sent, and the ids that say so only arrive with the tail. The reader saw their own message above
one written before it. Row ids are the gateway's order, so the merged list sorts by them; an item with
no row id yet sorts with the newest row above it, which keeps a streaming bubble under its prompt and
still keeps a genuinely newer row behind the live tail.

### The second prompt of a parked burst arrived as somebody else's turn

`prompt.submit` answers `queued` when a turn is running (`session_auto_continue.py:248`
`_handle_busy_submit`, which queues and leaves `_drain_queued_prompt` to start it later — which is
also why that row's timestamp is the drain time, a minute after it was typed). `ChatState.queued`
holds one prompt, so `clearTurn` could carry only one prompt's `local` flag across: the first parked
prompt started as ours, the second started as a **foreign** turn, with an empty author placeholder in
front of the user's own message and a tail fetch scheduled to fill a bubble that was never anybody
else's. A bubble still marked `pending` is now what says "a prompt of ours is waiting for a
`message.start`", which holds at any queue depth. Stop and a failed submit clear the marker, so a turn
that really is a teammate's still gets its placeholder.

### What was checked and found innocent

- **Multi-paragraph text, `\r\n`, leading and trailing whitespace.** `normalizeMatchText` collapses
  all of it. The report's message pairs correctly once the resume path stops projecting it.
- **An IP address or a URL in the prompt.** The gateway only rewrites a prompt containing `@`
  (`_prepare_turn_input` gates `preprocess_context_references` on it), so a bare URL is stored
  verbatim. `sanitize_user_prompt_text` only strips leaked bracketed-paste markers.
- **`session.events.since` replay.** The `seq <= lastSeq` guard and the per-runtime-session watermark
  (`lastSeqSessionId`, dropped in `bindRuntime` when the id changes) do hold; a replayed stream
  produces no second copy.
- **The same message sent twice on purpose.** Stays two, before and after the fix.

### Unicode normalisation: hardening, not a diagnosis

Match text is normalised to NFC. Nothing was observed changing the form — the gateway stores what the
client sent, and Python does not normalise — so this is defence, not a cause. It cannot make two
genuinely different messages match: two spellings of the same accented word are one message to a
reader.

### What a real gateway still has to confirm, and how

Everything above is read from upstream source at `b9c2660` and exercised against fixtures and the fake
gateway. What no test can settle is which of the four paths the owner actually hit, and whether there
is a fifth.

Settings → **Connection test** now ends with a `Transcripts` block: per live chat, how many items it
holds, how many have a durable row id, how many are still unpaired, whether a turn is running and
whose it is, and one line per text that more than one item is carrying. That last line is the whole
diagnosis. `2x user 4f3a91c2/318 — optimistic + history#4412` says a bubble the gateway has named and
one it has not are holding the same words, which is a pairing that failed;
`2x user 4f3a91c2/318 — history#4412 + history#4501` would say the gateway really did store it twice
and the client is innocent. **No message text is shown** — a repeat is reported as a 32-bit digest and
a character count, so the lines can be pasted into an issue as they stand.

If it happens again: open that screen while the duplicate is still on screen and read those lines.
Worth noting alongside them is whether the app had just come back from the background or had just been
reopened on that chat, because that is what separates the reconnect resume from the cold-open one.

### Worth filing upstream

The desktop carries the same hole in a different shape, and it is worth raising as a contract question
rather than as a bug report against 300 lines of accumulated dedupe:

> `session.resume` returns `inflight.user` for a turn whose user row `_persist_submit_user_row` has
> already written, with nothing in either payload marking the two as the same row. A client cannot
> tell a re-description of the running turn from a genuinely new prompt except by comparing text,
> which is ambiguous the moment a prompt is repeated — and every client has to get that guess right or
> show the message twice. The id exists: `_persist_submit_user_row` stamps it on the dict it stages as
> `_row_id`, before `_start_inflight_turn` builds `inflight_turn` from the same text. Carrying it
> through to `_inflight_snapshot` as `inflight.row_id` would make the whole class of duplicate
> impossible to hit, for every client, instead of each one rediscovering the text heuristic.

That is the fix Hermie cannot make in its own layer, and the rule above is what it does instead.

## The wide layout, on an iPad simulator (2026-09-20)

The first pass in which the sidebar-plus-detail shell was actually looked at. Device: **iPad Pro 13"
(M5), iOS 26.5**, `86D0AE46-5541-48D2-B9CF-8D7624C998DE`, Debug build against Metro and
`npm run fake-gateway -- --auth token --token demo`. Everything below was sampled off
`xcrun simctl io <udid> screenshot` frames, not inferred.

### What can and cannot be driven here, exactly

This machine has **no `Simulator.app`** — `/Applications/Xcode.app/Contents/Developer/Applications/`
does not contain it, which is the real reason `npx expo run:ios` stops at _"Can't determine id of
Simulator app"_ (Part 1 recorded the symptom, not the cause). Consequences, all of them load-bearing
for anyone planning a pass:

- **No rotation.** `xcrun simctl` has no rotate verb, and device orientation is Simulator.app's
  state — there is nothing in `device.plist` or the device's preferences to write. So a landscape
  window cannot be produced the ordinary way.
- **No taps.** `simctl` has no tap, swipe or key verb, and `idb`, `fbsimctl`, `maestro` and `appium`
  are all absent. So the app can be launched and photographed and nothing else: every state behind a
  tap — a sheet, the overlay panel, a conversation — is out of reach.
- **The dev client can still be pointed at Metro without a tap.** `xcrun simctl openurl` raises an
  _"Open with Hermie?"_ system confirmation that then needs one. `expo-dev-launcher` reads a launch
  argument instead (`EXDevLauncherController.m`, `initialUrlFromProcessInfo`), so this works and
  skips the dialog entirely:

  ```sh
  xcrun simctl launch <udid> dev.hermie.app --initialUrl http://localhost:8081
  ```

- **Onboarding can be skipped by copying another simulator's state.** The gateway address is in
  AsyncStorage (`<data container>/Library/Application Support/<bundle id>/RCTAsyncLocalStorage_V1/
manifest.json`) and the session token is in the keychain — which on a simulator is a plain
  unencrypted `keychain-2-debug.db` under `<device>/data/Library/Keychains/`. Copying both from a
  device that has been through the wizard onboards the target with no taps. The device must be shut
  down while the keychain is replaced.
- **A landscape-PROPORTIONED window can be forced**, though not a rotated device: setting
  `UISupportedInterfaceOrientations` to landscape only in the **installed bundle's** `Info.plist`
  (`plutil -replace` on the built `.app`, never on `app.config.ts`) makes iOS hand the app a
  landscape-shaped scene letterboxed inside the portrait screen. What that yields here is roughly
  **1032 × 765 pt** — wide, and close to the mockup's 1180 × 820 Frame A, but NOT the 1366 pt of a
  real landscape iPad. The 640 pt bubble cap does not bite below about 1300 pt of window, so it is
  still unverified on a device; `__tests__/sheet-width.test.tsx` pins the widths at 1366 instead.

### A `Screen` inside a glass panel paints the wallpaper over it

The finding of the pass, and it needed a pixel sample to see. Dark theme, the two panels side by
side:

| Sample                     | Before    | After     |
| -------------------------- | --------- | --------- |
| Sidebar panel interior     | `#1B2744` | `#1B2744` |
| Chat panel interior        | `#0A1830` | `#192844` |
| Wallpaper above the panels | `#102B51` | `#102B51` |

`#0A1830` is `elevation.e0` — the wallpaper's own rung. Both panels are the same `GlassSurface` with
the same variant, so the panel was not the problem: `src/ui/primitives/Screen.tsx` fills its box with
`colors.bg` and adds the safe-area inset, and every wide-layout destination goes through it — the
chat, Settings, Activity, Crons. So every panel on that layout was painting the wallpaper's colour
over the material meant to refract it, and the inset was applied a second time on top of the one
`RegularShell` already applies once to the row holding both panels (which its own doc comment warns
about). `Screen` now reads the glass depth off the context `GlassSurface` already maintains and
draws neither background nor inset when it is inside one.

It is worth stating why nobody caught this earlier: on the **light** theme `colors.bg` (`#DCE8FB`)
and the panel are close enough that the flattening reads as "a bit pale", and every screenshot taken
before this pass was a phone at depth 0, where the behaviour is correct.

### The chat list, seen

- **The empty-section bug is not two dividers.** The owner's stored arrangement on the test device
  held ONE divider whose name is literally `New sectionFinance` — a single string. An older build
  seeded a new divider's name with `New section`, so typing `Finance` appended to it; the seeding is
  already gone (`addDivider('')`), and what is left on that device is stale data from a fixed bug.
  The separate, real problem is that an empty named section was dropped from the list unless the list
  was in edit mode, which is what let two headings meet.
- **Both avatar paths now render side by side.** The fake gateway answered `has_avatar: true` for
  every profile and served the same 1×1 half-opaque red PNG, so every row in every screenshot was a
  flat coloured disc and the generated-initial fallback was unreachable. Writer now has no avatar:
  its row draws `W` on the derived tint with its accent ring, beside Researcher's red disc. Upstream
  (`packages/hermes-shared`, `has_avatar?: boolean`) makes the field optional and the app only calls
  `profiles.get_asset` when it is true, so there is no placeholder image to defend against — the flat
  disc was this repo's own fixture, not a real gateway's behaviour.

### What this pass did NOT verify

- **A real landscape window**, and therefore the 640 pt bubble cap and the header button group at
  1366 pt. See the driving note above.
- **Anything behind a tap**: the overlay panel and its sub pages, every sheet, the colour picker, a
  conversation, the approval sheet, Crons, Activity. All of it is covered by component tests and none
  of it has been looked at on a device.
- **Android**, and **Reduce Transparency / Reduce Motion**, both still as Part 1 left them.

## Driving a simulator without touching it (2026-09-20)

Three design rounds in a row shipped sheets, option pages and a colour picker
that nobody had seen, for one reason recorded in the section above: this machine
has no `Simulator.app`, so `xcrun simctl` has no tap verb and every state behind a
tap is out of reach. The fix is not a better workaround for tapping — it is to
stop needing one.

### Launch arguments are the channel that exists

`xcrun simctl launch <udid> <bundle id> <args…>` puts everything after the bundle
id into the app's own `ProcessInfo.processInfo.arguments`. That is already how
Part 3 pointed the dev client at Metro (`--initialUrl`), because
`expo-dev-launcher` reads the same array. React Native exposes nothing
equivalent, so the local module answers it:
`HermieMacModule.swift` publishes `devLaunchArguments`, and
`apps/hermie/src/dev/launch-intent.ts` parses it. CONTRIBUTING.md has the
grammar.

Three gates keep it out of a shipped build, and it wants all three because what
it does is open arbitrary screens:

- the constant is inside `#if DEBUG`, so a Release binary does not define it —
  the key is absent, not empty;
- the JavaScript reads it behind `__DEV__`, which Metro's minifier folds to
  `false` and then removes along with the branch;
- nothing is registered with the system. No URL scheme, no `CFBundleURLTypes`, no
  entitlement, no associated domain. Launch arguments cannot be set on a device
  by anything but a debugger or `simctl`.

`__tests__/dev-launch-intent.test.ts` pins the second gate by re-importing the
module with `__DEV__` down.

### One launch, one screenshot

`GalleryScreen` is now a registry of addressable sections rather than a scroll of
hard-coded ones, and `--hermieOpen gallery:<id>` renders exactly one of them
filling the screen. A section may name a sheet, which it opens as it mounts —
that is what makes a blocking modal photographable at all. The gallery branch is
decided BEFORE the gateway phase, so a section needs no configured connection and
no copied keychain; a clean simulator plus Metro is enough.

What that immediately bought, on the iPhone 17 Pro (iOS 26.5):

- Every sheet title was `title` (28/32) where §3 of the tokens document says
  `sheetTitle` (21/26). It is obvious the moment you see the approval sheet and
  invisible in a component test.
- `initialPane` on the options sheet did nothing, because the sheet is mounted
  for the life of the screen and `useState`'s initial value had run long before
  anyone asked for a page. It now re-reads as the sheet BECOMES visible, which
  also stops an ordinary open landing on the page the last reader left.
- The Default swatch on the colour page is a hollow ring with no label, so on the
  dark sheet it reads as an empty hole rather than as a choice. Unfixed.
- `Last status` on the cron detail prints the gateway's raw `ok` two rows under a
  humanised `Success`. Unfixed.

### A `Screen` inside a glass panel has no safe-area inset, and that is correct

The first cron-detail screenshot had its header under the clock. Not a bug in the
screen: `Screen` deliberately adds no inset inside a `GlassSurface` (the section
above says why), and in the app the inset comes from the navigator or from
`RegularShell`'s window padding. `DevGallery` is neither, so it applies the inset
itself. Worth knowing before reading a gallery screenshot as evidence about the
app.

### Contrast, measured on the composited surfaces

Computed from the token values the way the mockup's author did — the alpha
gradient over its rung over the wallpaper — and against the WORST of the three
wallpapers (in dark, against the brightest bloom rather than the base, which is
harsher than the numbers in §2 of the tokens document).

Body text clears AA everywhere by a wide margin: light 15.03–16.48, dark
6.54–11.26. What does not:

| Surface           | Ink          | Light | Dark |
| ----------------- | ------------ | ----- | ---- |
| panel             | `ok`         | 3.84  | 6.01 |
| card              | `ok`         | 3.91  | 4.54 |
| incoming bubble   | `ok`         | 3.92  | 3.55 |
| incoming bubble   | `dangerText` | 6.07  | 3.58 |
| incoming bubble   | `textFaint`  | 4.79  | 3.56 |
| reading bubble    | `ok`         | 4.20  | 3.49 |
| sheet             | `ok`         | 4.21  | 4.12 |
| sunk tint (light) | `ok`         | 3.47  | 7.72 |
| sunk tint (light) | `textFaint`  | 4.23  | 7.74 |

So `ok` fails AA as INK on almost everything, in both themes, and `dangerText`
and `textFaint` fail on a dark bubble. None of these is body text and none is a
regression from this round — `ok` and `dangerText` have always been used as ink —
but §1.1 offers no readable variant of `ok` the way it does of `danger`, and that
is the gap. The script is
`/private/tmp/.../scratchpad/part4/contrast.mjs`; it belongs in `scripts/` next
round so the numbers can be a check rather than a paragraph.

White on the outgoing bubble's lighter (top) stop clears AA for all nine accents:
4.56 (teal) to 6.30 (graphite).

### What this pass did NOT verify

- **The wide layout's bubble cap.** On the landscape-proportioned iPad window
  (iPad Pro 13" M5, the installed bundle's `UISupportedInterfaceOrientations`
  forced to landscape, ~1032 pt wide) the gallery's chat screen draws bubbles
  ~324 pt wide, which is the COMPACT cap (`min(78%, 320)`) and not the regular one
  (`min(68%, 640)`). `useBubbleWidth` branches on
  `useWindowDimensions().width >= 700`, so either that window reports narrower
  than it looks or the percentage resolves against something narrower than the
  column. Measured, not explained.
- **Two rendering bugs seen in the same screenshot**, both in markdown inside a
  bubble: `**` around an inline code span is printed literally rather than
  unwrapped, and a table cell that wraps mid-word puts the wrapped character
  outside the row's background.
- **The agents bar, the sheets' interiors, the cron list and Activity** were not
  restyled this round; only the sheet titles and the eyebrow were brought onto the
  type scale.
- **Android**, **the Mac window**, **Reduce Transparency** and **Reduce Motion**,
  all as the previous rounds left them.

## What a green test suite did not know (2026-09-20)

The round that went looking for the bugs the previous one had SEEN, on the
device, rather than reasoning about them from the code. Two of the three had a
cause nobody would have guessed from a diff, and both were invisible to the test
suite by construction.

### The iPad's landscape window is 1376pt, drawn at 0.75 scale

The measurement everything else in this section depends on, and the previous
round got it wrong. Forcing `UISupportedInterfaceOrientations` to landscape on
the installed bundle does not hand the app a 1032pt window letterboxed inside the
portrait screen: it hands it a **1376 × 1032 pt** window — the real landscape
iPad size — and displays it scaled to fit the 1032pt-wide screen. The app's own
`useWindowDimensions()` says `1376 × 1032`, and a `simctl` screenshot is
2064 × 2752 px, so the conversion is **1.5 px per point**, not 2.

That one factor explains the previous round's headline number. The bubble it
measured at "~324pt, which is the compact cap" was 652px ÷ 1.5 = **435pt**, and
435 is exactly `68 % × 640` — the regular rule, misapplied. The compact branch
was never taken and the window was never narrow. Anyone measuring off these
screenshots again: divide by 1.5.

It also means the 640pt bubble cap and the header button group CAN be judged
here, which the previous round recorded as impossible.

### A percentage `maxWidth` on a parent with no definite width does nothing

`useBubbleWidth` returned `{ percent, points }` and the two halves were applied
to different views: the point cap to the wrapper, `maxWidth: '68%'` to the bubble
inside it. The wrapper has no width — it is sized by its own `maxWidth` — so Yoga
had no base to resolve the percentage against and dropped it silently. The
consequence is not subtle once stated: **the percentage half of §4's rule has
never applied on any layout**, and a bubble was `min(68 % × 640, content)` on a
Mac window and `min(78 % × 320, content)` on a phone regardless of the column.

The fix is to stop expressing the rule in two places: `BubbleColumn` measures the
transcript's own box with `onLayout` and `useBubbleWidth` returns ONE number.
Which rule applies is still the layout's question (a phone reads a 68 % bubble as
a ribbon); which number it produces is the column's.

| Window  | Column | Before | After |
| ------- | ------ | ------ | ----- |
| 1376 pt | 1374   | 435    | 640   |
| 1376 pt | 990    | 435    | 640   |
| 1032 pt | 646    | 435    | 439   |
| 402 pt  | 402    | 250    | 313   |

### Hermes resolves a backreference in marked's mask as the empty string

The one worth the round. `** \`example.nl\` staat op autorenew=off**` printed its
asterisks on a device while every Node test of the same string passed — including
a rendering test written for that exact string in the previous round.

`preprocessMarkdown` was innocent: a probe rendered INSIDE the app returned the
repaired `**\`example.nl\` …**`. So was `Inline`. What differed was `marked`
itself:

```js
'a `x` b'.match(Lexer.rules.inline.gfm.blockSkip) // node:   ['`x`']
// Hermes: ['` b']
```

`blockSkip` masks inline code, links and tags out of a line before `emStrong`
looks for a closing delimiter, and its code-run construct is ``(?<b>`+)[^`]+\k<b>``
— "the same run of backticks again". On Hermes that backreference matches
nothing, so the pattern degrades to "any run of backticks, then anything" and
masks the wrong span. Because `emStrong` slices the masked string by the source's
length, a mis-masked span does not merely lose a code chip: emphasis is not found
at all. Every bold or italic span CONTAINING inline code was affected, not only
the reported one.

Things that were tried and are NOT the cause, each measured on the device:

- Unicode property escapes. `/[\p{P}\p{S}]/u` matches a backtick there.
- Lookbehind. `/(?<=a)b/` works.
- The NAME. Rewriting `\k<b>` to `\3` changed nothing, and dropping the names
  with it changed nothing.
- Backreferences in general. `/(`+)[^`]+\1(?!`)/` matches `` `x` `` on Hermes.

So it is something about that backreference in that alternation, and the app does
not need to know what: `src/markdown/marked-compat.ts` rewrites the rule to say
the same thing without one. One intermediate attempt is worth recording because
it failed in a new way — spelling the run out as an eight-way alternation over
run lengths made Hermes match the pattern as the EMPTY string, which showed up as
a mask two characters longer than its source. The version that works stays as
close to marked's own pattern as possible.

Two states of the same bubble, on the iPad, as evidence of how partial a fix can
look: with the mask misaligned by two characters the bold span closed early and
ate `ff` from `autorenew=off` — worse than the original bug, and only visible on
a device.

### What this pass did NOT verify

- **The four sheet interiors, the agents bar, the cron surfaces and Activity**
  are still as Part 1 left them; this round stopped after the bug list. Their
  gallery ids exist, so they can be photographed the moment somebody restyles
  them.
- **The Mac window.** The build was run; the app was not opened on it.
- **Light theme on the iPad** and **dark on the phone**: one of each was
  photographed, not all four.
- **Android**, **Reduce Transparency** and **Reduce Motion**, as every round
  before this one left them.
- **The contrast numbers against a real screen.** They are computed from the
  token values and the compositing rules, not sampled off a device.

## The crons list against a real gateway (2026-09-20, later)

### `GatewayHttp` refused every array body

Found by opening `overlay:crons` on the iPad against the fake gateway, which is
the first time anybody had. The panel showed one line:

```
Could not load the crons: http://127.0.0.1:9119/api/cron/jobs?profile=all
answered with JSON that is not an object.
```

That message is `parseJsonObject` in `packages/gateway-client/src/fetch-json.ts`,
and `GatewayHttp.request` ran EVERY response body through it. `GET
/api/cron/jobs` answers with a bare array — `hermes serve` does, the fake gateway
does, and `listRows` in `features/cron/cron-controller.ts` carries a comment
saying so and reads both shapes. So the reader was prepared for an array that the
transport under it had already thrown away, and the crons list could never load
from any gateway at all. It is not a fake-gateway artefact and it is not new to
this round; it had simply never been looked at, because the list is three taps in
and the simulators here cannot tap.

The transport now asks only whether the body is JSON (`parseJsonBody`) and leaves
the shape to the caller. `parseJsonObject` stays where an object really is the
protocol — the status probe, the credential exchange, the token endpoints — since
an array arriving there means the address is not a Hermes gateway, and saying so
early is the whole point of that check.

**The lesson for the next round is the cheap one**: a feature reachable only
behind taps on a machine that cannot tap is a feature nobody has run. The launch
arguments exist for exactly this; `overlay:crons` and `overlay:activity` should be
part of every pass's screenshot set, not just the gallery sections.

### Counters, and what Activity still could not be made to show

`overlay:activity` renders its header and its three counter chips against the
fake gateway, and the empty state underneath. Injecting turns with
`POST /__fake/inject` — including a `Message from 🤖 …` user turn, which is what
the projection reads as an incoming bot DM — did NOT populate the timeline in the
few attempts made here: Activity derives from transcripts the app has hydrated,
and nothing had opened those chats. So the ledger ROWS are proven by the jest
suite and not by a screenshot. Somebody with more budget should open the two
chats first and then the panel.

## iOS 27 refuses to launch the app: the UIScene life cycle (2026-09-20, later)

The Release build on the owner's iPhone 17 Pro Max (iOS 27.0), built with Xcode 27
against the iOS 27 SDK, died at launch every time:

```
EXC_BREAKPOINT (SIGTRAP), main thread
UIKitCore ___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke
UIKitCore -[UIApplication workspace:didCreateScene:withTransitionContext:completion:]
```

The string behind that symbol is the whole diagnosis: _"Application failed to
launch: UIScene life cycle is required for apps built with this SDK."_ UIKit
evaluates it while the first scene connects, so nothing of ours is on the stack
and no JavaScript has run — which is why it reads as an app that never started.
It never did.

Apple announced this for the release after iOS 26: an app linked against the iOS
27 SDK that still uses the application-based life cycle does not launch. Expo SDK
54's template is exactly that — `AppDelegate` creates the `UIWindow` in
`application(_:didFinishLaunchingWithOptions:)` and hands it to
`startReactNative`, and there is no `UIApplicationSceneManifest` anywhere in the
generated project.

### Why nothing here caught it

Three gaps, and each is worth knowing on its own:

- **The iOS 26.5 simulators do not enforce it.** Under the iOS 26 SDK this was a
  runtime _issue_ — a purple warning in Xcode — and the runtime that ships with
  Xcode 27 alongside iOS 27 still only warns. Every simulator round before this
  one ran on 26.5.
- **The Mac build does not enforce it either.** "Designed for iPad" on macOS 27
  launches the same unmodified iOS binary and never trips the check, so
  `npm run mac` stayed green through the whole thing.
- **The device is the only enforcing surface anyone had used**, and installing to
  it is the one step the build agent does not do.

An iOS 27.0 runtime **is** installed on this machine, and it does enforce. The
crash reproduces on `iPhone 18 Pro` (iOS 27.0) from a plain Debug build, same
symbol, visible in `xcrun simctl spawn <udid> log show`:

```
E  Hermie[…] (UIKitCore) failure in void
   _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption(void)_block_invoke
   (UIApplication_RuntimeIssues.m:106) : Application failed to launch: UIScene life
   cycle is required for apps built with this SDK.
```

So the lesson is narrower than "test on a device": **the iOS 27 runtime has to be
in the screenshot set.** A `simctl launch` that returns a pid proves nothing on
its own — the process above got one and was gone a second later. `simctl spawn
<udid> launchctl list | grep hermie` a few seconds after launch is the cheap
liveness check, and it is now what every launch here is followed by.

### What upstream offers, and what it does not

Expo adopted the scene life cycle in **SDK 58**, and back-ported an opt-in to
**SDK 57.0.23**: `expo-build-properties` grows an `ios.enableSceneSupport`
property whose plugin writes the manifest and rewrites the AppDelegate. Both
depend on `ExpoAppSceneDelegate` and `ExpoReactNativeFactoryProvider`, which ship
in the `expo` pod from 57.0.23 onwards — the plugin refuses to run below that
version and says so.

Nothing of it reaches SDK 54. The newest patch on this line is `expo@54.0.37`,
which is what is installed; `UIApplicationSceneManifest`, `ExpoAppSceneDelegate`
and `enableSceneSupport` appear nowhere in the installed tree, checked across
every package in `node_modules`. React Native's own template adopted scenes in
`react-native-community/template#251`, on a much later release than 0.81.
So there is no patch to take, and the fix is local.

### The fix: adopt the scene, do not move the window

`plugins/with-ios-scene-lifecycle.js` writes the manifest into `Info.plist`;
`modules/hermie-scene` ships the `HermieSceneDelegate` it names. Two decisions
inside that are the interesting part.

**The delegate ships from an autolinked module, not from the Xcode project.**
`Info.plist` names the scene delegate by class and UIKit resolves it through the
Objective-C runtime, so it does not have to live in the app target —
`@objc(HermieSceneDelegate)` plus a pod is enough, which is how Expo ships its own
`EXExpoAppSceneDelegate`. That keeps `ios/` fully generated: no `withXcodeProject`
surgery, nothing to re-insert after `expo prebuild --clean`. It works because the
app target's `OTHER_LDFLAGS` already carries `-ObjC`; without it the linker would
drop an object file that nothing references at compile time, since the only
reference to this class is a string in a plist.

**The scene delegate adopts the app delegate's window rather than creating one.**
This is the opposite of the upstream migration, and the reason is a `fatalError`
in SDK 54's dev client:

```swift
// ExpoDevLauncherAppDelegateSubscriber, expo-dev-launcher 6.0.21
guard let window = UIApplication.shared.delegate?.window ?? … else {
  fatalError("Cannot find the keyWindow. Make sure to call `window.makeKeyAndVisible()`.")
}
```

That runs inside `application(_:didFinishLaunchingWithOptions:)`. A scene connects
**after** that returns, so a window created in `scene(_:willConnectTo:options:)`
does not exist yet when the dev client looks for one, and every Debug build would
die on expo-dev-launcher instead of on UIKit. expo-dev-launcher 6.0.21 cannot be
taught otherwise from outside, and it is the version SDK 54 bundles.

So the window is still born where the template puts it, and
`scene(_:willConnectTo:options:)` only finishes the job UIKit used to do
implicitly: `window.windowScene = windowScene`, size it to the scene, make it key.
Three things fall out of keeping that order, and all three are why this shape was
chosen:

- **expo-splash-screen is untouched.** It attaches the launch storyboard to the
  React _root view_, never to the window (`SplashScreenManager.initWith(_:)` is
  called from `customizeRootView`), so the hand-over does not care when the window
  meets a scene.
- **expo-system-ui keeps finding a window**, because
  `UIApplication.shared.delegate?.window` is never nil.
- **Nothing about `didFinishLaunching` changes**, which is the same thing as
  saying no other subscriber's assumptions were disturbed.

The window is explicitly resized to `windowScene.coordinateSpace.bounds` on
connect. UIKit sizes a window it creates itself from the scene; this one was built
from `UIScreen.main.bounds` before any scene existed, and on an iPad or a Mac
window that is a different rectangle. `windowScene(_:didUpdate:…)` re-applies it,
which is belt and braces — if UIKit already resizes the window with its scene, the
same rectangle is a no-op.

### The events UIKit stops delivering, and the one it does not

Once a scene delegate exists, UIKit calls the **scene's** URL, user-activity and
life-cycle methods and no longer the app delegate's. The generated `AppDelegate`
overrides three of those and forwards them to `RCTLinkingManager` and to the Expo
subscribers, so `HermieSceneDelegate` hands every scene callback back to it —
deliberately to the app delegate's own method and not to `RCTLinkingManager`
directly, because that override calls `RCTLinkingManager` itself and calling both
would deliver the JavaScript `url` event twice.

`AppState` needs no forwarding at all, and this is the part worth recording
because it is easy to assume the opposite: `RCTAppState` (RN 0.81.5) observes
`UIApplicationDidBecomeActive`, `…WillResignActive`, `…DidEnterBackground`,
`…WillEnterForeground` and `…DidFinishLaunching` on `NotificationCenter`, not on
the delegate, and `UIApplication` keeps posting all of them under the scene life
cycle. **Measured**, on the iOS 27.0 simulator, with a temporary probe on
`AppState` and no other change:

```
[probe] AppState at start -> active
[probe] AppState -> inactive
[probe] AppState -> background     ← another app brought to the front
[probe] AppState -> active         ← Hermie brought back
```

which is exactly what `attachLifecycle` needs to keep closing and reopening the
socket. The four scene life-cycle callbacks are forwarded to the app delegate
anyway: no installed `ExpoAppDelegateSubscriber` implements them today, and one
that started to would otherwise go quiet with nothing to see.

One behaviour **does** change and is accepted rather than fixed: a URL that
**cold-starts** the app now arrives in the scene's connection options instead of
in the app delegate's launch options, so `Linking.getInitialURL()` would not see
it. Hermie never receives links — ADR-0004 keeps the whole sign-in round trip
inside a WebView, and nothing in `src/` reads `getInitialURL` or listens for
`url` — so the only consumer is expo-dev-launcher, which is handed the URL through
the forwarded `application(_:open:options:)` and opens the bundle from there. The
documented dev path, `--initialUrl`, is a process argument that
`EXDevLauncherController` reads before any of this and is unaffected.

### One thing the manifest broke, and how it was caught

**The dev menu opened onto nothing.** `DevMenuWindow` (expo-dev-menu 6.0.x) is
`UIWindow(frame: UIScreen.main.bounds)` followed by `makeKeyAndVisible()`, which
is how you put a second window on screen before scenes existed and is a no-op
under them: a window with no `windowScene` belongs to no display and UIKit never
draws it. Nothing threw, nothing logged — pressing the menu simply did nothing.

It was caught by an A/B rather than by reading, and the control is worth writing
down because it is cheap: copy the built `.app`, `PlistBuddy -c "Delete
:UIApplicationSceneManifest"` its `Info.plist`, re-sign it ad hoc
(`codesign -f -s -` with the entitlements read back off the original) and install
that on an iOS **26.5** simulator, which tolerates the missing manifest. Same
bundle, same JavaScript, one key different. The menu appeared on the control and
not on the real build; that is the whole proof.

`HermieSceneDelegate` now watches `UIWindow.didBecomeVisibleNotification` and
gives its scene to any window that shows itself without one. Re-showing a window
posts the notification again, and by then it has a scene, so the guard makes it
idempotent. It is not `#if DEBUG` — a stray window is a UIKit-wide mechanism, not
a dev-only one — but in practice a Release build never creates a second window,
and React Native's `Modal` presents a view controller inside the existing one.

### The plugin fails the prebuild rather than the launch

`HermieSceneDelegate` does not patch the AppDelegate, so nothing the compiler
knows about ties the two together — and a template change would show up as a black
window or a silently dead deep link, on a device, weeks later. So the plugin reads
the generated `AppDelegate.swift` and throws unless it still contains every line
the scene delegate adopts: the `window` property, the `UIWindow(frame:)` in
`didFinishLaunching`, `in: window` on `startReactNative`, and the two
`RCTLinkingManager` calls. The error names each missing one and why it mattered.
Same idea as the required rewrites in `scripts/sync-hermes-shared.mjs`: fail loudly
at build time or produce something that silently no longer works.

`__tests__/ios-scene-lifecycle.test.ts` covers both halves — the Info.plist
transform is pure, and the AppDelegate assertion runs against a committed fixture
of the generated file with one load-bearing line removed at a time. The fixture is
also compared against `ios/Hermie/AppDelegate.swift` whenever a prebuild has run
locally, so a stale fixture is a failing test rather than a false green.

### Verified, and where

| Surface                                   | Result                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| iPhone 18 Pro, iOS 27.0, Debug            | Launches, stays alive, renders the chat screen                                                         |
| iPhone 17 Pro, iOS 26.5, Debug            | Unchanged — same screenshot                                                                            |
| iPad Pro 13" M5, iOS 27.0, Debug          | Wide layout at the scene's size, not the screen's                                                      |
| iOS 27.0 simulator, Release configuration | Launches and renders onboarding                                                                        |
| `npm run mac -- --no-open`                | BUILD SUCCEEDED                                                                                        |
| `generic/platform=iOS`, Release, signed   | BUILD SUCCEEDED; manifest in the built `Info.plist`, `_OBJC_CLASS_$_HermieSceneDelegate` in the binary |
| AppState across background and foreground | `active → inactive → background → active`, measured                                                    |
| The dev menu, iOS 27.0, Debug             | Opens; A/B'd against a manifest-free copy                                                              |

**None of that is the device.** Everything above is a simulator or a build; the
crash that started this was on a physical iPhone 17 Pro Max, and a device install
is the one step this machine does not do, so the owner's iPhone is what actually
closes this.

Two things stay unverified for want of a way to drive them headlessly: a **Mac
window being dragged to a new size** (the `windowScene(_:didUpdate:…)` path), and
**rotation** on a device — `simctl` has no rotate verb here, and the iPad screenshot
above proves the connect-time sizing only.

## A pinned theme only coloured half the app (2026-09-20, later)

Reported from the Mac build with screenshots: Settings → Appearance → Theme
pinned to **Light** while macOS itself was in **Dark**, and every glass panel —
sidebar, content panel, overlay — came out as murky dark-grey glass, with
light-theme ink on it and the light wallpaper around it. The inset Settings
groups were white cards floating on grey.

### The token set stops at the edge of what JavaScript draws

`ThemeProvider` picked the winner between the stored appearance and
`useColorScheme()` and handed it to every component as tokens. That is the whole
app as far as React Native is concerned, and about half of it as far as the
screen is concerned: a glass surface's actual material is a `UIVisualEffectView`
— `UIGlassEffect` through `expo-glass-effect` on iOS 26+, `UIBlurEffect` through
`expo-blur` below it — and a visual effect view takes its appearance from the
**window's trait collection**. The window was still following the system. So the
material rendered dark and the ink rendered light, on the same panel.

**Reproduced on an iPad Pro 13" (iOS 27.0) simulator**, which is the useful part:
this needs no Mac at all. `xcrun simctl ui <udid> appearance dark` sets the system
side and `--hermieTheme light` pins the app side, and `gallery:chat` draws the real
wide shell without a gateway. Sampled inside the sidebar panel and the chat panel:

| System | Pinned | Sidebar   | Chat panel | Build  |
| ------ | ------ | --------- | ---------- | ------ |
| dark   | light  | `#7A7F92` | `#748196`  | before |
| dark   | light  | `#EEF5FF` | `#E1F5FF`  | after  |
| light  | light  | `#EEF5FF` | `#E1F5FF`  | after  |
| light  | dark   | `#212F4F` | `#1E304F`  | after  |
| dark   | dark   | `#212F4F` | `#1E304F`  | after  |

After the fix the pinned scheme produces the identical surface whichever way the
system is set, which is the entire claim.

### `Appearance.setColorScheme` is the lever, and it is scene-shaped already

React Native 0.81's `RCTAppearance.mm` walks `UIApplication.connectedScenes`,
takes every window in them and sets `overrideUserInterfaceStyle` — so one call
covers the root window, anything presented inside it, and every native view that
reads the trait. Two things about it are worth knowing:

- **It is already written against scenes**, so the UIScene adoption earlier today
  neither helped nor hurt it. Before adoption UIKit created an implicit scene and
  `connectedScenes` was populated anyway.
- **`null` releases the override** rather than pinning whatever the system said at
  the time, which is exactly what "System" has to mean.

It is called from `ThemeProvider` for the same reason the status bar is rendered
there: it is the one component that knows which of the pinned and the system
scheme won. The pin is derived from the settings store and from `forceScheme`,
**never** from `useColorScheme()` — once the override is in place UIKit reports
the pinned scheme back as the system one, and deriving the pin from that would be
a loop with nothing to break it. The system value is only ever read when nothing
is pinned, which is precisely when no override is in place and it is honest again.

`--hermieTheme` is pinned natively too. It has to be: a dark screenshot with light
glass in it is not a picture of the dark theme.

`GlassSurface` also passes `colorScheme` to `GlassView` now — `expo-glass-effect`
0.1.x has the prop, documented for exactly this case, and a file comment here
previously said it was left on `auto` on purpose, which turned out to be wrong.
It is the same answer said twice, deliberately: the window override is the fix,
and this is what is left if a window ever escapes it.
`expo-blur`'s fallback was never affected — it is told `systemMaterialLight` or
`systemMaterialDark` by name — but the native material is what a Mac and any
iOS 26+ device actually draw.

`__tests__/theme-native-override.test.tsx` pins the behaviour: pinned light and
dark call the override, System passes `null`, and the development pin counts.

**Android gets the same call for free**, and it does the analogous thing:
`AppearanceModule.kt` maps it to `AppCompatDelegate.setDefaultNightMode`, with
`unspecified` → `MODE_NIGHT_FOLLOW_SYSTEM`. So a pinned theme now also drives the
native night mode there rather than only the tokens. Unverified on a device or an
emulator this round; it is one call and it was already the right one to make.

### Not verified

- **On a Mac window.** The report came from one; the reproduction and the fix were
  measured on an iPad simulator. The mechanism is the window's trait collection,
  which a Mac window has like any other, but the owner's screenshots are what will
  close this.
- **Reduce Transparency.** With it on there is no material to mis-colour, so the
  bug cannot occur, and that path was not re-photographed.

### Two smaller things from the same report

- **The Settings overlay said its name twice** — once in the overlay panel's bar
  and again as a large title directly under it. Activity and Crons had already
  dropped theirs, each with a comment saying both shells name the screen above it;
  Settings was the one left. Removed, and `settings-screen.test.tsx` now proves it
  came back from a sub page by the first group header instead of by the title.
  Photographed on `overlay:settings` and `overlay:crons`: one title each.
- **The overlay panel's bottom edge on a Mac-sized window: NOT REPRODUCED.** On the
  iPad simulator the panel keeps its rounded bottom and its inset from the window
  edge, and the content under it is a `ScrollView` whose content is meant to run
  past the fold. `OverlayPanel` is `position: absolute` with `top`, `bottom` and
  `right` all `WINDOW_GAP` inside a column that already carries the safe-area
  padding, so there is no obvious asymmetry to point at either. Running the Mac
  window is the one thing this agent does not do, so this is left open rather than
  guessed at — the next look should compare the panel's top and bottom insets in a
  Mac screenshot and say which one is wrong.

## Plain http to a private gateway, and what ATS actually blocked (2026-09-20, later)

Everything below was measured on the **iPhone 18 Pro simulator (iOS 27.0)** against a
**Release-configuration** build of the app, signed ad-hoc, driven by hand — not in a development
build and not reasoned from the documentation. The gateway was `npm run fake-gateway -- --host
0.0.0.0` on the Mac's LAN address, so every request left loopback.

Two addresses matter, and they are the same machine:

| Address                     | What it stands for                                                      |
| --------------------------- | ----------------------------------------------------------------------- |
| `192.168.2.250:9119`        | a bare private IP — a tailnet `100.x` address                           |
| `192-168-2-250.nip.io:9119` | a fully qualified name that resolves to it — a MagicDNS `*.ts.net` name |

`nip.io` is a public wildcard zone that answers with the address in the label, so the second row is
an FQDN in a public zone pointing at a private host, which is exactly the shape of a tailnet name
and needs no edit to `/etc/hosts` to arrange.

### `NSAllowsLocalNetworking` covers the IP and not the name

The Expo SDK 54 template writes `NSAllowsArbitraryLoads: false` with `NSAllowsLocalNetworking: true`,
and that was Hermie's configuration until this round. Measured, same binary, plist edited in the
installed bundle:

| Request                                       | Result                                     |
| --------------------------------------------- | ------------------------------------------ |
| `http://192.168.2.250:9119/api/status`        | **allowed** — the wizard found the gateway |
| `http://192-168-2-250.nip.io:9119/api/status` | **blocked**, `NSURLErrorDomain -1022`      |

```
Error Domain=NSURLErrorDomain Code=-1022 "The resource could not be loaded because the App
Transport Security policy requires the use of a secure connection."
NSErrorFailingURLStringKey=http://192-168-2-250.nip.io:9119/api/status
```

So ATS decides on the host as WRITTEN, not on the address it resolves to. A MagicDNS name is a
fully qualified name in a public zone; `NSAllowsLocalNetworking` never reaches it, and the owner's
stated case — `http://host.tailnet.ts.net` — was refused.

Two things about how this stayed hidden, and they are not the same thing:

- **On iOS there was no debug/release difference.** `Info.plist` does not vary by configuration, so a
  development build refused that address exactly as a release build did. What hid it is that
  everything this project has ever typed into the address field was `localhost`, an emulator alias or
  a LAN IP — every one of them covered by `NSAllowsLocalNetworking`.
- **On Android there is one, and it is the bad kind.** The template sets
  `usesCleartextTraffic="true"` in the debug manifest only, so every development build works and the
  release build is where it breaks.

### `NSAllowsArbitraryLoads` is IGNORED when one of its neighbours is present

This is the part that cost an hour and is invisible unless you measure it. The first attempt at a
fix shipped all three keys:

```
NSAllowsArbitraryLoads = true
NSAllowsArbitraryLoadsInWebContent = true
NSAllowsLocalNetworking = true
```

and the FQDN was still refused with `-1022`. That is documented behaviour rather than a bug: since
iOS 10, the presence of `NSAllowsLocalNetworking`, `NSAllowsArbitraryLoadsInWebContent` or
`NSAllowsArbitraryLoadsForMedia` makes the system **ignore** `NSAllowsArbitraryLoads` and use its
default of false. Writing the belt as well as the braces removed the trousers.

Deleting the other two from the same installed bundle and relaunching — one key left — allowed it
immediately. `app.config.ts` therefore sets exactly one key, and the template's
`NSAllowsLocalNetworking` goes with it, because keeping it would switch the fix off.

### What one key actually buys, all of it measured

With `NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }`, in the Release build:

| Surface                                   | Address                                                   | Result |
| ----------------------------------------- | --------------------------------------------------------- | ------ |
| `fetch` (the probe)                       | `http://192.168.2.250:9119`                               | works  |
| `fetch` (the probe)                       | `http://192-168-2-250.nip.io:9119`                        | works  |
| `ws://` (the connection test and the app) | `ws://192.168.2.250:9119/api/ws`                          | works  |
| `WKWebView` (the native sign-in page)     | `http://192.168.2.250:9119/auth/native/authorize`         | works  |
| the whole PKCE round trip                 | authorize → loopback redirect → `POST /auth/native/token` | works  |

The web view is the row worth noting: web content follows `NSAllowsArbitraryLoads` when
`NSAllowsArbitraryLoadsInWebContent` is ABSENT, so leaving the web key out does not cost the sign-in
page anything. Adding it would have cost the rest of the app everything.

End to end in that build: onboarding found the gateway over http, the connection test reported
**Connected · 2 bots**, and the chats list drew both bots live. In `--auth native` the sign-in page
rendered inside the app, "Approve as tester" produced the loopback redirect, the code exchange
succeeded and the test reported **Connected as Fake Tester · 2 bots**.

### React Native's `fetch` throws away the reason, so nothing can tell a TLS failure apart

This was found by disbelieving a screenshot. The wizard probed `https://192-168-2-250.nip.io:9119`,
where a plain-HTTP server was listening, and reported **"Could not reach …"**. The simulator's own
log said something quite different about the same request:

```
Error Domain=NSURLErrorDomain Code=-1200 "A TLS error caused the secure connection to fail."
UserInfo={_kCFStreamErrorCodeKey=-9836, …
NSErrorFailingURLStringKey=https://192-168-2-250.nip.io:9119/api/status}
```

CFNetwork knows exactly what happened. JavaScript never hears it. React Native's `fetch` is
`whatwg-fetch` over its own `XMLHttpRequest` (`Libraries/Network/fetch.js` is a three-line re-export
of the polyfill), and the polyfill's `xhr.onerror` rejects with a flat
`TypeError('Network request failed')`. The `NSError`, its domain, its code and its description are
all gone by then, and OkHttp's exception goes the same way on Android.

Consequences, and they are not small:

- **`looksLikeTlsFailure` cannot fire for a `fetch` failure on a device, on any platform.** Its
  comment claimed iOS put `-1200` in the message; nothing puts anything in the message. The
  predicate still earns its place in Node — the package is used from vitest and from the fake
  gateway's own tests, where a real error message arrives — and `strings.errors.tls` is therefore
  reachable in principle and unreachable in the app as it ships. Said plainly rather than left as a
  string somebody assumes is in use.
- **The scheme fallback always gets its chance**, because every transport failure classifies as
  `network`. That is what the tailnet case needs.
- **And the rule it was supposed to respect is weaker on a device than in the code.** The resolver
  refuses to retry in the clear when the https attempt failed over a CERTIFICATE, and on a device it
  cannot see that it did. So: a scheme-less address whose https server has an untrusted certificate,
  with something also answering as a Hermes gateway over http, will end up on http. It is not
  silent — the probe line says `Found over http://` and a public host gets the warning — but the
  guarantee lives in `packages/gateway-client` and not in the app's transport. Closing it needs the
  `NSError` surfaced through a native module, which is a bigger change than this round.

The split between `looksLikeTlsFailure` and `looksLikeCertificateFailure` stays, because it is
correct wherever a real message does arrive and costs nothing where one does not.

### What this pass did NOT verify

- **A real tailnet.** No Tailscale or Headscale node was involved. `nip.io` reproduces the SHAPE of
  a MagicDNS name — fully qualified, public zone, private address — and ATS is documented and now
  measured to judge the name rather than the address, but a `.ts.net` name was never typed into the
  app on a machine that could resolve one.
- **Android, at runtime.** `usesCleartextTraffic="true"` is in the generated main manifest and the
  template's debug manifest already carried it, so the debug/release difference is closed on paper.
  No APK was built and no emulator was run this round.
- **A real identity provider behind an http gateway.** The sign-in went through the fake gateway's
  own authorize page. The mixed-content question — an http gateway redirecting to an https IdP and
  back — is a chain of top-level NAVIGATIONS rather than sub-resource loads, which WKWebView permits,
  but nothing here exercised it.
- **The Mac window.** The Mac is the same binary and the same Info.plist, so the ATS behaviour is the
  iOS one; nothing was run in a Mac window.

## A mouse drag scrolled the transcript instead of selecting it (2026-09-20, later)

Reported from the Mac build: _"On macOS I do not want to scroll by dragging with
the mouse held down. I want to select text with that."_ Two requests in one
sentence, and they turned out to have very different ceilings. The first is fixed.
The second is at the limit of what React Native can draw, and that limit is worth
writing down, because it is invisible from the JavaScript side and it is the kind
of thing a future round would otherwise spend a rebuild rediscovering.

### Why a pointer drag scrolls: it is delivered as a touch

A "Designed for iPad" app gets full iPad pointer support, and UIKit hands an
indirect-pointer drag to a `UIScrollView` as a **touch**.
`UIScrollView.panGestureRecognizer` accepts every touch type by default, so
press-and-drag anywhere on a list pans it. Nothing in the app asked for that; it
is the platform default, and on a phone it is the only sensible one.

`panGestureRecognizer.allowedTouchTypes = [.direct]` is the whole fix, and it is
the narrowest lever available:

- it changes ONE recognizer on ONE scroll view, not a gesture policy for the app;
- a finger still pans, so a touch display or an iPad in Sidecar is unaffected;
- **a wheel or a trackpad two-finger scroll is not a touch at all.** Those arrive
  as scroll events, gated by `allowedScrollTypesMask`, which this does not touch.
  That separation is the reason the drag can be stopped without also breaking the
  way everybody actually scrolls.

`HermieMacModule.useDirectTouchPanOnly(viewTag)` applies it, on the main queue,
and `src/platform/pointer-drag.ts` is the seam. Four things about that seam:

- **`RUNS_ON_MAC` gates it, and it has to be the operating system rather than the
  hardware.** Every other Mac seam in this app could have asked a better question
  instead — `useEscapeKey` asks whether a keyboard is attached, not whether this is
  a Mac. This one cannot: on an iPad with a Magic Trackpad a pointer drag is a
  legitimate way to scroll a list, and taking it away there would be a regression
  for a reader who never asked for anything.
- **The tag handed over is the scroll view's, not the list's.**
  `getScrollableNode()` is the step down from a `FlatList` to the `ScrollView` it
  renders; without it the native side would be guessing how far down to look.
- **The native side takes the shallowest `UIScrollView` at or below the tag, capped
  at two levels.** Under Fabric the tag resolves to `RCTScrollViewComponentView`,
  whose single subview is the `RCTEnhancedScrollView` that actually scrolls. An
  unbounded search would be wrong rather than merely slow: a transcript row holds
  scroll views of its own — a wide code block, a markdown table — and finding one
  of those would leave the list panning and break the code block as well.
- **Nothing throws.** It runs from a `ref` callback during layout, so a missing
  module, an older binary or a tag the view registry cannot resolve all read as
  "not applied". A blank chat would be far worse than an unfixed drag.

Applied to every list and reading surface: the transcript, the chat list,
Activity, Crons, Settings, the licences list, the developer screen, onboarding,
`BottomSheet`'s scroll content (which is every sheet in the app — no caller
overrides `scrollable`), the sub-agent transcript, and the three horizontal
scrollers inside a bubble (code block, markdown table, diff). Not the dev
gallery, and not the slash popover or the attachment tray, which are rows of tap
targets rather than text anybody selects.

### `Text selectable` does not select. It copies the whole block

This is the half that cannot be delivered in this SDK, read out of React Native
0.81's own source rather than out of its documentation.

`RCTParagraphComponentView` implements `isSelectable` as a
`UILongPressGestureRecognizer` that presents a `UIEditMenuInteraction`, plus
`canPerformAction:` returning true for exactly one selector, `copy:`. And `copy:`
copies `dataFromRange:NSMakeRange(0, attributedText.length)` — **the entire
paragraph**. There is no selection range anywhere in the component: no selection
rects, no anchor, nothing a drag could move. So on any platform, `selectable`
means long-press, then Copy, then you have the whole text block. It is not a
partial selection that happens to need a long press.

Every bubble in the app is already `selectable`: the markdown renderer threads it
through its context and defaults it to `true`. So that half was shipped before
this round and is already at the ceiling.

**Drag-select would need a `UITextView`**, which in React Native means a
`TextInput` with `multiline`, `editable={false}` and `scrollEnabled={false}` as
the reading surface. That was considered and NOT done, because the cost is
concrete and the benefit is unverifiable from here:

- our markdown renderer emits nested `Text` for bold, inline code, links and
  tables, and a `TextInput` is not a general container for them;
- link taps go through `onPress` on an inline `Text`, which a text view does not
  have;
- the transcript is an inverted `FlatList` whose row heights drive
  `maintainVisibleContentPosition`, and swapping the measured element on the app's
  most performance-sensitive surface is not a change to make blind;
- and none of it could be checked, because the pointer behaviour it exists for
  cannot be exercised on this machine at all.

If drag-select is wanted later, that is the shape of the work, and it wants a Mac
window in front of somebody while it is done.

### What is verified, and what is only reasoned

**Verified on this machine:**

- `npm run mac -- --no-open` ends in `** BUILD SUCCEEDED **`, signed and wrapped,
  with the new native function compiled into the binary.
- The JavaScript seam, by unit test (`__tests__/mac-pointer-drag.test.ts`): an
  iPhone and an iPad make no native call at all; the tag handed over is the
  scroll view's; a detaching ref asks for nothing; and a rejection, a synchronous
  throw and a component that throws while being read are all swallowed.
- `Text selectable`'s behaviour, by reading `RCTParagraphComponentView.mm` in the
  pinned React Native — which is evidence about the renderer, not about a Mac.

**Reasoned, not watched:**

- **That the drag actually stops.** The simulators here deliver a mouse as a
  direct touch, so an indirect-pointer drag does not exist on them and no
  simulator can tell the fix from its absence. `allowedTouchTypes` is documented
  UIKit and this is its documented use, but nobody has seen it in a Mac window.
- **That wheel and trackpad scrolling still work.** Same reason, and the same
  documentation: `allowedScrollTypesMask` is a separate gate. If this is wrong,
  it is wrong loudly — the lists would stop scrolling entirely with a mouse — so
  it is the first thing the manual test below checks.
- **Whether the edit menu appears on a right-click** rather than only on a
  press-and-hold. `UIEditMenuInteraction` is what UIKit maps a secondary click
  to on a Mac, but that mapping was not observed.

### The manual test, for a Mac window

1. Open a chat with a long reply. Drag with the mouse button held down across the
   text: the transcript must NOT move. Then scroll with the wheel and with a
   trackpad: both must still scroll it.
2. Repeat on the chat list, on Activity, on Crons and inside a sheet — a drag
   moves nothing, a wheel still scrolls.
3. Press and hold on a reply (or right-click it): an edit menu appears and Copy
   puts that whole message on the clipboard. A drag selecting part of a message is
   NOT expected — see above.

## Signed out by replacing the .app bundle (2026-09-20, later)

Reported three times in one day, and reproducible: replacing `/Applications/Hermie.app` with a
newer build — same bundle id, same team, development signing — and launching it puts the owner back
in the wizard on **Step 2, Sign in**, with the gateway address still filled in. A plain Cmd+Q and
relaunch never does it. One earlier occurrence was on a fresh install.

### What that shape rules out on its own

The address survives and the credentials do not, so the two stores parted company: the address is in
AsyncStorage and the credentials are in the keychain. So the data container is intact — measured,
not assumed: `~/Library/Containers` holds exactly one UUID-named container for this app and its
parent directory's mtime predates all three replacements. Nothing about the container churned.

The precise condition the app needs to land where it landed is in two lines. `GatewayProvider`
takes the onboarding branch when `loadGatewaySetup()` returns a setup whose `hasCredentials` is
false, and the wizard opens on `signin` rather than `welcome` when `resumeConfig` is non-null. So:
`hermie.gateway.config` parsed with a non-empty `baseUrl`, **and**
`SecureStore.getItemAsync('hermie.auth.access_token')` resolved to `null`.

_Resolved_ to null, not rejected — and that is load-bearing. `loadGatewaySetup` had no `try`/`catch`
around those reads and `reload()` was called as `void reload()`, so a keychain that THREW would have
left the rejection unhandled and the app on the splash screen for ever. The owner saw the wizard, so
the keychain answered cleanly. Both of those are now fixed anyway (below), because "hangs for ever"
is a worse outcome than either.

### A clean miss is exactly what a changed access group looks like

`expo-secure-store` 15.0.8 (`ios/SecureStoreModule.swift`) builds its query at lines 172–192. It
sets `kSecAttrAccessGroup` **only** when a caller passes `accessGroup`, and this app passes none —
`src/platform/secret-store.ts` sets `keychainAccessible` and nothing else. It maps `errSecItemNotFound`
to `nil` and throws on every other status (lines 159–169). So a wrong or moved access group does not
surface as an entitlement error: the item is simply not in any group the process can see, and the
read comes back _empty_, indistinguishable from never having been written.

That means the clean read above **does not exonerate the access group**. It is precisely what a
group change would produce.

### What the build actually claims, measured

`codesign -d --entitlements - /Applications/Hermie.app` (which resolves through `WrappedBundle` to
the inner bundle). Both transcripts in this section were taken before the application identifier
moved to `dev.hermie.app` and before the paid team existed; they are reproduced with today's
identifier and with the team written as `<team>`, because the reasoning is about the SHAPE of these
strings and a team identifier is an account rather than something this repository holds:

```
Authority=Apple Development: <redacted>
TeamIdentifier=<team>
[Key] application-identifier            [String] <team>.dev.hermie.app
[Key] com.apple.developer.team-identifier [String] <team>
[Key] get-task-allow                    [Bool] true
```

**No `keychain-access-groups`.** `apps/hermie/ios/Hermie/Hermie.entitlements` was an empty `<dict/>`,
because `app.config.ts` set no `ios.entitlements`. So the effective group was entirely implicit,
derived by the system from the signing identity. The embedded provisioning profile grants
`<team>.*` and is a **seven-day automatic profile**, minted again whenever it has lapsed;
`apps/hermie/scripts/run-mac.mjs` contains **no `codesign` call at all** — the inner bundle keeps
whatever `xcodebuild` produced and the outer wrapper is not signed at all.

### The honest conclusion

The access-group STRING should be stable across builds as long as the team id and bundle id are, and
both are fixed. What demonstrably differs between "replace the bundle, then launch" (3 of 3) and
"quit and relaunch" (0 of many) is the code-signature identity of the running process: a new cdhash,
a re-registration with LaunchServices, and on at least one of today's builds a freshly minted
profile. The defensible statement is that **this app's keychain scope was implicit and derived from
signing metadata that the Mac build pipeline regenerates on every run**, and the failure correlates
3 of 3 with regenerating it. Securityd logs for the launch window were empty, so the exact attribute
that moved was not named, and this section does not pretend to name it.

### What changed, and what it is worth

Two things, neither of which is claimed as the fix:

- **`app.config.ts` now names the group.** `ios.entitlements['keychain-access-groups']` is
  `['$(AppIdentifierPrefix)dev.hermie.app']`. That is the same string the implicit default already
  resolved to, and it is first in the list on purpose: `SecItemAdd` without an
  explicit group writes to the FIRST entry and `SecItemCopyMatching` searches EVERY entry, so
  naming it moves no write and leaves every existing item readable. There is no migration. What it
  buys is that the group is declared by this repository, is auditable in `codesign`, and no longer
  depends on what the signing pipeline inferred that day. **It is prophylactic. Do not report this
  as fixed until a replace-then-launch cycle has been watched to keep the session.**

  That the write target is unchanged is measured, not argued. `codesign -d --entitlements -` on the
  bundle `npm run mac` produced after the change:

  ```
  [Key] application-identifier    [String] <team>.dev.hermie.app
  [Key] keychain-access-groups    [Array]  <team>.dev.hermie.app
  ```

  `$(AppIdentifierPrefix)dev.hermie.app` resolved to the same string the `application-identifier`
  already was — which is exactly what the implicit default resolves to. So
  the first (and only) entry is byte-identical to where items were already being written.

- **The next occurrence explains itself.** `loadGatewaySetup` now catches a refusing secret store
  and reports it as `credentialError` instead of letting the rejection escape, and `GatewayProvider`
  records `token.absent` for a clean miss and `token.read_failed` for a refusal. Before this the
  ring held nothing at all about the read, so the two were indistinguishable after the fact — which
  is why this section had to be written from first principles instead of read off the developer
  screen.

`kSecAttrAccessible` is not a suspect. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` controls when the row's
class key is available, not which process can see the row; it is applied only on write; and the
keybag holding those class keys is unchanged.

### The free diagnostic, before anything else

The ring lives in AsyncStorage, which survives. After the next replacement, sign in and open
Settings → the developer screen: the tail of the PREVIOUS session is still there. If it ends on
`dial.ready` / `token.served` with no `signin.required`, `token.cleared`, `refresh.failed` or a 4401
`ws.closed`, the session ended healthy and the credentials went missing between launches — which
rules out every server-side and refresh-path cause in one look. With the change above, that launch
will also have recorded `token.absent` or `token.read_failed`, which settles empty-versus-refused.

### What this pass did NOT verify

- **That the entitlement fixes anything.** It is a class-elimination, not a diagnosis. See above.
- **The mechanism itself.** No securityd evidence was obtainable for the launch window.
- **Whether `HERMIE_APPLE_TEAM_ID` was identical for all three of today's builds**, and whether the
  provisioning profile was regenerated between them. A different team id would change
  `application-identifier` and would be a complete, mundane explanation. The owner can answer this.
- **Anything on a real iPhone or iPad.** All of the above is the Mac (iOS-app-on-Mac) build.

## The onboarding wizard, on glass (2026-09-20, later)

The owner's note was "this page could be prettier", about Step 2. What the screenshot actually
showed was the shape every step had: a `Screen` filled edge to edge, an eyebrow and a title at the
top, one paragraph, sometimes one field, then a tall empty middle, a hairline, and a pinned footer
carrying Continue and Back. On a Mac window the middle was most of the screen and the two controls
that move the wizard forward were as far from the content they act on as the layout could put them.

### The "no taps" rule is out of date, and this pass ran on that

"Driving a simulator without touching it" (earlier today) says the simulators on this machine can be
launched and photographed and nothing else. That is still true of `xcrun simctl`, which has no tap,
swipe or key verb, and `idb`/`fbsimctl`/`maestro`/`appium` are all still absent. But the dedicated
simulator tool available to this session **can** tap and type, and it was used here: the whole
before-state of the wizard was captured by driving the real app — tapping `Set up a gateway`,
tapping the address field, typing `localhost:9119`, watching the probe answer the fake gateway over
http, and tapping through to Step 2. Its accessibility-tree read (`inspect`) is not available, so
targets still have to be found in a screenshot and converted to device points, and a screen that
re-renders between the screenshot and the tap will swallow the tap — that happened once here and
landed on a chat row instead of the tab strip.

The launch-argument channel is still worth every line of it: it is deterministic, it needs no
coordinate arithmetic, and it is the only thing that works when two changes are in flight against
one Metro instance.

### The pinned footer existed for a reason, and the reason is still true

It was not laziness: the soft keyboard covered Continue on every step with a field, so the footer was
pinned to keep it reachable. The card keeps that property by a different route — it lives inside the
same `KeyboardAvoidingView` and inside a scroll view whose content container is
`flexGrow: 1, justifyContent: 'center'`, so it is centred while it is shorter than the window and
scrolls from the top once the keyboard makes it taller. Measured on an iPhone 17 Pro with the
keyboard up on the address step: the field, its status line and the button under it are all on
screen.

### One accented block per card

The first build put the step's own action ("Sign in with Self-Hosted OIDC") and the card's Continue
next to each other as two full-width blue buttons, which reads as two ways forward rather than as
one gate. Continue is now drawn as the quiet variant while it is disabled, so the only blue thing on
the card is the action that is actually live. The rule holds on the sign-in step and on the test
step, which are the two that own an action of their own.

### Measurements

- Card: `ONBOARDING_CARD_MAX_WIDTH` 520pt, `sheet` glass, `opaque`, `space.panel` (20) padding, the
  sheet radius. Wider than `FORM_MAX_WIDTH` (480) because the card carries its own padding, its
  status lines and its actions rather than only a field; at 480 the same content wrapped one line
  more on every step.
- On a phone the card is the window minus `WINDOW_GAP` (14) plus the safe-area inset on each side.
- Progress rail: one 4pt segment per numbered step, `radii.pill`, accent for reached and `tintSunk`
  for the rest. Static, and hidden from assistive technology because the eyebrow under it says the
  same thing in words.
- Status dot: 9pt, the inline presence-bead size. Filled for an answer, a 1.5pt hollow ring for a
  question still open — the shape carries the meaning as well as the colour. Nothing pulses:
  §5 of the tokens document reserves animation for "needs input".
- The eyebrow is uppercased by `textTransform`, not by `toUpperCase()`. The string is what a screen
  reader announces and what a test reads back, and `micro` is the uppercase-label token anyway.

### Every step state is addressable

Nine new gallery sections, `--hermieOpen gallery:onboarding-*`: `welcome`, `address`,
`address-states`, `signin`, `signin-done`, `signin-token`, `signin-blocked`, `test`, `test-states`,
`done`. They matter more here than anywhere else in the kit, because the wizard is the one screen
nobody can reach twice — once a gateway is configured it never shows again — and the states worth
looking at need a gateway that is broken in a particular way. A draft carrying a `probe` needs no
probe to have run, so none of them touch the network.

### What this pass did NOT verify

- **The native sign-in web view's new glass bar on a device.** The bar was restyled and typechecks
  and renders in the gallery's sibling states, but the modal itself was not photographed: reaching
  it means completing a real PKCE round trip, and the run that would have done that collided with
  another change in flight on the same Metro instance.
- **The keyboard-up layout on Android.** `KEYBOARD_AVOID_BEHAVIOR` is unchanged, so the behaviour
  should be what it was, but it was not looked at.
- **Reduce Transparency.** The card is a `GlassSurface`, so it should fall back to its solid rung
  like every other one; unmeasured.

## The wide layout in real portrait (2026-09-20, later)

The earlier iPad pass could only produce a landscape-PROPORTIONED window by editing the installed
bundle's `Info.plist`. This one used real portrait on both sizes: iPad Pro 13" (2064 × 2752 @2x =
**1032pt**) and iPad Pro 11" (1668 × 2420 @2x = **834pt**). No hack.

### 834pt is the narrowest window that gets two panels, and 344 made it read worse than a phone

`REGULAR_LAYOUT_MIN_WIDTH` is 700, so an 11" iPad in portrait gets the sidebar-plus-detail shell.
With the old flat 344pt sidebar, measured:

| At 834pt portrait | Sidebar | Chat column | Bubble cap |
| ----------------- | ------- | ----------- | ---------- |
| Before            | 344     | 448         | ~305       |
| After             | 300     | 492         | ~335       |

The finding is the before row, not the after one: **305pt is narrower than the 314pt the same bubble
gets on an iPhone 17 Pro.** A tablet was reading worse than a phone, because 344 was chosen against a
landscape window and then applied to every window.

`sidebarWidth(windowWidth)` now answers 340 at or above 1100pt and 300 below. 335pt is about 38
characters, still short of a comfortable measure — a collapsible sidebar is the remaining lever, and
`design/liquid-glass.html` has no control for one, so it is a design decision rather than a fix.

Two consequences worth knowing:

- Narrowing to 300 clipped the fourth filter pill: the four want 311pt in a 260pt row. They scroll
  now. They were already one Dynamic Type step from clipping at 344.
- `BottomSheet.tsx` still derives the content column from the constant rather than the function, so
  between 700 and 1100pt a sheet is parked about 40pt further right than the column's real left
  edge. It errs INWARD — the sheet never reaches the chat list, which is what §6.9 actually forbids
  — so it is left for a round where `__tests__/sheet-width.test.tsx` is in scope.

### The tab strip was never missing from the real shell

Reported as possibly absent in portrait. It is present in `RegularShell` at full height in both
themes, verified on the running app rather than read out of the code. What was missing was the
GALLERY's mimic of that shell, which mounted `BotsScreen` without `onOpenSection` — the only thing
that renders the strip. So the mimic was lying about the layout it exists to stand in for, which is
worse than a missing strip, and it now passes a no-op handler.

### `contrast:check` does not measure avatar tints, and that is why they were washed out

The avatar circle sat **1.02–1.20 : 1** from the panel behind it, while the initial drawn on it
measured a comfortable 5.4–8.7. Only the second number had ever been taken, so a row that reads as a
letter floating on glass passed every check the repo has. The palette now separates at 1.38–1.51
light and 1.45–1.67 dark with the initial still above 5.73.

`npm run contrast:check` reads composited surfaces out of `tokens.ts`. An avatar tint is neither a
token surface nor an ink pair, so it is outside those 185 pairs **and has to be measured by hand
when it changes.** Worth remembering before trusting a green check about anything drawn from a
palette that does not live in `tokens.ts`.

### One simulator trap

A simulator that has never run the dev client shows the Expo developer-menu sheet over the app.
Setting `EXDevMenuIsOnboardingFinished` in the app's preference plist only sticks while the device is
**shut down**; written against a booted device it is overwritten on the next launch.

### What this pass did NOT verify

- **Whether 834pt is acceptable to the owner at 300.** It is measurably better and still tight; the
  collapsible sidebar was deliberately not built, because the control does not exist in the design
  board and inventing one is a decision rather than a fix.
- **Anything between 700 and 834pt**, which is a Mac window dragged narrow and was not tried.
- **Android, and Reduce Transparency**, unchanged from previous passes.

## Two things about an inverted list that the rhythm depended on (2026-09-20, later)

Both of these came out of chasing a gap that was too small in one direction and too big in the
other, and both are the kind of thing that is obvious once stated and invisible until then.

### A cell carries the inversion a second time, so `marginTop` really is the gap above

An inverted `FlatList` flips the scroll view, and then flips each cell back. So what is INSIDE a cell
still reads top to bottom on screen and a `marginTop` on a row is the gap above that row, exactly as
it looks. Only the ORDER of the cells is reversed. The same holds for `ListHeaderComponent`, which
is why a `paddingTop` inside the header is the gap above the header on screen even though the header
is the newest thing in the list.

### `ListHeaderComponent` is what `maintainVisibleContentPosition` anchors on

On iOS the algorithm takes the scroll view's first subview at or after `minIndexForVisible`, records
its frame before the commit, and corrects `contentOffset` by the origin delta afterwards; inside the
same branch, `autoscrollToTopThreshold` then animates back to the top. A header that comes and goes
between renders therefore moves that anchor by its own height, and the list corrects for a shift
that never happened — which is a jump followed by a scroll back down, the owner's exact description.

The transcript's header is now **always rendered**, holding the typing bubble when there is one and
nothing when there is not. Subview zero is then a fixed anchor whose origin never moves and only its
height changes, which is what the algorithm is built for.

**This is derived from the React Native source, not from a recording.** It is a real mechanism and
one half of it is now removed, but the owner's jump was never observed happening and never observed
stopping — see below.

> **Superseded.** A recording (see "The transcript jump, recorded at last", below) showed the header
> is never the anchor: `VirtualizedList` adds one to `minIndexForVisible` whenever a header exists, so
> the native loop starts at the first cell. The header is gone and the prop is now held only while the
> reader is scrolled away.

### What this pass did NOT verify

- **That the streaming jump is fixed.** Not reproduced end to end. Two of the four suspects were
  ruled out from the code — item keys are already stable across typing → streaming → settled →
  rowId-adopted (`packages/transcript/src/reconcile.ts` adopts the current id rather than renaming),
  and nothing calls `scrollToOffset` automatically — and the anchor mechanism above is the third.
  The fourth, a reasoning disclosure appearing and collapsing mid-turn, **could not be exercised at
  all: the fake gateway never emits `reasoning.delta`.** Adding that to `packages/fake-gateway` is
  the prerequisite for testing it, and is the obvious next step.
- **A before-and-after pair for the typing bubble.** Only the after exists; the simulator was shared
  with another change in flight and the before capture was abandoned rather than leave the file in a
  reverted state.

## Normal Mac behaviour, end to end (2026-09-20, later)

The owner asked for four things by name — a right-click menu on a chat row, hold
and drag to reorder, a right-click menu on a message, and "everything else that
makes it feel like a Mac app" — and for the transcript bug that two rounds had
failed to pin down. Three of the five have a mechanism worth writing down,
because in each case the obvious approach is the wrong one and the reason is not
visible from JavaScript.

### React Native has no secondary click, so the menu has to be a native view

There is no `onContextMenu`, no `onSecondaryClick` and no modifier on a press.
`Pressable` offers `onLongPress`, which is why the chat list's row menu was a
bottom sheet: a press and hold was the only secondary gesture available on every
platform Hermie ships. A right click on a Mac or an iPad trackpad did not reach
the app at all.

`UIContextMenuInteraction` is the whole answer and it is attached to a HOST view
— `HermieContextMenuView` in `modules/hermie-mac` — that draws nothing and lays
its children out as a `View` would. So a call site wraps the tree it already had,
and a build without the native side renders the same tree with the wrapper gone.

Four things come with the interaction that a drawn menu would have to reimplement:
the system's glass, size and placement including flipping near a window edge; the
target lifting into a preview, which is what says "this menu belongs to THAT row";
arrow keys, Return and Escape; and the secondary click itself, which UIKit maps to
the interaction without being asked.

Two decisions inside it:

- **The `UIMenu` is built in the action provider, not when `items` changes.** A
  row's menu carries the row's state — which colour is ticked, Archive or
  Unarchive, which sections exist — and that changes while the menu is closed far
  more often than it is opened. Building late means it cannot be stale.
- **`items` is a plain `[Any]`, walked by `HermieMenuNode`, not an ExpoModulesCore
  `Record`.** A menu is a tree, and a record whose field is an array of itself is a
  recursive reflection problem. The walk is the same amount of code with no such
  question in it.

The JavaScript side probes availability by asking the MODULE for
`setClipboardString`, a function added in the same change. `requireNativeView`
throws for a view that is not registered, and it throws at module scope where
nothing can catch it usefully; a binary that answers yes to the function has the
view, and a binary that answers no is never asked for it.

### `Text selectable` and a context menu cannot both have the gesture

`selectable` is not a selection — it is a `UILongPressGestureRecognizer` that
presents a `UIEditMenuInteraction` whose only action copies the whole paragraph
(measured last round from `RCTParagraphComponentView.mm`). With a context menu on
the same view, two interactions race for one press. So the markdown renderer's
`selectable` now defaults to `!HAS_NATIVE_CONTEXT_MENU`: the menu does the same
copy, with the choice of words or markdown, and there is one gesture.

### The drag is claimed, never assumed

A plain drag has to keep doing what it did: scroll on a phone, and nothing at all
on a Mac, where `useDirectTouchPanOnly` already stops a pointer drag panning a
list. So the reorder is long-press-THEN-move. The row's own `onLongPress` arms it
and the first move past a 6pt slop claims the responder from the `Pressable`,
which cancels the press so the chat does not also open.

That is also, for free, how it coexists with the context menu.
`UIContextMenuInteraction` cancels itself when the touch moves and its delay is
longer than the 300ms arm, so holding still gets the menu and holding then moving
gets the drag. Nothing arbitrates that; the two gestures are simply distinct — the
same split the Files app has.

On Android a long press still opens the fallback sheet, because that sheet is the
only menu there and Move up / Move down live in it. `armEnabled` is off, and the
drag is reached through edit mode's handle, which claims the touch outright.

`PanResponder` and `Animated`, not a gesture library: ADR-0010 keeps those out of
the chat surface and the list is not the chat surface, but two native
dependencies, a Babel plugin and a worklet runtime for one gesture on one screen
is not a trade this needed.

### The menu bar is installed onto the app delegate's class at runtime

`buildMenu(with:)` is a `UIResponder` method and UIKit calls it on the APP
DELEGATE. Hermie's app delegate is generated (`apps/hermie/ios` is not committed),
`ExpoAppDelegateSubscriber` has no menu hook, and the scene delegate is not an
alternative — a scene is in the responder chain, its delegate is not. So
`HermieMenuBar.install()` adds `buildMenuWithBuilder:` and a command selector to
the delegate's class with `class_addMethod`, from the module's `OnCreate`.

It ADDS, it does not swizzle: `UIResponder`'s own implementation does nothing and
nothing installed here implements it, so there is no previous behaviour to chain
to, and `class_addMethod` fails outright if the class already defines the method —
which reads as "no menu" rather than as a silently replaced one.

⌘W is the one standard item that is replaced. The owner asked for it to close the
overlay or sheet one level, the way Escape does; with `UIMenu.Identifier.close` in
place the keystroke never reaches the app. It is removed and a Close of Hermie's
own takes the same key equivalent, so the shortcut stays discoverable. The
consequence is stated plainly: **⌘W on a bare chat list now does nothing**, and
⌘Q is how the window closes.

### The shortcut seam is an allow-list for a privacy reason, not a tidiness one

The keyboard half reads GameController's `keyChangedHandler`, the same handler
Escape uses, and that handler sees every key in the app — including keys typed
into the composer and into a password field, because it is below the responder
chain. So nothing is emitted unless Command (or Control, for Tab) is held AND the
key is in a fixed table. There is no path from a letter to JavaScript through this
seam. Shift disqualifies everything, so ⌘⇧K is not ⌘K.

`UIKeyCommand` was not used for the keyboard half for the reason Escape is not
one: a presented `Modal` leaves the responder chain, and a shortcut that stops
working while a sheet is open is a shortcut nobody trusts. The menu bar's items
ARE key commands — a menu bar has no alternative — and they route to the same
event, so the two cannot drift.

### The transcript jump: one comparison in RCTScrollViewComponentView

This is the round it was actually found, and the previous round's fix was aimed
one step to the side of it.

`_prepareForMaintainVisibleScrollPosition` picks the anchor like this:

```objc
hasNewView = subview.frame.origin.y + subview.frame.size.height
             > _scrollView.contentOffset.y;
```

At the bottom of an inverted list `contentOffset.y` is **0**. A ZERO-height header
at origin 0 therefore fails that test — `0 > 0` is false — and the loop walks past
it to the first CELL. Last round's fix made the header always rendered and
zero-height when idle, which removed the mount/unmount but left the header out of
the anchor role exactly when it mattered.

With the first cell as the anchor, anything that changes height above it in
content order moves its origin, and at the bottom of an inverted list that is:
every message sent, and every appearance and disappearance of the typing bubble.
`_adjustForMaintainVisibleContentPosition` then corrects `contentOffset` by the
delta and, because the offset was within `autoscrollToTopThreshold`, calls
`scrollToOffset(0, animated: YES)`. That is the owner's description exactly: it
jumps up, then scrolls back.

The fix is two facts rather than one behaviour:

1. **The header is a one-point spacer whose height never changes.** One point wins
   `hasNewView` at every offset a reader can be at the bottom with, including a
   rubber-band bounce, so the anchor is always that view, its origin is always 0,
   and the delta is always 0. Scrolled away, the loop walks past it to a genuinely
   visible row, so pagination at the far end is unaffected.
2. **The typing bubble is a pinned sibling BELOW the list, not content inside it.**
   Its height still comes and goes, but a change to the scroll view's own frame
   moves no subview origin. It is the same shape as the agents bar, which is pinned
   above the list for the same kind of reason.

`__tests__/chat-ui/transcript-anchor.test.tsx` holds both as the invariant "while
at the bottom, a streaming turn never changes the visible offset except by
growth", expressed as the two structural facts, because the correction itself
happens in UIKit where a test renderer cannot watch it.

### The fake gateway could not produce the turn that triggers it

Last round's note ended with "the fake gateway never emits `reasoning.delta`" as
the obvious next step, and it was. A scripted reply now takes `reasoning` deltas,
one `reasoningAvailable` frame and `toolGenerating`, and the DEFAULT scenario uses
all three — so `npm run fake-gateway` produces a turn that thinks before it
speaks, which is the ordering that makes the client create its assistant item
before any text exists and therefore replaces the typing bubble mid-turn.

`toolGenerating` is a flag rather than automatic because several in-process tests
pass their own scenarios and count frames; the default scenario is where it is
exercised.

### Verified, and where

**Verified on this machine:**

- `npm run typecheck`, `npx eslint apps packages scripts`, `npx prettier --check`,
  `npm test`, `npm run test:app` — all green, including the new suites
  `context-menus`, `drag-reorder`, `desktop-shortcuts` and `chat-ui/transcript-anchor`.
- The three new Swift files COMPILE and their symbols are in the built product.
  Demangled from `libHermieMac.a`: `HermieContextMenuView.contextMenuInteraction(_:configurationForMenuAtLocation:)`,
  `HermieMenuNode.element(onSelect:)`, `HermieMenuBar.install()`,
  `HermieMenuBar.setMenuBar(titles:chats:)`.
- The app builds, installs and RUNS on the iOS 27 iPad Pro 13" and iPhone 18 Pro
  simulators with the new module linked, in both themes, with no layout
  regression from moving the typing bubble out of the list.

**Reasoned, not watched — and the list is longer than usual this round:**

- **Every one of the context menus actually opening.** A menu needs a secondary
  click or a long press, and this machine has neither: `xcrun simctl` has no touch
  verb and the tooling that can drive a simulator by other means was not available
  in this session. The JavaScript contract is unit tested end to end (items in,
  action out) and the interaction is documented UIKit, but nobody has seen one of
  these menus on screen.
- **The drag.** Same reason. The arithmetic between the visible list and the flat
  arrangement is tested as a pure function; the gesture itself is not.
- **Every keyboard shortcut, and the whole menu bar.** The menu bar exists only on
  a Mac, which cannot be launched here (ADR-0011).
- **Whether `class_addMethod` lands on the Expo app delegate.** It is guarded and
  reports `isMenuBarInstalled()`, so the failure mode is "no Hermie menu" rather
  than a broken one, but the success case is not observed.
- **That the transcript jump is gone.** The cause is now identified from React
  Native's own source rather than suspected, and the two structural facts that
  make the correction unreachable are asserted by test — but the jump itself was
  never observed happening and has not been observed stopping.

### What this pass did NOT do

- **Tool cards and bot-to-bot roll-ups have no Show details line.** A tool card
  keeps its own `useState` with a third state — "the reader has not decided", which
  is what lets a verbosity change still open it — and a roll-up is keyed by run
  rather than by item id. Neither fits the shared disclosure store a boolean set
  can express. The cron card does, and has the line. Wiring the other two is its
  own change.
- **Cmd+F.** There is no transcript search to focus, so the shortcut was left out
  rather than added as a key that does nothing.
- **Jump to reply** on a message menu. There is no stable id on the reply side of
  a bot-to-bot exchange to jump TO; `Open @handle's chat` is what shipped instead.
- **A hover screenshot.** Pointer emulation needs a pointer, and see above.

### The manual test, for a Mac window

Six things, in this order. The first three are what was asked for by name; the
last three are the ones nothing here could watch.

1. **Right-click a chat row.** A system menu opens under the pointer with the row
   lifted behind it: Open, Mark as read, Colour ▸, Move to section ▸, Move up /
   down, Add divider above, Archive. Arrow keys move the highlight, Return chooses,
   Escape dismisses. Colour ▸ shows a tick on the colour that chat is on.
2. **Right-click a message.** Copy text, Copy as Markdown, Copy link ▸ (one line
   per link), and on a bot-to-bot line `Open @writer's chat`. Copy text pastes the
   words; Copy as Markdown pastes the syntax. Dragging across the bubble must NOT
   start a selection on top of the menu.
3. **Hold a chat row and drag it with the mouse.** Press and hold for a beat, then
   move: the row lifts with a shadow and a line shows where it lands. Drag across a
   section heading and drop — the chat changes section. Hold WITHOUT moving and you
   should get the menu from (1) instead, not a drag.
4. **⌘K, ⌘,, ⌘1…9, ⌘↑/⌘↓, ⌃Tab, ⌘W.** Search focuses, Settings opens, the numbers
   open the nth chat in the list as you see it, the arrows step between chats, ⌘W
   closes one level — and ⌘W on a bare chat list now does nothing at all, because
   the window's standard Close was replaced. ⌘Q still quits.
5. **The menu bar.** A **Chats** menu between View and Window, holding Search…,
   Settings…, Close and the first nine chats by name with ⌘1…9 beside them. Edit ▸
   Copy / Paste / Select All must work in the composer.
6. **Send a message to a bot and watch it think.** The transcript must not jump up
   and scroll itself back — not when the message is sent, not when the typing dots
   appear, and not when they are replaced by the reply. Run the fake gateway with
   no arguments; its default reply now thinks before it speaks, which is the turn
   that used to trigger it.

## Android (2026-09-20)

The first Gradle build, the first APK and the first run of a **release** build on Android. Everything
below was measured on a `Medium_Phone` AVD — Android 17 (API 37), arm64, 1080×2400 at 420 dpi, so
411 dp wide in portrait and 914 dp in landscape — against `npm run fake-gateway -- --auth token
--token demo` on the host, reached at `http://10.0.2.2:9119`.

### The documented way to get a JDK does not work here, and the reason is not Java

`brew install --cask temurin@17` installs a `.pkg`, and a cask that installs a pkg runs `sudo
installer`. There is no passwordless sudo on this machine, so the command cannot complete
unattended. `brew install openjdk@17` is a formula, needs no sudo, and gives the same JDK 17 —
17.0.20.1 here.

It is **keg-only**, which is the part that bites. Homebrew does not link an alternate-version JDK
into `/Library/Java/JavaVirtualMachines`, and that directory is the only place `/usr/libexec/java_home`
looks. So the recipe in the 2026-09-19 section — `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`
— still reports "Unable to locate a Java Runtime" with a working JDK 17 installed. Name the keg:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
```

The symlink Homebrew's caveat offers is the thing that needs sudo, so it is not a way round it.

### What the SDK actually has to contain, which is not what CONTRIBUTING said

`expo-root-project` resolves the versions; asking Gradle rather than guessing:

```sh
./gradlew -q app:properties | grep -E 'compileSdk|targetSdk|minSdk|buildTools|ndkVersion'
```

| Setting      | Value         |
| ------------ | ------------- |
| `compileSdk` | 36            |
| `targetSdk`  | 36            |
| `minSdk`     | 24            |
| `buildTools` | 36.0.0        |
| `ndkVersion` | 27.1.12297006 |

CONTRIBUTING asked for "platform 35, build-tools 35", which is a version behind what SDK 54 wants
and would not have built. Corrected there.

`cmdline-tools` was absent, so there was no `sdkmanager` and no `avdmanager`. Nothing needed them —
platform 36, build-tools 36.0.0 and the NDK were already installed — but creating an AVD does.
`brew install --cask android-commandlinetools` is a cask that only extracts, so it needs no sudo;
point it at the real SDK with `--sdk_root=$ANDROID_HOME`, because it defaults to its own.

### Both builds pass unmodified

`npx expo prebuild --platform android --clean` then `./gradlew assembleDebug assembleRelease`:
**BUILD SUCCESSFUL in 2m 51s**, 1304 tasks, no config-plugin change and no edit to anything under
`android/`. Debug 177 MB, Release 105 MB — both carry all four ABIs
(`reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64`).

**The release APK was debug-signed, because on this date there was no key to sign it with.**
`app/build.gradle` gave the release build type `signingConfig signingConfigs.debug`, the React
Native template's default. That is no longer the whole story: the upload key exists now — with the
owner, never in this repository — and `app/build.gradle` picks it whenever all four
`HERMIE_UPLOAD_*` values reach Gradle, keeping the debug signing only when one of them is missing,
so a fork and a secretless CI job still build. A debug-signed release still installs and runs, and
Play still refuses it, which is why the build prints the key it used on one `hermie:` line instead
of leaving it to be assumed. See `docs/release.md` and the 2026-09-21 section at the end of this
file.

### Cleartext works in the release build, which is the thing that had never been checked

The 2026-09-20 ATS section closed the debug/release gap "on paper" and said so. Measured now, in the
**release** APK, typing the scheme-less address `10.0.2.2:9119` into the wizard:

| Surface                     | Result                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| the probe, `https://` first | fails, falls back                                                  |
| the probe, `http://`        | `Hermes 0.21.3-fake · session token required · Found over http://` |
| `ws://10.0.2.2:9119/api/ws` | REST, WebSocket and Profiles all green, **Connected · 2 bots**     |

So `usesCleartextTraffic: true` reaching the **main** manifest — not just the template's debug one —
is confirmed by a run rather than by reading the generated XML. Onboarding completed all four steps,
the credentials went into `expo-secure-store`, and a cold restart came straight back to the chats
list with both bots.

### An AVD reports Reduce Motion, and nothing in the app is wrong

`Connection test` printed `reduce motion: true` on a device with no accessibility setting touched.
A stock AVD ships with all three animation scales at zero:

```sh
adb shell settings get global animator_duration_scale   # 0
```

React Native maps `animator_duration_scale == 0` to `isReduceMotionEnabled()`, so `theme.reduceMotion`
is true and the typing dots, the presence pulse and the panel slide all correctly collapse to their
static forms. **A default emulator therefore exercises only the reduced-motion half of the app**, and
a run that does not say which half it was looking at is not evidence about the other. Turn them on
before judging any animation:

```sh
adb shell settings put global animator_duration_scale 1
adb shell settings put global transition_animation_scale 1
adb shell settings put global window_animation_scale 1
```

The same screen is the fastest confirmation of the rest of the platform seam: `iOS app on a Mac:
false`, `hardware keyboard: false`, and **`glass material: solid`** — the fallback path the elevation
ladder exists for, drawn on a device for the first time. It reads correctly in both themes; the
wallpaper gradients, the bubble tails and the ticks (all `react-native-svg`, including the tail's
`scaleX: -1` mirror) render with no seam.

### A `Modal` hears the back button; nothing else does

This is the one real gap the run found, and it splits in two.

Every sheet was already correct, and not by accident: a `Modal` consumes the back press itself and
answers `onRequestClose`, so `BottomSheet`'s `blocking ? undefined : onRequestClose` makes a blocking
approval swallow the key exactly as ADR-0010 requires. Confirmed by hand — back on the permission
sheet did nothing at all.

What had nothing was every surface that is **not** a Modal:

- `OverlayPanel` — Activity, Crons and Settings on the wide layout. A back press went to the
  activity and **left the app for the launcher** with the panel still open.
- the pages Settings opens over itself (Licences, the connection test, the gallery) and a cron's
  detail and run pages. These are state inside their screen, not navigator entries, so back popped
  the whole screen instead of returning one level — on the phone layout as well.

All of it had been written against `useEscapeKey`, whose comments say "Escape goes back exactly ONE
level" and mean it; the stack is real and the ordering falls out of mount order. It simply never
fires off an Apple keyboard. `src/ui/useHardwareBack.ts` is a second stack beside it with the same
rule, and the two are deliberately separate: `Composer` registers Escape to stop a running turn, and
a back press that stopped generating instead of leaving the chat would be a worse answer than the bug.

One sheet needed its own line rather than the hook. The chat options sheet's pages are inside a
Modal, so the press arrives as `onRequestClose` — which closed the whole sheet. It now reads
`pane === 'root' ? close() : setPane('root')`, the same one level, said to the platform's own
dismiss request.

### An elevation shadow shows through anything translucent

The disabled send button drew a lighter **octagon** inside its circle. Android paints an elevation
shadow behind the view and clips nothing, so at `opacity: 0.35` the fill stopped hiding its own
shadow and the platform's polygon approximation of a circle read straight through it. iOS clips a
shadow to outside the view's path, which is why it was never visible there.

The fix is to drop the shadow while the control is dimmed — a disabled button has nothing to float
above. Worth remembering as a rule rather than as one button: **`...theme.shadows.*` on a view whose
opacity is below 1 is visible on Android.**

### The keyboard, the insets and the status bar

`KEYBOARD_AVOID_BEHAVIOR = 'padding'` is correct and is now watched rather than reasoned about. The
onboarding card lifts fully clear — Continue and Back both reachable with the keyboard up, which is
the failure the 2026-09-19 section called the worst thing on Android — and so do the composer and
the sheets. Edge-to-edge insets are right everywhere: the tab strip clears the gesture pill, the
native stack header sits below the status bar, no overlap anywhere.

The status bar is the `ThemeProvider` fix, confirmed the only way that means anything: the **app**
pinned to Dark while the **system** was still Light gave light ink on the dark wallpaper. Pinning
also proved the other half — `Appearance.setColorScheme` maps to `AppCompatDelegate.setDefaultNightMode`,
which is a `uiMode` configuration change, and `uiMode` is in the activity's `configChanges`, so
nothing remounted: the Settings scroll position survived the switch.

### The wide layout needs no tablet

`REGULAR_LAYOUT_MIN_WIDTH` is 700 and this phone is **914 dp in landscape**, so rotating it is enough
to get the two-panel shell — no tablet AVD required, which is worth knowing before anyone builds one:

```sh
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
```

Sidebar plus detail panel, the tab strip present in the sidebar (the gallery's portrait lie stays
fixed), wallpaper around both panels, and the overlay panel over the chat column.

### The file upload, and why it had never run anywhere

`expo-document-picker` with `copyToCacheDirectory: true` hands back a `file://` URI in the app's own
cache, not the `content://` the picker started from, so React Native's `FormData` streams it as-is
and nothing on the Android side needs a branch. Measured end to end: a 25.99 kB file chosen from the
system picker arrived as

> I received ui.xml (**25987 bytes**) at `/root/projects/researcher/uploads/hermie/2026-09-20/8setj4h3-ui.xml`

which is the picker's own byte count, the `<cwd>/uploads/hermie/<date>/<random>-<name>` convention,
and proof that `@file:` expanded on the far side.

**It could not have run before today, on any platform.** `packages/fake-gateway` answered
`session.resume` without `cwd`, and `uploadFile` refuses rather than guesses when the session reports
no working directory — so every attach stopped at "No workspace to upload into" before a request was
made, and the server's own upload route, its absolute-path rule, its 100 MB cap and its "I received N
bytes" reply were all unreachable. The server now reports one.

### Found on the way: a file-only send comes back twice

> **Fixed since**, in the transcript package — see "The file-only duplicate, fixed" at the end of
> this file. The report below is left as it was written, because it is what the diagnosis was based
> on and one line of it turned out to be incomplete.

With the upload path reachable for the first time, sending an attachment **with no text** paints two
outgoing bubbles: the optimistic one showing `ui.xml` and the persisted row showing
`8setj4h3-ui.xml`.

`reconcile.ts:323` indexes the live tail for pairing with

```ts
if (item.rowId !== undefined || !normalizedItemText(item)) {
  continue
}
```

so an item whose projected text is **empty** is never a candidate, and a file-only turn projects to
exactly that. The 2026-09-20 duplicate work fixed the case where the two sides projected to
_different_ text; this is the case where they project to _no_ text and the attachments are all there
is to match on — and those do not match either, because `beginLocalTurn` replaces the projected
`@file:"…"` refs with the friendlier display name while the persisted row keeps the directive.
`UserItem.attachments` is documented as holding the directive strings, so the optimistic side is the
one departing from the contract.

Not fixed in that pass: it is shared code, it is not an Android defect, and the honest repair is to
give the optimistic item the projected refs to match on without losing the friendly chip — a change
to the transcript package's contract and its tests, not a line. Filed as what it is.

### What this pass did NOT verify

- **The native sign-in flow.** `--auth native` was not run on Android, so neither the in-app WebView
  nor `webViewMayCarryHeaders()` returning false with extra headers configured — the documented
  refusal path — was watched. It is the largest untested branch on this platform.
- **A real device.** Everything here is one arm64 emulator. No physical hardware, no other OEM skin,
  no API level below 37, and `minSdk` is 24.
- **Play signing, and anything downstream of it.** This pass had no upload key, so its release APK
  was debug-signed and no bundle was built at all. Both are signed now (see the 2026-09-21 section
  at the end of this file), but nothing has been uploaded and the upload key has not been registered
  with Play. Notifications are unchanged by that: ADR-0017 is accepted and the Hermie Web half is
  written, but the app has no `expo-notifications` dependency and no call site, so there is still no
  device-side path to test.
- **The photo picker.** The attach menu's photo entry was opened but no image was picked, so
  `expo-image-picker` → `ImageManipulator` → `image.attach_bytes` is still the 2026-09-19 result
  rather than this one's.
- **Haptics.** `VIBRATE` is in `blockedPermissions`, so `haptic()` reaches a native module that
  cannot fire. It cannot crash — every branch catches — but nothing buzzes on Android and the
  comment in `app.config.ts` that says "nothing in the app vibrates" reads oddly next to four call
  sites that ask it to.
- **A long transcript's frame rate.** The wallpaper stacks a base gradient plus a bloom per corner
  behind an inverted list, and no frame timings were taken on a device whose GPU is software.
- **One thing seen once and not diagnosed.** After dismissing the keyboard with the back button
  during a streaming turn, the transcript was left slightly above the bottom with the jump pill
  showing over the newest bubble; tapping the pill recovered it. Not reproduced deliberately.

## The file-only duplicate, fixed (2026-09-20, later)

The repair for the report above. Nothing platform-specific: it is all in `packages/transcript` plus
the chat controller that feeds it, and it is here rather than in the package's own README because
what is worth keeping is the reasoning about the wire, not the API.

### One contract for `UserItem.attachments`, and a key that reads it

**The contract.** `attachments` holds the `@file:` / `@image:` reference strings and nothing else,
whichever side built the item. `beginLocalTurn` takes a file's reference out of the body it was handed
— the prompt is how a file reaches the agent at all, so the projection already has the directive the
row will repeat byte for byte — and unions it with what the caller passed, dropping neither. The
caller passes references too: `attachmentReferences` in the chat controller builds a file's with the
same `fileReferenceFor` the prompt uses, and an image's with `imageReferenceFor`, which puts the file
NAME in the path position because nothing else is knowable. The friendly chip is not stored at all any
more; `attachmentName` derives it from the reference at render time, which is what it already did.

**The key.** `itemMatchKey` is the text and the attachments, and `attachmentsMatchKey` reduces a
reference to `<kind>:<base name>`, sorted. The base name is where the asymmetry is absorbed: an
attached image's path is chosen by the gateway at persist time and the client only ever knew the name
it handed over, so comparing paths could never have worked, while comparing names pairs
`@image:shot.png` with `@image:/srv/work/.hermes/images/shot.png` and still keeps a picture apart from
a document of the same name. Both reconcilers stopped indexing on text alone: the candidacy guard is
now `isMatchable`, which is true for an item that says something **or** carries something.

Two file-only sends carrying different files are still two bubbles — the sets differ — and an ordinary
message is unaffected, because its row carries no attachments and an empty set on either side leaves
the text to decide.

### The report was right about the cause and wrong about one line

It named `beginLocalTurn` as "the one departing from the contract", which is true and is not the whole
of it: even with the optimistic item holding the projected refs, `reconcile.ts` would still have
skipped it, because the candidacy guard tested the TEXT. Both halves had to move, and the guard is the
half that also breaks a full re-hydration rather than only the tail sweep.

### And one thing the report did not mention

`applyResumeSnapshot` projected `inflight.user` through `stripUserText` but kept only the `.text`, so
reopening a chat in the middle of a file-only turn painted an **empty bubble** — and the row that
landed for it then had nothing to pair with either, so it became a second one by a second route. The
resume projection carries the references now. It surfaced from running a file-only conversation
through the whole convergence table in `duplicate-turns.test.ts` rather than only through the tail
sweep the report described, which is the argument for that table existing.

`resumeOverlap` is the one place the attachment comparison is deliberately one-sided. `inflight.user`
is the submitted BODY rather than the persisted row, so it names a file but never an image, and
insisting on a set the body cannot carry would have painted every image send twice on resume. It
compares only when both sides name something.

### What this is verified against

`packages/gateway-client/src/bot-chat.test.ts` drives the whole sequence against a real
`startFakeGateway` over HTTP and a WebSocket: upload the bytes to `/api/files/upload-stream` under the
session's own `cwd`, submit a prompt that is nothing but the reference, then the tail sweep and a full
re-hydration, with one bubble asserted at each stage and the agent's reply naming the file.

**Not verified against a real `hermes serve`.** Specifically, that a real gateway persists a
file-only prompt verbatim (the fake one does, and `prompt_turn.py` says it should), and that its
`@image:` rewrite at persist time carries the name the client sent — the base-name match assumes it
does, and the only evidence is the fixture in `duplicate-turns.test.ts` written from the 2026-09-19
pass. The fake gateway does not rewrite image directives at all, so an image-only send against it
persists a row that projects to nothing and is dropped; the image-only path is pinned by unit tests
with a hand-written row, not by a run.

## Hiding the sidebar, and four icons that were never the same size (2026-09-20, later)

Two things measured on iPad Pro 11" (834pt portrait) and 13" (1032pt portrait)
simulators, both iOS 26.5, against the real `RegularShell` rather than the
gallery's mimic of it.

### The mimic could not have shown either of them, so the gallery now mounts the real shell

`--hermieOpen gallery:chat` frames one gallery section in two hand-built panels
here in `DevGallery.tsx`. That mimic has already lied once — it mounted
`BotsScreen` without `onOpenSection`, so it drew a sidebar with no tab strip and
the missing strip was reported as a portrait bug in the real shell, which has one
at every height — and it can only ever be photographed in the states somebody
remembered to build into it. A collapsed sidebar was not one of them.

`--hermieOpen gallery:shell` now mounts `Shell` itself over a seeded fixture
roster, with no gateway, no keychain and no sign-in. `gallery:list` does the same
for the chat list alone. The mimic stays where it is; framing one component in the
shell's proportions is a different job from being the shell.

**What that still cannot show, and it matters for screenshots.** Presence is
computed from `status === 'ready'` (`presenceOf`, via `BotsScreen`), and the
gallery has no gateway, so every row reads `Offline` and the connection line says
`Reconnecting…` or `Disconnected` however the roster is seeded. The arrangement —
dividers, accents, unread marks — is real; the beads are not. A screenshot meant to
show a working app needs a configured connection, and configuring one means
completing the wizard by hand, because `GatewayProvider` requires
`loaded.hasCredentials` before it leaves the onboarding phase.

### 834pt starts collapsed, and that is the lever the portrait pass asked for

The earlier portrait pass ended with "335pt is about 38 characters, still short of
a comfortable measure — a collapsible sidebar is the remaining lever". It is built.
`SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH` is 900: under it the wide layout starts with the
list hidden, at or above it with the list showing, and an explicit Hide or Show
wins at either width. Measured on the running app:

| At 834pt portrait | Sidebar | Chat column |
| ----------------- | ------- | ----------- |
| List showing      | 300     | 492         |
| List hidden       | 56      | 736         |

The rail keeps the way back and the three tab-strip destinations, so what the
reader gives up by hiding the list is the list.

### Three things the running app said that the tests could not

- **The gear read as a SUN.** The first draw was eight thin strokes from r5.1 to
  r8.1 around a circle, which is a sun whatever it was meant to be. Teeth are short
  and thick and start at the ring they belong to now, with a bore in the middle,
  and it reads as a gear at 19pt in both themes. No unit test could have said this;
  it is the kind of thing only a screenshot knows.
- **Two sidebar controls, 90pt apart, doing the same thing.** With a button in the
  chat header AND one on the rail, a collapsed window drew two identical icons side
  by side. The header's control now exists only while the list is showing and the
  rail's only while it is hidden, which also settles the wording — one always hides,
  one always shows, neither describes a state the other is in.
- **The overlay arrived under the clock.** Yoga positions an absolutely placed child
  against its parent's PADDING edge, not its content edge, so inside the shell's
  padded row `top: 0` is the top of the window rather than the top of the column the
  overlay stands in for. It carries the window inset itself now. Worth knowing before
  positioning anything else absolutely inside `shell-window`.

### A simulator can serve a stale bundle and say nothing

The 13" iPad answered a `gallery:shell` launch with the PREVIOUS round's bundle —
old glyph tab icons, the old wide-chat mimic — and looked like a perfectly healthy
app. A second launch with a longer wait picked up the current one. So the first
screenshot off a simulator that has been idle is not evidence until something in it
is new; check for a change you made before reading anything else into it.

### What this pass did NOT verify

- **A Mac window**, at any width. The collapse's 700–900pt band is exactly what a
  Mac window dragged narrow lands in, and no window was dragged.
- **Anything with a live gateway.** Every screenshot here is the gallery's
  gateway-free path, so presence, unread counts and the connection line are not
  under test — see the note above.
- **Reduce Motion and Reduce Transparency**, unchanged from previous passes. The
  overlay's 200ms slide collapses to zero under Reduce Motion by construction; that
  is asserted in code, not watched.
- **Android**, unchanged.
- **The status-mark alphabets.** `toolGlyph` (seven tool families), `NoticePill`'s
  five notice kinds and `SubagentGroupCard`'s five statuses are still characters.
  They are marks inside cards rather than controls, and each needs its own designed
  shape, so they were left rather than half-converted.

## A real tailnet name, and the advice that broke it (2026-09-20, later)

The ATS section above closed with a list of what it had NOT verified, and the first item on that list
was "a real tailnet. No Tailscale or Headscale node was involved." This closes it, against the
owner's own gateway, and the answer is not the one the report predicted.

**The report.** The gateway moved to a Headscale tailnet, reachable only as `hermes.fss.internal`
(100.64.0.11). Typing that into the wizard's address step produced the red line **"Could not reach
hermes.fss.internal. Check the address, and that the gateway is running and reachable from this
device."** From the Mac's shell the same name resolved, `https://` failed on a self-signed
certificate, and `http://` answered HTTP 200 — and `resolveGatewayAddress` run under Node returned
`{ baseUrl: 'http://hermes.fss.internal', foundOverHttp: true }` in 251 ms. So the suspicion was that
something in the app differed: DNS inside a sandbox, ATS, or an https attempt hanging long enough to
lose a race.

None of those. **The app works.** Release build, iPhone 18 Pro on iOS 27.0, driven by hand, against
the real gateway over the real tailnet. Typing `hermes.fss.internal` finds it:

> Hermes 0.21.3 · sign-in required via Self-Hosted OIDC · Found over http://

### The measured NSURLError sequence, from the simulator's own log

`xcrun simctl spawn <udid> log stream --predicate 'process == "Hermie" OR subsystem ==
"com.apple.network"'`, while the probe ran:

Offsets are from the first task resuming, and each row gives the moment the request started and the
moment it was answered.

| Task | Request                                         | Outcome                        | Started | Answered |
| ---- | ----------------------------------------------- | ------------------------------ | ------- | -------- |
| 3    | `https://hermes.fss.internal/api/status`        | **-1202**, certificate invalid | +0 ms   | +39 ms   |
| 4    | `http://hermes.fss.internal/api/status`         | **200**                        | +49 ms  | +147 ms  |
| 5    | `http://hermes.fss.internal/api/auth/providers` | **200**                        | +166 ms | +179 ms  |

The whole resolution takes about 180 ms. Two suspects die in that table:

- **DNS is fine inside the app.** `nw_resolver_host_resolve_callback [C3.1.1] … error=NoError(0)
hostname=hermes.fss.internal. addr=IPv4#…`, and the flow attached over **`interface: utun8`** — the
  tailnet's own interface. Tailscale's split DNS (`scutil --dns` shows a Supplemental and a Scoped
  resolver for `fss.internal.` on utun8, via MagicDNS at 100.100.100.100) reaches a sandboxed
  simulator app exactly as it reaches the shell. There is no `/etc/resolver` file involved and none is
  needed. Safari in the same simulator loads the status JSON too.
- **ATS is fine.** The cleartext request in row 4 was not refused; there is no `-1022` anywhere in the
  log. The built Release `Info.plist` carries `NSAllowsArbitraryLoads` and nothing else, which is the
  single-key rule from the section above still holding.

And one suspect is confirmed but harmless: the https attempt **fails fast** (39 ms), so the sequence
guard and the 500 ms debounce never get a chance to drop the http result.

### What actually produced the owner's red line

The wizard's own advice did. `classifyHost` read `hermes.fss.internal` as a **public** address —
`.internal` is not `.ts.net`, and it has dots in it, so it fell through to the last branch — and the
address step therefore printed, under a perfectly good result:

> Plain http:// to a public address. Anyone on the path can read your messages and your sign-in. Use
> https://, or reach the gateway over a private network such as Tailscale.
>
> **Use https instead**

Tapping that rewrites the field to `https://hermes.fss.internal`. An explicit scheme is never
downgraded (ADR-0014, deliberately), so the resolver now tries https and only https, gets **-1202**
from the self-signed certificate, and — because React Native's `fetch` throws the `NSError` away —
classifies it as a flat `network` failure. Which prints:

> Could not reach hermes.fss.internal. Check the address, and that the gateway is running and
> reachable from this device.

Reproduced on the simulator, screenshot for screenshot. So the app told a user on a WireGuard tunnel
that his private gateway was public, offered him the one action that breaks it, and then blamed the
gateway for being unreachable while it was answering.

Three things were wrong and all three are now fixed:

- **`.internal` is a private name.** ICANN reserved it for private use and it will never be delegated
  in the public root, so a name under it is exactly as unresolvable from outside as a `.local` one.
  `classifyHost` returns `local_name` for it, the warning and the `Use https instead` action are gone
  for this host, and the line reads "Plain http://, to an address on a local network." A Headscale
  operator who picks `.internal` for their base domain now gets the calm sentence; one who picks a
  name under a public suffix still gets the warning, because that name really is one the public DNS
  can answer for.
- **A pinned `https://` that fails flat no longer names the wrong cause.** The app cannot tell a
  rejected certificate from a dead host — see below — so it names both, and the way out:
  `strings.errors.networkOverHttps`. "Check that the gateway is running" was actively false here.
- **The claim that Node sees a real error message was wrong**, and the comment saying so in
  `fetch-json.ts` is corrected. See the next heading.

### Node's `fetch` flattens the reason too, which nothing had checked

`looksLikeTlsFailure` carried a comment saying it "earns its place in Node, where a real message
arrives". It does not. Node 22's global `fetch` is undici, and against this gateway it rejects with:

```
TypeError: fetch failed
  cause: Error: self-signed certificate   (code: DEPTH_ZERO_SELF_SIGNED_CERT)
```

`requestText` reads `error.message` and never `error.cause`, so `'fetch failed'` matches neither
predicate — exactly as `'Network request failed'` does not on a device. Both strings are now pinned in
`fetch-json.test.ts` so the claim cannot come back.

The consequence is that **neither predicate fires for any real `fetch`, on any runtime.** They are
exercised by the tests, which throw descriptive messages on purpose. Reading the cause chain would
make them fire in Node — and would then stop the scheme fallback for a self-signed https server, which
is precisely the gateway shape the fallback exists to reach. That is a trade, not an oversight, and it
is left alone here on purpose: today the owner's gateway is found over http on both runtimes, and
"fixing" the predicate would have made Node report a TLS error and stop.

### What the owner can change on his side, if he wants https

Nothing is required — the app reaches the gateway as it stands. If the self-signed certificate is
meant to be used rather than fallen past, one of these is the fix, and none of them is in Hermie:

- **Drop TLS.** On a tailnet it protects nothing WireGuard has not already protected (ADR-0014). Serve
  `hermes serve` in the clear, set `dashboard.public_url` to the `http://` address, and the wizard
  finds it with no warning now that `.internal` reads as private.
- **Use a certificate the device already trusts.** `tailscale serve` issues one for a `.ts.net` name;
  with Headscale, a reverse proxy with a certificate from a CA the device trusts does the same. A name
  under `.internal` cannot get a publicly-issued certificate, so this means a private CA installed and
  trusted on every device.
- **Install the self-signed certificate as a trusted root on the device.** iOS needs both steps:
  install the profile, then switch it on under Settings → General → About → Certificate Trust
  Settings.

### Pinning a self-signed certificate per gateway: what it would cost

Not built, and not small. Written down so it does not have to be re-derived.

The decision point is `URLSession`'s `urlSession(_:didReceive:completionHandler:)`, and React Native's
networking owns that delegate. So it needs native code on both platforms and it needs it in **three**
places, because they do not share a transport:

- **`fetch`** — `RCTHTTPRequestHandler` holds the `NSURLSession`; the challenge handler would have to
  be reached through a config plugin or a native module that swaps the handler in. On Android the same
  decision lives in OkHttp's `SSLSocketFactory` and `HostnameVerifier`.
- **The WebSocket.** `RCTSRWebSocket` builds its own stream with its own TLS settings, entirely
  separate from the `fetch` session. A pin that covers the probe and not the dial gets the user
  through setup and then fails on connect.
- **The `WKWebView`** that renders the sign-in page, which has its own
  `webView(_:didReceive:completionHandler:)` and honours nothing set on either of the above.

Beyond the wiring, the design questions are the real cost: the fingerprint has to be shown before it is
trusted and stored against that one gateway; it has to be re-shown and re-approved when it changes,
because a changed certificate is the one case this feature must not paper over; and the whole thing has
to be per-gateway rather than a global "accept anything", which is the version that would be easy and
would be worth nothing. Trusting the certificate at the OS level, as above, costs the user four taps
and costs this project nothing.

### What this pass did NOT verify

- **The Mac window.** The report came from the Mac app and every measurement here is from an iOS 27
  simulator. Same binary, same `Info.plist`, same JavaScript, and the cause found is in the JavaScript
  — so the fix applies — but nothing was run in a Mac window this round. If the Mac turns out to fail
  where the simulator does not, macOS 15+ **Local Network privacy** against a destination reached over
  `utun` is the first thing to measure, not DNS and not ATS.
- **The sign-in, and anything past the address step.** Only `/api/status` and `/api/auth/providers`
  were requested, unauthenticated, because it is the owner's real gateway. No credentials were sent,
  nothing was posted, and the WebSocket was never dialled against it.
- **A `.ts.net` name.** Still never typed into the app. `.internal` is a real tailnet name on a real
  Headscale network, which is closer than the previous round's `nip.io`, but the MagicDNS suffix itself
  remains untested.

## Reaching a connected app without typing (2026-09-20, later)

The README's screenshots had been stale for three design passes for one reason
recorded twice already: `chat:` and `overlay:` need a configured gateway, and
configuring one meant completing the five-step wizard on a simulator by hand.
`--hermieGateway <url>` with `--hermieToken <token>` now seeds the same two stores
the wizard's Done step writes — `saveGatewaySetup` with a config built by
`configFromDraft` — so the ordinary startup read finds a configured gateway and the
app lands on the connected shell. It is the only development argument that WRITES
anything; see `apps/hermie/src/dev/seed-gateway.ts`.

### The `__DEV__` gate, measured instead of asserted

`npx expo export:embed --platform ios --dev false --entry-file apps/hermie/index.js`
(run from `apps/hermie`; the entry path resolves from the monorepo ROOT, which is
why `--entry-file index.js` fails with "Unable to resolve module ./index.js"),
then read back:

| In the production bundle                          | Found                      |
| ------------------------------------------------- | -------------------------- |
| `devLaunchArguments` (the native property)        | **0 occurrences**          |
| `requireOptionalNativeModule` in that module      | **0 occurrences**          |
| `DEV_LAUNCH_INTENT`                               | `var v = null`, literally  |
| `seedDevGateway`                                  | `function*(){ return !1 }` |
| `parseDevLaunchArguments` and `'--hermiegateway'` | **present**                |

The last row is the one worth writing down, because the previous claim in both
`launch-intent.ts` and CONTRIBUTING was that Metro "folds the code out of a
production bundle", and that is not what it does: the parser is a module export
and Metro will not drop one, so its string literals — every flag name — survive.
Nothing calls it, since the intent it feeds is the folded `null`, and the seeder's
whole body including `saveGatewaySetup` really is gone. The honest claim is that
the argument is **inert** in Release, not that its parser is absent, and a
`strings` check that expects to find nothing will "fail" for a harmless reason.

### The installed-bundle landscape trick no longer produces a landscape scene

"The wide layout, on an iPad simulator" (earlier today) documents forcing a
landscape-PROPORTIONED window by rewriting `UISupportedInterfaceOrientations` in
the **installed** bundle's `Info.plist` with `plutil -replace`. That was tried
again here on the iPad Pro 13" (M5), iOS 26.5, with both
`UISupportedInterfaceOrientations` and `UISupportedInterfaceOrientations~ipad`
replaced by the two landscape values, verified still in the file after the launch.
The scene came back **portrait**, 2064 × 2752.

The difference from the earlier pass is scene adoption: the bundle now carries
`UIApplicationSceneManifest` with `HermieSceneDelegate` and `UIRequiresFullScreen`
is `false`, and a multitasking-capable iPad app does not get its scene sized from
that key — the system hands it a scene and the orientation list only says which
way the app may rotate. So there is currently **no way to produce a landscape iPad
window on this machine**: `simctl` still has no rotate verb (`simctl ui` offers
appearance, contrast and content size and nothing else), and the plist route is
now closed too.

What that costs: the 640pt bubble ceiling and the new 760pt wide one are still
unverified at a real 1366pt window. `docs/screenshots/wide.png` is the iPad Pro 13"
in **portrait** (1032pt), which does get the sidebar-plus-detail shell —
`REGULAR_LAYOUT_MIN_WIDTH` is 700 — so it shows the wide layout honestly, but its
content column is ~650pt and therefore below `BUBBLE_MAX.regular.wideColumnFrom`.

### Taps and typing, second confirmation

The dedicated simulator tool tapped the composer, typed three prompts and sent
them, and answered the approval sheet — so the approval screenshot is a real
server→client request raised by a prompt containing "approve", not a gallery
fixture. Two cautions from this run, both costing a retake: a tap lands on
whatever is under the coordinate at the moment it arrives, so a tap meant to
dismiss the keyboard opened a tool card instead; and the back chevron did not
respond while the keyboard was up. Relaunching with a different `--hermieOpen` is
cheaper than navigating, and that is what the final list shot was taken with.

## Two measurements from the WhatsApp comparison pass (2026-09-20, later)

### A hugging box cannot also wrap: Yoga sizes it from the first pass

The clock that sits on the end of a bubble's last line was built the obvious way
first — one `flexDirection: 'row'` with `flexWrap: 'wrap'`, the body and the
clock as its two children. It fits, the clock sits at the end of the line; it
does not, Yoga moves it to the next line. That is exactly the rule, and it is
wrong on a device.

Inside a box that HUGS its content — which a bubble does, by having a `maxWidth`
and no width — the wrapping container reported the height of ONE line while
laying two out. The clock was drawn below the bubble's bottom padding edge and
the bubble's own `overflow: 'hidden'` cut it in half. Photographed on an iPhone
18 Pro (iOS 27, RN 0.81) at a 402pt window: the bubble measured 48pt tall for a
25pt text line plus 20pt of padding, with the clock's glyphs straddling the
bottom edge.

Three variants of the same idea behaved identically, so it is the interaction
and not the details: `alignItems: 'flex-end'` replaced by the default stretch,
`alignContent: 'flex-start'` stated explicitly, and `flexGrow: 1` on the clock's
slot replaced by `marginLeft: 'auto'`. What works is not to wrap at all — measure
the body and the clock with `onLayout`, give the content column a `minWidth` of
`body + gap + clock` when the two fit, and lift the clock by its own height onto
the body's last line. The body's own measurement is taken on a view INSIDE the
column, so the number that decides is never changed by the decision and there is
nothing to oscillate at the boundary.

### What iOS adds at the top of a multiline field: 2pt

A multiline `TextInput` is a `UITextView`, and it lays its text out from the top
of its container rather than centring it — so a field with a `minHeight` larger
than its content puts all of the slack BELOW the first line, which is why the
composer's placeholder sat high in its pill.

Measured off a 3x screenshot of the composer on an iPhone 18 Pro rather than
assumed, by counting pixels between the pill's inner edges and the placeholder's
ink:

| measurement                | pixels | points |
| -------------------------- | ------ | ------ |
| pill inner height          | 120    | 40.00  |
| ink (cap top to descender) | 46     | 15.33  |
| gap above the ink          | 42     | 14.00  |
| gap below the ink          | 33     | 11.00  |

The ink is not symmetric in its own line box — `Message` has a descender and San
Francisco's ascent is far larger than its descent — so the 14-against-11 is the
FONT, not the layout. Reconstructing the 22pt line box from the metrics (cap top
sits 4.9pt into it) puts it at 9.1pt from the pill's top and 8.9pt from its
bottom: centred, to within a rounding error.

Those 9pt are `4` (the field's glass padding) + `3` (the style's `paddingTop`) +
`2` (the platform's own inset) above, against `4 + 5` below — which is what
`COMPOSER_IOS_TOP_INSET = 2` in `src/chat-ui/Composer.tsx` is, and the reason the
style's two paddings are deliberately NOT equal. The pill's 40pt is
`COMPOSER_LINE_HEIGHT + 2 × COMPOSER_FIELD_INSET` exactly, with no `minHeight`
involved anywhere.

## The Play screenshots, and what Android had to grow to take them (2026-09-20, later)

`design/store/screenshots/` is the listing's images, made on emulators against
`npm run fake-gateway -- --auth token --token demo`. `design/store/README.md` is
the recipe; what belongs here is the four things the round had to find out first.

### Android had no way to open one screen, and now it has one

`--hermieOpen` and the rest read `ProcessInfo.processInfo.arguments` through
`hermie-mac`, which is Apple-only, so on Android `nativeArguments()` answered an
empty array and every screenshot began with the five-step wizard and a run of
coordinate arithmetic. `adb` cannot set a process argument vector at all, so the
question was which channel to grow.

**Intent extras, not a URL scheme.** `expo-linking` with `hermie://` was the
smaller diff and the wrong one: `scheme: 'hermie'` is already in `app.config.ts`
for the dev client, so a deep link that seeds a gateway would be registered with
the system in a **release** build too, and the whole point of the three gates is
that this channel is not one flag away from a shipped app. Extras reach an
activity that any app can already start, but nothing has to be registered for
them, and what reads them can be switched off.

`apps/hermie/modules/hermie-dev-launch` is the result: one Kotlin file, an
`expo-module.config.json` and a `build.gradle`. It flattens `--es hermieGateway
<url>` into `['--hermieGateway', '<url>']`, which is the shape
`parseDevLaunchArguments` already takes, so the grammar and its tests did not
move. `launch-intent.ts` now asks `HermieMac` then `HermieDevLaunch`; exactly one
exists in any binary, so there is no `Platform.OS` branch.

Two things bite, and both cost a screenshot before they were understood:

- **`MainActivity` is `launchMode="singleTask"`.** A second `am start` against a
  live process lands in `onNewIntent` while `getIntent()` still answers the intent
  the activity was **created** with, so relaunching with different arguments
  silently repeats the previous screen. `am force-stop` first, every time.
- **A Debug build stops on `expo-dev-client`'s launcher.** `-d
'exp+hermie://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081'` on the
  same intent goes straight to Metro's bundle, and the extras ride along with it.

### The Release gate is a runtime check here, and that was measured

iOS deletes the constant with `#if DEBUG`. A library's `BuildConfig.DEBUG` is not
a trustworthy stand-in, so the module reads the application's own
`FLAG_DEBUGGABLE` instead — which means the code IS in a release APK and simply
never sees an extra. That is a weaker claim than the iOS one and it was checked
rather than asserted: `./gradlew assembleRelease`, installed over the debug build,
launched with `--es hermieGateway … --es hermieTheme dark --es hermieWallpaper
warm --es hermieOpen chat:researcher`, and the app came up on **Welcome to
Hermie** in the light theme on the Blue wallpaper. Every argument ignored.
(That run predates this round's rename of `--hermieWallpaper` to `--hermiePreset`;
the command is left as it was actually typed, because the record is of a run.)

The third iOS gate does not hold at all on Android and the docs now say so:
`MainActivity` is `exported`, because a launcher activity has to be.

### Two tablet AVDs, written by hand because `avdmanager` could not see the image

Only `system-images;android-37.1;google_apis_playstore_ps16k;arm64-v8a` is
installed, and `avdmanager` answered `Error: Package path is not valid. Valid
system image paths are: null` for it under every combination of `ANDROID_HOME`,
`ANDROID_SDK_ROOT` and `--sdk_root`. Writing the two files by hand — a
`~/.android/avd/<name>.ini` and a `config.ini` copied from `Medium_Phone`'s with
`hw.lcd.width/height/density` changed and `hw.device.name`/`hash2` dropped — works
and takes a minute. 2560×1600 at 276 dpi is 1484 dp wide; 1200×1920 at 320 dpi is
960 dp in landscape. Both clear `REGULAR_LAYOUT_MIN_WIDTH`, so the 7" tablet gets
the same two-panel shell the 10" one does.

### A fresh AVD always has something in its status bar, and demo mode will not hide it

`sysui_demo_allowed` plus the `com.android.systemui.demo` broadcasts pin the
clock, the battery and the radios, which is what everyone documents. What nobody
mentions is that `-e command notifications -e visible false` did **not** hide the
notification icon on this build: a shield sat next to the clock in every capture.
It is a Safety Center "set a screen lock" notification from `pkg=android`, and the
tablets had a Play Store one instead. `adb shell cmd notification list` names them
and `cmd notification snooze --for 86400000 '<key>'` removes them, which is the
only step that reliably produced a status bar worth publishing.

Setting a screen lock to satisfy Safety Center does not work quickly enough —
`locksettings set-pin` leaves the notification posted until the next rescan.

### A screenshot at 1080×2400 is rejected by Play, and nothing says so until you upload

Play's limit is an aspect ratio no wider than 2:1. `Medium_Phone` is 1080×2400,
which is 2.22:1. `adb shell wm size 1080x1920` with the density left at 420 gives
a real 9:16 display to lay out into rather than a crop, and `wm size reset` puts
the shared AVD back.

### Two states the app draws that a store listing should not show

Both were fixed in the **setup**, not in the image:

- The crons list drew `Weekly digest` in red with `Cron job 'Weekly digest' has no
model configured.` The fake gateway ships that job with `last_status: 'error'`
  on purpose. `PUT /api/cron/jobs/job-digest` with `{"updates":{"last_status":"ok",
"last_error":null,"model":"…"}}` is a fixture edit, not a retouch.
- Settings showed `Version: Unknown`, which is exactly what `seed-gateway.ts`
  documents: the seed does not probe, and `configFromDraft` only writes `version`
  when `draft.probe?.version` is truthy. Nothing repairs it afterwards — the row
  is a one-shot snapshot of onboarding's `/api/status` call, and the only writers
  of the stored config are `OnboardingNavigator.finish` and the seeder. So that
  one image needed the real wizard run by hand, and a relaunch **without**
  `--hermieGateway`, because the seed rewrites the config on every launch.

`adb shell input` drives all of this comfortably, which is the standing difference
from the simulators: the wizard was completed with taps and `input text` in about
a minute, and that is the thing iOS still cannot do.

## The transcript jump, recorded at last (2026-09-20, later)

Two rounds reasoned about this one from the React Native source and both fixed
something real without stopping it. What closed it was a recording:
`--hermieTraceScroll` (`src/dev/trace-scroll.ts`) logs every scroll event and
every row height that moved, and the fake gateway grew a reply long enough to
watch (`--stream-delay`, and a scenario matched on `long` that puts its tool call
mid-reply).

### `ListHeaderComponent` can never be the anchor, at any value of the prop

The previous round's one-point list header — the "single most load-bearing view in
this file" — was unreachable. `VirtualizedList` adds one to `minIndexForVisible`
whenever a header exists:

```js
// Adjust index to account for ListHeaderComponent.
minIndexForVisible: props.maintainVisibleContentPosition.minIndexForVisible + (props.ListHeaderComponent ? 1 : 0)
```

so `{ minIndexForVisible: 0 }` reaches native as `1`, and the loop that picks the
anchor starts at the first CELL. The header is skipped. There is no value that
reaches it either: the same number is fed to `_getItemKey(props, minIndexForVisible)`
in `getDerivedStateFromProps`, so `-1` calls the list's own `keyExtractor` with
`undefined`. The header is gone rather than tuned, and the section above it in
this file is wrong about what anchors the list.

### What the anchor actually does at the bottom of an inverted list

It anchors on a VIEW, and every new row is inserted _before_ that view in content
order — so the delta is the new row's own height, on every message sent, every
bubble of a reply, and every tool row. Measured on an iPhone 17 Pro (iOS 26.5),
one 70pt outgoing bubble:

```
[row]    +38626 user-o:7000 h=70.0 (new)
[scroll] +38626 offset=94.0 content=968.0 view=291.0   ← corrected by the row + its gap
[scroll] +38654 offset=90.3 content=951.0 view=291.0   ← autoscrollToTopThreshold, animating back
[scroll] +38921 offset=0.0  content=951.0 view=291.0   ← ~290ms later
```

Four of those per turn. That is the whole of "the chat jumps up and scrolls itself
back down", and it is what the prop is specified to do — the list is correcting
for a shift the reader never saw, because at the bottom of an inverted list the
shift IS the new message arriving.

So the prop is now held only while the reader is scrolled away from the bottom,
where it earns its keep (a message must not shove the paragraph someone is reading
up the screen) and where `autoscrollToTopThreshold` cannot fire anyway. At the
bottom the list is pinned by inversion alone. The same turn, recorded again after
the change, produced **no scroll events at all**.

### Two height changes the recording found and this pass did NOT fix

- **Every bubble is 17pt too tall for one frame when it mounts.** The inline-clock
  measurement in `Bubble.tsx` renders the clock on a line of its own until the
  body and the clock have been measured, then lifts it onto the last line:
  `[row] user-r:1 h=112.0 (+17.0)` followed by `h=95.0 (-17.0)` within 6ms, once
  per mount and therefore once per virtualisation round trip. It was adding its
  17pt to every jump above; on its own it is a one-frame flicker.
- **A bubble sealed mid-turn folds immediately**, which collapses it by 208pt
  under the reader: `[row] +40779 tool-t:… h=100.0 (new)` and, in the same frame,
  `[row] +40779 assistant-a:8000 h=336.0 (-208.0)`. `Fold` engages on
  `!item.streaming`, and an interim note stops streaming the moment the tool row
  seals it. The final bubble does the same at `message.complete` (-280pt). Both
  are §6.3 working as specified; whether a reply should fold while its own turn is
  still running is a design question, not a defect, and it is the obvious next one.
- **The ~60pt blank gap was not reproduced.** `traceBlankRow` watches for exactly
  it — a wrapper with height over contents with none — and logged nothing across
  two full turns and a 22-row history.

## Web (2026-09-20)

The browser build is the app exported with `expo export --platform web` and served by
`packages/hermie-web`, which also proxies the gateway onto the same origin
([ADR-0015](adr/0015-web-variant-on-its-own-port.md)). Everything below was measured against that
server in front of the fake gateway in cookie mode, in a real browser, on the date above — not
inferred from what the packages claim.

### Summary

| Question                                         | Answer                                         |
| ------------------------------------------------ | ---------------------------------------------- |
| Does `expo export --platform web` succeed?       | **Yes**, once the seams below exist            |
| Does the app render, connect and stream a reply? | **Yes** — wizard, chat list, transcript, send  |
| Is there a keychain?                             | **No.** IndexedDB, and the app says so         |
| Can a page put headers on a WebSocket upgrade?   | **No.** Never, in any browser                  |
| Does `expo-blur` work?                           | **Yes** — `backdrop-filter`, so glass is real  |
| Does `expo-glass-effect` work?                   | **No web build at all**; it cannot be imported |
| Does `react-native-webview` work?                | **No web implementation**                      |
| Does `Appearance.setColorScheme` exist?          | **No** — react-native-web has the getter only  |

### What had to become a platform seam

The rule is the one this file has had since the Mac work: a platform difference lives in a
`*.web.ts` sibling, never in a branch inside a shared file. New seams:

| Seam                                              | What the web answer is                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `platform/chat-cache.web.ts`                      | IndexedDB, behind the same `FallbackChatCache` that downgrades to memory |
| `platform/secret-store.web.ts`                    | IndexedDB, `localStorage`, then memory. **Not a keychain** — see below   |
| `platform/net-info.web.ts`                        | `navigator.onLine` plus the `online`/`offline` events                    |
| `platform/random.web.ts`                          | `crypto.getRandomValues`                                                 |
| `platform/haptics.web.ts`                         | Nothing happens                                                          |
| `platform/status-bar.web.tsx`                     | Renders nothing; a tab's chrome is the browser's                         |
| `platform/socket.web.ts`                          | The DOM `WebSocket`, with the headers argument accepted and discarded    |
| `platform/attachments-picker.web.ts`              | A hidden `<input type="file">`                                           |
| `ui/glass/native-effect.web.tsx`                  | Both Liquid Glass probes answer false                                    |
| `features/onboarding/NativeSignInWebView.web.tsx` | Renders nothing; the cookie flow replaces it                             |
| `features/onboarding/cookie-sign-in.web.ts`       | `/auth/login` as a navigation, `/auth/password-login` as a fetch         |
| `features/onboarding/steps/SignInStep.web.tsx`    | The cookie sign-in step                                                  |
| `features/settings/WebUpdateRow.web.tsx`          | The Hermie Web self-update row                                           |
| `gateway/web-config.web.ts`                       | `/hermie/config.json` and `window.location.origin`                       |

Two mechanical notes, both of which cost time the first time:

- **A `.web.ts` seam cannot import a value from the module it replaces.** `./secret-store` from
  inside `secret-store.web.ts` resolves to that file itself. Anything two seams share therefore
  lives in `platform/platform-contracts.ts`, which no platform owns. A type-only import would in
  fact survive (Babel erases it) — the shared file is the version that is also readable.
- **Two shared modules had to be SPLIT rather than seamed.** `chat-cache.ts` kept the SQLite half
  and moved the contract, the memory cache and the downgrade wrapper into `chat-cache-core.ts`,
  because the web store wants all three unchanged. The same shape would apply to any future seam
  with a real implementation on both sides.

### There is no keychain, and this is what that means

`expo-secure-store` has no web implementation, and no browser API is an equivalent: whatever the
page can write, the page can read. `secret-store.web.ts` is IndexedDB with a `localStorage` fallback
and an in-memory last resort, and it is documented in its own header as storage rather than as a
keychain. Concretely, against the phones:

- No hardware-backed key, no Secure Enclave, no biometric gate, no "after first unlock".
- Clearing site data signs the user out. No sync, no migration.
- In practice a Hermie Web install keeps **no bearer token at all**: the session is the gateway's
  `HttpOnly` cookie, which the page cannot read. What lands in this store is the non-secret
  bookkeeping the shared code routes through it.

### A page cannot set request headers on a WebSocket

`new WebSocket(url, protocols)` is the whole API — there is no third argument and no header
equivalent, in any browser. This is not a gap in the seam; it is the reason the gateway's ticket
subprotocol exists ([ADR-0005](adr/0005-ticket-per-websocket-dial.md)) and the reason the browser
build authenticates with cookies.

The consequence worth naming: the **extra headers** an operator can configure for a gateway behind
Cloudflare Access never reach the socket. `socket.web.ts` accepts `plan.headers` and drops it, so
the shared dial code keeps one shape. Hermie Web is meant to run inside that perimeter, with the
access proxy in front of **it** instead.

### `expo-glass-effect` has no web build; `expo-blur` does, and it is a real blur

`expo-blur`'s web implementation is `backdrop-filter: saturate(180%) blur(Npx)`, which genuinely
blurs what is behind the surface — so `GLASS_MATERIAL` is `blur` on the web, not `solid`. Android
stays `solid`. `expo-glass-effect` is Apple-only with nothing resolvable for the web, so the single
import of it moved behind `ui/glass/native-effect.tsx`; the probes there answer false on the web and
the two components fall back to a plain `View` rather than throwing, because a component that throws
is a blank page.

### `Appearance.setColorScheme` does not exist on react-native-web

The first thing that broke after the bundle built was a white screen and one console line:
`Appearance.default.setColorScheme is not a function`. react-native-web exposes the listener and the
getter and stops there, because a page cannot override the user agent's colour scheme for anything
but itself. The call is **guarded rather than seamed**: on the web every surface is drawn by our own
token set and the one native material that reads a trait collection does not exist, so there is
nothing a web implementation would do.

### The file picker's cancel is a heuristic

`expo-document-picker` has a web implementation and it is deliberately not used: it returns a
`data:` URI, which base64s the whole file into a JavaScript string before anything has decided to
upload it — exactly what the streaming upload exists to avoid. The seam creates an
`<input type="file">` instead and hands back the `File`, which a browser's `FormData` streams.

What is genuinely worse than on a phone: **there is no reliable cancel event.** The seam resolves on
`change`, and calls it a cancel when the window regains focus without one. A user who takes longer
than that to pick gets a cancel they did not ask for. `UploadableFile` grew an optional `body` so
the upload appends whichever part the platform produced — a `File` here, React Native's
`{uri, name, type}` blob everywhere else.

### What is NOT verified

- **A real `hermes serve` in cookie mode.** Everything here ran against
  `packages/fake-gateway --auth cookie --public-host …`, which implements the routes and the
  Host/Origin guard as upstream's sources describe them. The OAuth half of the cookie flow — a real
  identity provider, a real `/auth/callback`, the `SameSite=None; Secure` PKCE cookie surviving the
  cross-site redirect chain — has never been run.
- **Safari and Firefox.** Only one Chromium browser was driven.
- **A phone-sized browser window.** The layout was seen at 1024×768 and at the wizard's own width.
- **TLS in front.** Every configuration in `deploy/web/README.md` is written from the gateway's
  forwarded-header handling, not measured.

## Selecting text, dropping files, and four things a Mac window reported (2026-09-21)

Six items in one round, five of them from the owner running the Mac build. What
they have in common is that almost every one is a UIKit behaviour reached through
a view React Native does not expose — so most of what follows is reasoned from
Apple's own APIs and from React Native's source, and the manual test at the end is
the part that settles it.

### `Text selectable` still does not select — and this time that was measured

The brief for this round said that on the new architecture `Text selectable` is
backed by a `UITextView` called `RCTParagraphTextView` and supports real range
selection. **It does not**, in the pinned React Native (0.81.5), and the file the
brief pointed at is the file that says so:

```
node_modules/react-native/React/Fabric/Mounting/ComponentViews/Text/RCTParagraphComponentView.mm
```

- `RCTParagraphTextView` is declared `@interface RCTParagraphTextView : UIView` —
  its own comment calls it "an auxiliary view we set as contentView so the drawing
  can happen on top of the layers manipulated by RCTViewComponentView". It draws
  an attributed string in `drawRect:`, and its `hitTest:` returns `nil`.
- `isSelectable` still installs a `UILongPressGestureRecognizer` plus a
  `UIEditMenuInteraction`, `canPerformAction:` answers yes to exactly one selector
  (`copy:`), and `copy:` copies
  `dataFromRange:NSMakeRange(0, attributedText.length)` — the whole paragraph.

So there is no selection range in the component on either renderer, nothing for a
mouse drag to move, and no combination of props that changes it. The earlier
finding (2026-09-20) stands, and parts (a), (b) and (c) of the brief rest on a
premise the source contradicts:

- **(a) is already true and buys nothing.** The markdown renderer threads
  `selectable` through its context. It defaults to OFF where the native context
  menu exists, and that is deliberate — with both, a secondary click on a bubble
  races two interactions for one gesture, which is the owner's earlier "it also
  starts selecting". Turning it back on for the Mac would reinstate that bug in
  exchange for a long press that copies the whole block, which the context menu
  already does better and with a choice of words or markdown.
- **(b) has nothing to reach.** `RCTParagraphTextView.hitTest:` returns `nil`, so
  loosening `canCancelContentTouches` / `delaysContentTouches` on the transcript
  hands the drag to a view that refuses it. The `allowedTouchTypes` change from
  the previous round is kept exactly as it was.
- **(c) is unchanged.** `UIContextMenuInteraction` already opens on a secondary
  click and on a long press; there is no `Pressable` around a bubble swallowing
  anything.

### So the selection is a second presentation, and it is real

`UITextView` over an `NSAttributedString` is the only thing in UIKit that
drag-selects rich text, and our renderer emits views a text view cannot hold — a
horizontally scrolling code block, a table built out of boxes. So the bubble keeps
its renderer and the message gets a second, flat presentation:

- `src/markdown/attributed.ts` flattens the same lexer output to styled RUNS: one
  block role (body, heading 1–3, code, quote) plus bold / italic / strike / mono /
  href. Pure, and the mapping is `__tests__/markdown-attributed.test.ts`.
- `HermieSelectableTextView` (in `modules/hermie-mac`) builds the attributed string
  and puts it in a non-editable, selectable `UITextView` that takes first
  responder on `didMoveToWindow`. Drag, double and triple click, shift-click, ⌘A,
  ⌘C and the system edit menu are all UIKit's rather than ours.
- `Select text` in a message's context menu opens it, Mac only. `Copy as Markdown`
  was already there — it has shipped since the menu did — and is left alone.
- Where there is no native view (an iPhone, Android, the test renderer) the same
  runs render as ONE nested `Text selectable` tree, so the menu entry never opens
  an empty panel.

Three deliberate losses in the flattening, each of which would otherwise need a
container: a table becomes tab-separated rows, a list writes its markers out as
characters, an image becomes its alt text.

### Dropping files on the chat

`modules/hermie-drop` is a new module and it is one view: a drop belongs to a
REGION — the conversation takes a file, the sidebar beside it does not — and a
module-level event could not tell them apart. `UIDropInteraction` accepts
`UTType.item` (the root of the type tree, so any file), `.image` and `.fileURL`,
always as `.copy`, and copies each item into `tmp/hermie-drop/<uuid>/<name>`
before JavaScript hears about it. That copy is load-bearing:
`loadFileRepresentation` deletes its URL when the completion handler returns, and
the upload starts several turns later.

`DropZone` wraps the whole conversation, shows a dimmed panel saying **Drop file
to attach** while a drag is over it, and feeds `stageFile` — the same function the
`+` menu's picker now calls, so a dropped file and a picked one travel one road.
It is inert wherever there is no native view, children rendered bare.

### The attachment is now IN the field, and survives a failed send

Two changes the owner asked for, both about the same thing being visible:

- the tray moved INSIDE the composer's pill, above the caret, instead of floating
  as a strip above the row. What is attached is attached to the message you are
  typing.
- attachments are cleared AFTER `chat.send` resolves, not before it. They used to
  go optimistically beside the draft, so a failed send put the words back and lost
  the file — the one thing the reader could not retype.

### The pointer highlight over the conversation

Reported: moving the mouse over the chat window draws a blur over it. That is
`UIContextMenuInteraction`'s own pointer effect, at the wrong size. The host view
was built for a list row, where a row-sized highlight is how the system says a row
is actionable; a transcript row is as wide as the window and as tall as a reply.

`ContextMenuHost` now takes `hoverEffect` (default true, false only from
`TranscriptList`) and `cornerRadius`. The native side answers both: an empty
`UIPointerStyle` where the effect is off — deliberately NOT `UIPointerStyle.hidden()`,
which hides the cursor — and a `UITargetedPreview` whose parameters clear the
background, or cut it to the row's own radius where the effect stays on. That
radius is also the answer to the chat row whose grey hover block had square
corners under a rounded row: `BotRow` hands over the same `radii.card` its selected
surface uses. Our own hover background was already rounded; the square one was the
system's, drawn over the top.

### A bottom sheet appeared instead of arriving

`useSheetPresence` started its progress value at `visible ? 1 : 0`. Every sheet in
this app is MOUNTED at the moment it becomes visible — `ChatSheetHost` renders one
only once there is one to show — so the first render already stood at 1 and the
opening animation ran from 1 to 1. Closing animated 1 → 0 and looked right, which
is why it survived a round. It now always starts at 0, and `reduceMotion`
collapses the duration rather than skipping the animation, so the completion
callback that unmounts a closed sheet still runs on the same path.

### Stuck Shift: the polled HID state, and what it cannot see

Reported: Return sometimes inserts a newline instead of sending, and pressing
Shift once fixes it. GameController delivers key changes to the app that is in
front, so a Shift held while the window loses focus has its key-UP delivered
somewhere else and `isPressed` stays true until the next Shift press corrects it.

`isShiftDown()` is now the AND of two sources that fail in different directions:
the polled state, which can stick ON, and a latch this process maintains from
`keyChangedHandler` (both directions) and clears on `UIScene.didActivateNotification`,
`UIApplication.didBecomeActiveNotification` and `GCKeyboardDidConnect`.

`UIKey.modifierFlags` in `pressesBegan` was considered and not used: the first
responder while typing is React Native's own `RCTUITextView`, so reading the flag
off the Return would mean subclassing or swizzling a renderer-owned class, and the
failure is the latch going stale rather than the poll being wrong in principle.

The JavaScript decision is now one table, `shouldSend(key, modifiers)`, shared by
`onKeyPress` and `onSubmitEditing`. One asymmetry is load-bearing and is commented
where it lives: reaching `onSubmitEditing` at all IS the platform having decided to
submit, so that site passes `hardwareKeyboard: true` and asks only about the
modifier. Passing the prop through instead turns a software keyboard's Return —
which has already inserted its newline — into a second one.

### `-allowProvisioningDeviceRegistration`

`npm run mac` now passes it beside `-allowProvisioningUpdates`.
`-allowProvisioningUpdates` renews profiles for devices the team already knows; for
a Mac that has never built this app, automatic signing fails with "doesn't include
the currently selected device". Noted in docs/release.md.

### An inline code chip broke where it had not asked to

Photographed on the iPad build: `sc-domain:hermie.dev` and
`WACHT OP VERIFICATIE` grew EMPTY to the end of the line and then continued, mid
span, on the next one — a grey tail with nothing in it.

Two things combined. UAX #14 offers a line-break opportunity after a colon and
after a dot, and inside a run of capitals with a space in it, so CoreText took
one; and React Native paints the background of every line fragment of a nested
`Text`'s range, so the fragment that ended at that opportunity was painted across
the rest of the line.

`src/markdown/Inline.tsx` now puts U+2060 WORD JOINER between every pair of
characters in a chip. Between EVERY pair rather than at a list of known
punctuation: the list would be a guess at one line-breaking implementation, and
the property wanted is simply "nowhere". That gives the owner's three rules in
order — a chip that fits on the next line goes there whole, a chip wider than the
line falls back to CoreText's character break, and every fragment that can exist
holds glyphs. The zero-width space that used to invite a break at the chip's own
word gaps is gone; that was the break he did not want.

The joiners are on the clipboard if a reader long-presses and copies a whole
paragraph on a phone. They are zero-width and invisible, and neither the context
menu's Copy nor the Mac's Select text panel sees them — both go through the
markdown source.

**`attributed.ts` is deliberately NOT given the same treatment.** The panel exists
to copy exact text, and ⌘C there copies the runs' characters. TextKit paints an
`NSBackgroundColorAttributeName` over the glyph range on each line fragment rather
than to the line's end, so the bug this fixes is React Native's rather than
CoreText's.

### Enter did not send on an iPad

The same build sent on a Mac. `hardwareKeyboard` defaulted to `RUNS_ON_MAC`, which
is a proxy for "is there a keyboard" and is false on exactly the device the owner
was holding. It is now `RUNS_ON_MAC || hasHardwareKeyboard()`, evaluated per
render, so a keyboard connected mid-session is picked up on the next one. A device
with nothing attached keeps a Return that breaks the line.

### A sheet's lower corners, and the strip of window under it

The square bottom was said by overriding four style keys on two of `GlassSurface`'s
three layers. The one it missed is the native material, which a parent's corner
mask does not clip the way it clips a plain layer. `GlassSurface` takes
`radiusBottom` now and spells all four corners out, so one number reaches every
layer. Whether the residual gap under the card was that material's rounded corner
or something else is NOT established from here — see the manual test.

### The filter chips are gone

All / Unread / Working / Needs input are removed from the chat list, with their
strings, their model (`ChatFilter`, `CHAT_FILTERS`, `matchesFilter`) and their
tests. `presenceOf` stays — the bead and the header still read it.

### What is verified, and what is only reasoned

**Verified on this machine:**

- `npm run typecheck`, `npx eslint .`, `npm run format`, `npm test`,
  `npm run test:app` and `npm run contrast:check` all green.
- The Markdown → runs mapping, the menu entries, the send-key table, the drop
  payload normalisation, the drop overlay's appear/disappear, the attachment
  showing inside the composer field and surviving a failed send, the sheet's
  opening animation starting off-screen, and the transcript asking for no hover
  effect — all by unit test.
- That `Text selectable` cannot drag-select, by reading
  `RCTParagraphComponentView.mm` in the pinned React Native. Evidence about the
  renderer, not about a Mac.

**Reasoned, not watched — every native line in this round:**

- That a `UITextView` in the overlay drag-selects, and that ⌘A and ⌘C reach it
  because it takes first responder on `didMoveToWindow`.
- That `UIDropInteraction` accepts a Finder drag at all, that `suggestedName` is
  the name the reader sees, and that the copy into tmp outlives the gesture.
- That an empty `UIPointerStyle` and a cleared `UITargetedPreview` stop UIKit
  drawing the platter, and that a rounded `visiblePath` rounds it on a chat row.
- That the Shift latch closes the real gap. The stale case cannot be produced
  without two windows and a keyboard.

**None of the native code in this round has been compiled into a Mac build here.**
`modules/hermie-drop` is new, so it needs a `pod install` — `npm run mac` does one
when the lockfile is stale, and this round did not run it.

### The manual test, for a Mac window

1. **Select text.** Right-click a reply → `Select text`. Drag across the panel:
   the selection must follow the mouse. ⌘A selects everything, ⌘C copies it with
   its formatting, Esc closes the panel. Headings, code, lists and links must
   look like the message they came from.
2. **Copy as Markdown** on the same menu still copies the raw source, and
   `Copy text` the stripped words.
3. **Drag a file** out of the Finder onto the conversation: a dimmed panel saying
   "Drop file to attach" appears while it is over the window, and goes when the
   drag leaves. Let go: the file appears as a chip INSIDE the composer's field,
   with the caret under it and an × to take it off. Type something and send:
   both go, and the chip disappears only once the send lands. Drag two files at
   once — two chips, in the order dragged.
4. **Move the mouse across the transcript.** Nothing should light up, blur or
   lift. A secondary click must still open the message menu.
5. **Move the mouse down the chat list.** The grey hover background must have the
   same rounded corners as the selected row.
6. **Open Chat options.** The sheet must slide up from the bottom with the
   backdrop fading in, not appear.
7. **Stuck Shift.** Hold Shift, click into another app, release Shift there, click
   back into Hermie, type and press Return: it must SEND. Then Shift+Return must
   still put in a newline.
8. **The filter chips** are gone from above the chat list.
9. **A long inline code span** — a message containing `sc-domain:hermie.dev` and
   one containing `WACHT OP VERIFICATIE` — must move to the next line WHOLE rather
   than breaking, and its grey background must hug the text with no empty tail. A
   span wider than the whole line is the one case that may break, and then per
   character.
10. **On an iPad with a keyboard case**: Enter sends, Shift+Enter breaks the line.
    With the keyboard detached, the on-screen Return breaks the line as before.
11. **A sheet's lower edge** sits on the window's bottom with square corners and
    no strip of window beneath it, on all three.

### Still open after this round

Reported while the round was running and NOT started, with what is already known:

- **Every thought appears twice with Show thinking on.** One item per thought is
  wanted, the interim replaced rather than appended, and a thought drawn as
  secondary text rather than as a bubble. Wants a reducer test over
  reasoning → interim → interim → complete.
- **The bubble tails.** The owner wants the iMessage droplet: the outer bottom
  corner running out into a short curve that ends in a point. The STRUCTURE is
  already what he describes — `Bubble.tsx` draws one SVG path behind the bubble,
  at a fixed 10×10, only on the last message of a run, and `bubbleCorners` already
  tucks the tail-side corners of a grouped bubble. What is wrong is the SHAPE, so
  the change is `TAIL.path` and `TAIL` in `src/ui/tokens.ts`, plus `radii.bubble`
  if 16 should become 18. Drawing that blind is how a round gets spent; it wants
  somebody looking at it.
- **The typing indicator should be the last row of the transcript.** Note that it
  is pinned outside the list ON PURPOSE, and the reason is written where it lives:
  anything whose height comes and goes at the bottom of an inverted list moves the
  first cell's origin, which is the view `maintainVisibleContentPosition` anchors
  on while the reader is scrolled away. Moving it in means making the anchor logic
  count it as a row, which is the actual work.
- **The header status should say what the bot is doing** — Thinking, Typing,
  Running <tool>, Waiting for you, Delegating — from the event stream, as a
  `turnActivity(chat)` selector in `@hermie/transcript`.

## The dots, the queue, and three numbers that were measured (2026-09-21, later)

Eight items in one round. The three that had been reasoned about before are the
three the scroll trace settled, and one of them was still wrong when this round
started fixing it.

### `Show more` was still 212pt out, and the recording says why

`Fold` predicts how much taller its own body is about to be, and the list held
the reader to that prediction. Opening the long report the fake gateway streams,
on an iPhone 17 Pro:

```
[scroll] +101310 offset=859.0   content=2103.0   ← the tap
[row]    +108923 assistant-r:6 h=1676.7 (+1377.7)
[scroll] +108926 offset=2024.3  content=3480.7
```

859 + 1377.7 is 2236.7 and the list went to 2024.3. The prediction was 1165.3;
the row grew by 1377.7. **The 212.4pt between them is the table**, measuring its
columns a layout pass after the text, and it is the number the owner reported
the text moving by.

A row's own frame cannot answer it either, and that was this round's first
attempt: by the time a row can report anything it has already grown, so the
first height it sends is the final one and there is no baseline to subtract. The
CONTENT's height can — whatever the row does, in however many passes, it is in
there. `holdTarget(from, content)` is the offset at the tap plus
`content - contentAtTap`, replacing the prediction on every
`onContentSizeChange`. Recorded again after the change: predicted 1865.4, landed
1865.3.

### The typing bubble is a row now, and the anchor never noticed

It was pinned below the scroll view because a height that comes and goes at the
bottom of an inverted list moves the view `maintainVisibleContentPosition`
anchors on. That reason expired when the anchor was put behind `away`: at the
bottom there is no anchor to move, and away from it correcting for an inserted
row is what the reader wants. Recorded, sending with the dots on:

```
[row]    +330421 user-o:11000 h=70.0 (new)
[scroll] +330421 offset=39.7  content=1610.0
[scroll] +330435 offset=38.7  content=1593.0
… 14 events, monotonically down …
[scroll] +330702 offset=0.0   content=1765.0
```

One animated run to the end, no correction, no spike. The content grew by the
user row AND the typing row together and nothing jumped.

### Sending goes to the end, from wherever the reader was

Same recording, and the case the owner reported the jump from — scrolled up in
the history with the pill showing. `scrollToLatest` is one
`scrollToOffset({ animated: true, offset: 0 })`, and offset 0 on an inverted
list is the newest message. Nothing in the run above ever asks for a larger
offset, which is the whole of "never to the top": a `scrollToIndex` can land
anywhere through its own recovery path, and this never asks for one.

### A message sent while the bot is working is ours to hold

`prompt.submit` will park a prompt — it answers `queued` — and that queue is the
one thing the client cannot use: one opaque prompt, no method to read it back,
edit it or take it out. Steer, Edit and Delete are exactly those three. So the
queue is client-side in `chat-controller` until `message.complete`, and only
Steer goes to the gateway (`session.steer`); a `rejected` steer comes back into
the queue rather than disappearing into a turn that never heard it.

A queued message with an attachment offers Steer and Delete and no Edit. The
composer cannot be handed bytes back, and dropping a file silently is the bug
the previous round removed from the failed-send path.

### Every sheet can be dismissed, and ADR-0010 is intact

The `blocking` flag is gone. It read ADR-0010 one word too wide: the ADR governs
the ANSWER — an explicit tap on a named choice — and no backdrop tap, Escape or
drag produces one. A question put aside stays open on the gateway and stays in
the transcript behind its own `Answer` button.

The drag writes to the same `Animated` value the slide-in uses, so the finger
and the animation are one motion. Past a third of the height or faster than
500 pt/s it closes; otherwise it springs back. Upward is CLAMPED rather than
rubber-banded, which is a deliberate departure: the card is square against the
window's bottom edge, so lifting it by any amount re-opens the strip of window
the previous round closed.

### Three keys that insert nothing

The composer's slash list is navigable now, and ↑, ↓ and Tab are the first
unmodified keys on the native allow-list in `HermieMacModule.swift`. They belong
there: the table exists so that nothing typed into a field reaches JavaScript,
and none of those three inserts a character. **Not verified on a device** — the
Swift side was not compiled this round; the JavaScript half is tested against
the seam.

### The sidebar, and the half of the width fix that was missed

The previous round settled the width the collapse reads and the width the
sidebar is drawn at, and left `useLayoutMode` — the breakpoint that picks the
whole SHELL — on the live measurement. A transition reporting 690pt for a frame
therefore swapped the regular shell for the compact stack and back, and
everything that shell holds is state: the selection, the temporary list, the
open panel. That is not a sidebar closing; it is all of it going at once.

The settled width was also one `useState` per caller, each seeded at whatever
the window was when that component mounted, under a comment saying the questions
must be asked of one number. It is one module value with one timer now.
`--hermieTraceLayout` prints every width seen, every width settled, and every
change of the sidebar with its reason.

### The composer behind the keyboard

`KeyboardAvoidingView` computes `frame.y + frame.height - keyboardY`, where the
frame is its own `onLayout` — **parent-relative** — and `keyboardY` is the
keyboard's **window** coordinate. They agree only for a view at the top of the
window. `Screen` puts `insets.top` above the chat on a phone and the wide layout
puts a panel above it, so the room made was short by exactly that: 59pt on an
iPhone 17 Pro, which is the composer.

`KeyboardInset` measures its own top in the window and passes it as
`keyboardVerticalOffset`. Photographed with the keyboard up on an iPhone 17 Pro
and an iPad Pro 13" in the sidebar layout: the field sits on the keyboard.

### Found on the way, NOT fixed

- **Two children with the same key, after a gateway restart.** Restarting the
  fake gateway under a live app and sending twice produced
  `Encountered two children with the same key … .$o=29000` and the same user
  bubble twice. It is a transcript item id, not a row wrapper, so it is the
  reconciler pairing a rebuilt session's row twice — reachable only by pulling
  the gateway out from under a session, which is how it was found.

### What is verified, and what is only reasoned

**Recorded on an iPhone 17 Pro against the fake gateway** (`--hermieTraceScroll`,
`--stream-delay`): the two-stage growth and its correction, before and after;
the send-to-end run; the typing row arriving with no correction; the composer
sitting on the keyboard. **Photographed on an iPad Pro 13"**: the composer on
the keyboard in the sidebar layout.

**By unit test only:** the queue (controller and screen), every sheet
dismissal's arithmetic, the slash list's key navigation, the settled width's
flap cases.

**Reasoned, not watched:** the three new key codes in the Swift allow-list — no
native build was made this round, so the dev client on the simulator is the
previous binary with this round's JavaScript.

## The duplicated bubble, and where `ui_meta` turned out to be (2026-09-21, later still)

### An id is not unique, and `order` is a list

The `Encountered two children with the same key … .$o=29000` from the previous
round is `o:9000` once React's key escaping is undone — a transcript item id, and
specifically the optimistic bubble's. It was found by pulling the fake gateway
out from under a live session and sending twice, and it reproduces end to end:
`packages/gateway-client/src/bot-chat.test.ts` restarts the fake on the same port,
re-hydrates and sends, and before the fix the transcript comes back holding
`o:9000 o:9000` — and `r:4 r:4` beside it, which is the same fault by a second
route.

Three things were true at once:

- **`rebuild` read the id counter off the transcript's LENGTH.** A rebuilt
  session answers with FEWER rows than the client is holding, so
  `nextSeq = list.length * SEQ_STEP` walked backwards onto a seq already spent on
  an id still in the list. It is a high-water mark now; its only obligation is to
  sit above every seq in the list, which the larger of the two still does.
- **A persisted item's id is its gateway ROW NUMBER**, and a gateway that rebuilds
  a session numbers it from 1 again. A freshly projected `r:4` and a live `r:4`
  kept from the tail are two different rows wearing one id — nothing to do with
  the counter, and the reason the fix is not only the counter.
- **`addItem` and `rebuild` pushed straight into `order`.** `items` is a map, so
  the second write overwrote the first; `order` is a LIST, so it grew a second
  entry. One item, painted twice, the other gone. Both go through `freeItemId`
  now, and only the LATER of two claimants is renamed, so nothing on screen
  remounts.

Worth keeping in mind for anything that mints an id from a number the gateway
supplies: none of `tool_id`, `row_id` or a local counter is unique across a
session rebuild, and the only place that can know is the transcript being written
into.

### `ui_meta` is a per-key compare-and-swap, and it is not ours alone

ADR-0012 ended on "if the gateway ever grows a per-client metadata scope, this is
the one module to change". It has had one all along. `profiles.configure` takes
`ui_meta` with `ui_meta_expected_revisions` and answers with
`applied.ui_meta_revisions` and `applied.ui_meta_conflicts`, and upstream's
docstring — carried verbatim into the generated contract — says what that is:
sections are independent, and the expected revisions are a per-key
compare-and-swap.

So the unit is the TOP-LEVEL KEY, which is the difference between the scope being
usable and being a trap: `ui_meta: {"hermes-bots": {}}` is what makes a profile
show up as a bot at all and it belongs to another tool. A client that stored its
settings by replacing the bag would un-bot every profile it coloured.

The fake gateway had no `profiles.configure` at all, so none of this could be
tested. It has one now, for the `ui_meta` section only —
`packages/fake-gateway/src/ui-meta.test.ts` pins the round trip, the untouched
marker, the whole-key replace, the per-key revision counting from zero, the
refused stale write with `{ expected, actual }`, and a mixed request where one key
conflicts and the other still lands. ADR-0016 records the schema.

**None of it has met a running `hermes serve`.** The semantics are read off the
contract's shapes and upstream's docstring, which is evidence about the protocol
and not about a box. One probe settles it before anything writes for real: write
a single key to a profile that already carries `hermes-bots`, read `profiles.list`
back, and look for the marker.

### The theme does not follow the window's focus

Checked while scoping the theme work, because it is the kind of thing that is
easier to assert than to verify: nothing in the token set, the theme provider, the
glass surfaces or either shell reads window focus. Every `AppState` listener in the
app belongs to the connection (reconnect on foreground) or to the Mac keyboard
module's HID latch; `useColorScheme` follows the SYSTEM appearance, and
`Appearance.setColorScheme` pins the trait collection outright. There is no
AppKit-style inactive-window treatment to inherit, because the Mac build is the
iPad one.

## Themes, and `ui_meta` against a real gateway (2026-09-21, later again)

### A theme is three values, and the rest was always derivable

The token set had a per-scheme elevation ladder, a per-scheme glass table, a
per-scheme bubble table and a list of wallpapers, and each of those was a place a
new theme had to be added by hand. It is one table now: a preset, per scheme, is
a **background**, an **elevation ladder** and a **default accent**, and
`glassFor(scheme, ladder)` / `bubblesFor(scheme, ladder)` produce the rest.

That is not a tidy-up; the relations were already exact and nobody had noticed:

- every dark `nativeTint` was `withAlpha(solid, α)` of the rung it names, to the
  byte — `rgba(28,42,69,0.80)` against `e1 = #1C2A45`, and so on for all five;
- a bubble's `tail` has to be the bubble's own lower edge, and with the gradients
  removed a round ago a bubble is one flat wash over one opaque rung, so the tail
  is that composite exactly. The hand-tuned values were off by 2–4 per channel,
  which is the residue of the two-stop gradients they were sampled from.

`theme.wallpaper.fill` keeps its name. It is the floor, `Wallpaper` paints it,
every glass recipe composites against it and the contrast check measures against
it; renaming the one field all of them share would have been a diff across the
app to say the same thing.

### One ink set, three ladders, and the constraint that follows

`darkColors` is per scheme and stays that way — `onAccent` in particular is one
value, deliberately. So the Graphite and Lime dark ladders were not picked by
eye: each rung was computed from the Blue rung's relative luminance and given its
hue back, and `__tests__/themes.test.ts` fails if any of them drifts more than
3 %. Without that, a ladder nudged half a shade lighter would take every ratio in
`npm run contrast:check` with it and nobody would know which change did it.

`npm run contrast:check` iterates `THEME_PRESETS` now — 551 pairs across three
themes and two schemes — and the arithmetic moved into
`apps/hermie/src/ui/contrast.ts` so the theme editor's guard and the build's gate
are one rule. A colour the editor accepts is a colour the check accepts, by
construction rather than by discipline.

### The studio lime is a ring colour, and that has consequences

`#C7FF4A` carries white at about **1.3 : 1**. Two places in the app put white on
an accent's `fill` and both had to move:

- the composer's send button takes `accent().bubble` — the half of the swatch the
  check measures white against — rather than `fill`;
- a swatch's check mark picks whichever of black and white reads on the colour
  under it, which is one rule for all eleven swatches instead of a table.

`accent().fill` is therefore held to no contrast floor at all, and `contrast.ts`
says so out loud. An invented 3 : 1 there would refuse both the studio lime on a
white panel (1.14 : 1) and the Graphite accent on its own dark panel (1.55 : 1) —
the two accents the themes that need them are built around.

Warm and Slate are gone. Graphite absorbs what Slate was FOR — a matte floor at
about five times Blue's luminance, so panels sit a step above it rather than a
chasm above it — at a neutral grey. A stored `slate` reads back as Graphite and a
stored `warm` as Blue.

### `ui_meta`: the probe, and the one thing the fake had wrong

ADR-0016 ended on a condition: _"one probe settles it before anything writes for
real."_ Run on 2026-09-21 against `hermes serve` **0.21.3** (`upstream b25ce157`),
on a profile that already carried the `hermes-bots` marker:

```
before  ui_meta keys : ['hermes-bots']    revisions: {}
write   applied      : {"ui_meta":true,"ui_meta_revisions":{"hermie":1}}
after   ui_meta keys : ['hermes-bots','hermie']
stale   applied      : {"ui_meta":false,
                        "ui_meta_conflicts":{"hermie":{"expected":0,"actual":1}}}
cleanup applied      : {"ui_meta":true,"ui_meta_revisions":{"hermie":2}}
final   ui_meta      : {"hermes-bots":{}}
```

The marker survived, the revision moved by one, and a stale expected revision came
back refused with exactly the `{ expected, actual }` shape the fake reproduces.
The same probe on the default profile (`default`, `is_default: true` — it carries
no `hermes-bots` marker, because it is not a bot) wrote and removed `hermie-app`
and left the two bot profiles untouched. ADR-0016 is Accepted.

**A key written as `null` is REMOVED by the real gateway.** The fake stored the
null, which made the fake the more forgiving of the two — and this client drops a
section by writing null, so it would have left a dead key on a real profile with
every test green. That is the entire value of the probe, and it is the shape of
thing a probe is for: the fake reproduced the protocol correctly and was wrong
about the one case nothing in the contract mentions. The fake deletes now, and
`packages/fake-gateway/src/ui-meta.test.ts` pins it.

**Found on the way, not fixed, and not known to be a problem.** Upstream answers
the WebSocket upgrade WITHOUT echoing `Sec-WebSocket-Protocol` — at
`127.0.0.1:9121` as well as through the public proxy — while the fake gateway
echoes `hermes-gateway-v1`. RFC 6455 permits the omission and a browser accepts
it; Node's `ws` refuses a 101 with no subprotocol when it asked for one, which is
how this was noticed. The app's own dial has always worked against real gateways,
so nothing here is evidence of a bug. It is recorded because the asymmetry runs
the wrong way: the fake is stricter than the thing it stands in for, and that is
the direction that hides a client fault rather than a server one.

### The seeding rule, which is not in the ADR and should be

A section the gateway does NOT have is sent from this device on the first
reconcile. Without it a gateway only ever learns an arrangement from a device
that changes one AFTER connecting, so somebody who spent an afternoon ordering
their list and then signed in on a tablet would find the tablet empty and the
gateway empty, each politely waiting for the other to go first. An absent key is
not a decision anybody made; a present one is, and that asymmetry is the whole
justification. It is not symmetric: a section the gateway has and the device does
not is simply taken.

The mirror of that rule is the one that costs data if it is wrong, and it has its
own test: a reconcile does not overwrite a section this device changed while the
socket was down. That section is still dirty, so the remote copy is kept out of
it and the local value goes out behind it — otherwise a change made on a plane
would not merely fail to arrive, it would be erased on landing by the device that
made it.

### What is verified, and what is only reasoned

**Measured against a running gateway**: everything in the probe above, twice —
once on a bot profile and once on the default one.

**By unit test**: the preset model and its derivations (`themes.test.ts`), the
contrast guard and the themes store (`user-themes.test.ts`), the picker and the
editor (`settings-screen.test.tsx`), the `ui_meta` client over a real socket
against the fake (`packages/gateway-client/src/ui-meta.test.ts`), and the store
projection and its diff (`ui-meta-bridge.test.ts`).

**Audited rather than measured**: nothing styles by window focus, still. The
theme layer has no `AppState` listener at all — the only two in the app belong to
the connection and to the chat runtime's lifecycle — and the token set reaches
UIKit through `Appearance.setColorScheme`, which pins a trait collection rather
than reading one.

## Home-screen widgets, on three platforms (2026-09-21, later)

WidgetKit on iOS, iPadOS and the Mac; `AppWidgetProvider` on Android; one JSON
file behind all of it. `apps/hermie/modules/hermie-widgets/README.md` is the
shape of the thing. This is what was measured getting there, and what is not.

### A widget knows nothing, so the app writes everything down

A widget extension is a separate process with its own sandbox and a memory
budget strict enough that it is killed rather than paged. It has no gateway, no
socket, no keychain and no store. So the whole of what one can show is derived
**in the app** — by `src/features/widgets/snapshot.ts`, which is pure and is the
only tested thing on the path — and written as one versioned document into a
place the other process can read.

`presenceOf`, `unreadCountSince` and `formatPreview` are the same functions the
chat list calls. Not for tidiness: a widget that says Online over a row that says
Needs input is two bugs that look like one, and there is no component test on the
far side of a Swift and a Kotlin renderer to catch it.

The container differs and the difference is the whole of what iOS needs and
Android does not:

|         | snapshot                                            | avatars                           |
| ------- | --------------------------------------------------- | --------------------------------- |
| Apple   | `widget-snapshot.json` in the App Group container   | `avatars/<name>.png` beside it    |
| Android | one string in `SharedPreferences("hermie.widgets")` | `filesDir/hermie-widget-avatars/` |

An `AppWidgetProvider` is a `BroadcastReceiver` in the app's **own** process and
the launcher only ever holds the `RemoteViews` it was handed, so there is no
second sandbox and no App Group. On Apple there is, and `group.dev.hermie.app`
has to be on both signed binaries or they share nothing.

### The App Group is spelled four times and nothing checks three of them

`ios/HermieWidgetsModule.swift`, `widget/HermieWidgetSnapshot.swift`,
`widget/HermieWidgetsExtension.entitlements`, and the plugin. A mismatch does not
fail to build and does not fail to launch: the app writes into its own container,
the widget reads an empty one, and the widget is simply always blank — which
reads as "the snapshot is not being written" and sends you to the wrong half of
the system.

So the plugin throws at prebuild if the extension's entitlements name a different
group, and `__tests__/ios-widgets-plugin.test.ts` asserts the two Swift files
contain the same string. Neither is clever; both exist because the failure is
silent.

### Four Xcode traps, all of which were hit

The extension target is added by a config plugin in the module
(`plugin/with-hermie-widgets.js`) rather than by `@bacons/apple-targets`, which
was considered and declined: it depends on `@expo/prebuild-config` at a major
version above the one SDK 54 installs, which would put two copies of the prebuild
pipeline in the tree — the exact shape of the "plugin came from a different
@expo/config-plugins" failure, in the one step this repository cannot afford to
have fail quietly.

1. **A pod and a native target may not share a name.** The local module's pod is
   `HermieWidgets`; the first version of the extension target was too. Both write
   `<name>.swiftmodule` into the same products directory, the extension's is built
   for iOS 17 and the pod's for 15.1, and the app then fails to compile its own
   autolinking file: _"compiling for iOS 15.1, but module 'HermieWidgets' has a
   minimum deployment target of iOS 17.0"_, naming neither the target nor the
   plugin that created it. The target is `HermieWidgetsExtension` for that reason.

2. **`xcode`'s `addTargetDependency` does nothing when the sections are absent.**
   It ends in `if (proxySection && dependencySection)`, and a one-target project
   has neither a `PBXTargetDependency` nor a `PBXContainerItemProxy` section. So
   `addTarget` created the app's "Copy Files" phase for the `.appex`, returned
   something that looked like success, and left the app with no dependency on the
   extension — a race that copies whatever `.appex` is in the products directory,
   which on a clean tree is none. The plugin creates the two empty sections first
   and `assertEmbedded` fails the prebuild if the dependency did not land.

3. **`pod install` re-serialises the whole pbxproj with its own quoting.** The
   first version of the plugin found the extension's build configurations by
   matching `PRODUCT_NAME === '"HermieWidgetsExtension"'`. That worked on a
   project the plugin had just written and failed on the next `expo prebuild`
   without `--clean`, because CocoaPods' writer drops quotes around a value that
   does not need them. Configurations are addressed by uuid now; the assertion
   that no configuration was touched is what said so.

4. **The extension's `IPHONEOS_DEPLOYMENT_TARGET` is 17.0, the app's is 15.1.**
   `AppIntentConfiguration` and `containerBackground(for:)` both start there. An
   extension may declare a higher minimum than its app: an iOS 15 device installs
   the app and has no widgets to add, which is better than an app that will not
   install.

The `widget/` directory is outside `ios/` on purpose. The podspec's `source_files`
is `'*.{h,m,mm,swift}'` rather than `'**/*'` — the extension has a `@main` in it,
and a second entry point compiled into the app binary is a link error.

### Measured on the iPhone 17 Pro simulator (iOS 27.0)

Debug build, ad-hoc simulator signing (`Entitlements-Simulated.plist` in the
binary's `__entitlements` section — `codesign -d --entitlements` shows an empty
dict for a simulator build and that is not a missing entitlement), fake gateway
in session-token mode, dev launch arguments for the connection.

- **The App Group container exists and the app writes into it.**
  `…/data/Containers/Shared/AppGroup/<uuid>/widget-snapshot.json`, 516 bytes,
  two bots, plus `avatars/researcher.png`.
- **The widget gallery lists Hermie** and the small widget renders the snapshot:
  avatar, name, bead, three lines of the last message.
- **Adding it to the home screen works**, and the widget redraws from the file
  the app wrote.
- **`hermie://chat/researcher` from the widget opens that chat**, warm.

### The four grey beads, twice

The first widget on the home screen showed every bot **offline** within a second
of pressing the home button, with a snapshot stamped at that exact moment.

That was not a bug in presence. `attachLifecycle` tears the socket down when a
phone backgrounds the app, `presenceOf` correctly answers `offline` for every bot
when the gateway is not ready, and the background flush wrote that down and asked
WidgetKit to draw it. The home screen's last word on two live agents was two grey
beads, **caused by looking at the home screen**.

A widget cannot know what a bot is doing while the app is not running. What it
can honestly show is the last thing the app saw, with `generatedAt` in the file to
say when. So `WidgetSync.pause()` writes once, with the foreground's answer, and
then goes quiet until the app is back.

**The first version of `pause()` did not work, and the reason is worth keeping.**
Reading `gatewayReady` at the top of `pause()` is not enough: the write it starts
is serialised behind a promise and then awaits the avatar pass, so it reads the
flag several microtasks later — by which time React has re-rendered, the effect on
`status` has run, and the flag says what backgrounding did to the socket. Measured
again on the simulator: two grey beads, with the `pause()` already in place. The
flag is now frozen **synchronously** inside `pause()`, and
`__tests__/widget-sync.test.ts` drives the race directly by calling
`setGatewayReady(false)` between `pause()` and the await.

Re-measured after the fix: snapshot written at 03:57:28, home button pressed at
03:57:3x, both bots still `online` at 03:57:44, and the bead on the home screen is
green.

### The deep link, and the third source a cold start needs

`hermie://chat/<bot>` had no reader before this. The SCHEME was always registered
— Expo writes `CFBundleURLTypes` and the Android intent filter from `scheme` in
`app.config.ts` — so what was missing was `Linking`, not a registration. The 2026-09-20
note that "nothing is registered with the system" was about the development launch
arguments and is still true of those.

`src/platform/deep-link.ts` is the reader, and both shells use it: the compact
shell through the navigation container ref, the regular shell through the same
`openBot` a tap on a row lands on. Not React Navigation's `linking` config,
because `RegularShell` has no navigator at all — a link that only worked through
it would work on a phone and silently do nothing on an iPad or a Mac.

The grammar is one regular expression with a table of refusals, and the reason is
that a URL scheme is registered with the SYSTEM: any app on the device and any web
page the reader taps can send one. Opening a chat that already exists is the whole
of what a link may do — no gateway address, no token, no screen id.

**`Linking.getInitialURL()` cannot answer a cold start on iOS**, and that is what
`modules/hermie-scene` grew a JavaScript side for. React Native reads the URL out
of the app delegate's LAUNCH OPTIONS; under the scene life cycle a cold-start URL
is not in them, it is in the scene's connection options, which arrive after
`startReactNative` has already been handed the launch options. The forwarded URL
does reach `RCTLinkingManager`, which emits a `url` event — while the bridge is
still starting and nothing is listening.

So `HermieSceneDelegate` records the URL in `scene(_:willConnectTo:)`, before it
forwards it, and `HermieSceneModule.consumeLaunchURL()` hands it over exactly
once. Consuming rather than reading: a launch URL is true for the life of the
process, so a plain getter answers the same link to every caller forever, and a
remount — or a Fast Refresh — would reopen the launch chat.

That makes three sources for one question, and `useHermieLink` closes it on
whichever arrives first: the native record (synchronous, iOS, cold start only),
`getInitialURL()` (the one that works on Android), and the `url` event (which is
acted on every time, because tapping the same widget twice is two requests).

**A Debug build cannot be used to measure any of this.** A dev-client build that
is not running has no bundle loaded, so `xcrun simctl openurl` against one lands
on expo-dev-launcher's home screen and no JavaScript runs at all. The cold path
therefore needs a Release simulator build.

**And one false trail, recorded because it cost an hour.** The first Release
attempt also landed on the dev launcher, which read as expo-dev-launcher
intercepting deep links in Release — it does swallow an external link when the
app is not running (`EXDevLauncherController._handleExternalDeepLink` returns
`true` and navigates to the launcher). That was the wrong culprit. `EXDevLauncher`
is **not** linked into the Release binary at all: it is absent from
`Pods-Hermie.release.xcconfig`'s `OTHER_LDFLAGS` and `strings` finds zero
occurrences of it in the built Release app. What actually happened is that this
simulator has TWO apps claiming the `hermie` scheme — `dev.hermie.app` and
`nl.fullstackstudio.hermie`, the identifier this project used before commit
47c4718 — and `simctl openurl` routed to the older one, which is a dev-client
build. A widget tap does not have this ambiguity, because a widget's URL is
opened by its own containing app rather than by a scheme lookup.

### What is NOT verified

- **Android at runtime.** `./gradlew assembleDebug` succeeds with a JDK 17 from
  Homebrew (`/opt/homebrew/opt/openjdk@17` — the 2026-09-19 note that this machine
  has no JDK has lapsed), and both receivers are in the merged manifest. No
  emulator was started, so no Android widget has been drawn, no
  `AppWidgetManager` broadcast has been observed, and the Kotlin avatar
  compositing is reasoned from the API rather than looked at.
- **The Mac.** Where widgets appear in Notification Center rather than on a home
  screen. Not launched; the iOS slice is the same binary, so this is inference
  from ADR-0011 rather than an observation.
- **A real device, and therefore real signing.** Automatic signing is what creates
  the App Group on the team, and that has not been exercised — see the report
  for what Sebas has to check in the Developer portal.
- **`accessoryRectangular` and `accessoryCircular`** were built and are in the
  bundle, but no lock-screen widget was placed on the simulator.
- **The medium family** was built and is in the gallery; it was not placed either.
- **The widget budget.** `.never` plus app-driven reloads is the design; whether
  iOS throttles `reloadAllTimelines()` at the rate this app calls it (debounced to
  1.5s, and dropped entirely when the content would be identical) is not something
  a simulator can answer.

## The signed Android build, and putting it on real hardware (2026-09-21, last)

Everything Android in this file above was measured on an emulator. This section exists so the first
run on real hardware — a phone and a tablet, 2026-09-22 — produces findings rather than a shrug.

### What is being installed, and what signed it

`npm run android:release` on this machine, with JDK 17 and `ANDROID_HOME` both exported:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"     # Gradle fails at configure time without it
npm run android:release
```

**BUILD SUCCESSFUL in 1m 41s.** The one line that matters came out of the configure phase:

```
hermie: release builds are signed with the upload key in HERMIE_UPLOAD_STORE_FILE (alias hermie-upload)
```

So this is **not** the debug-signed fallback. Both artefacts landed:

| Artefact   | Path                                                                   | Size     |
| ---------- | ---------------------------------------------------------------------- | -------- |
| APK        | `apps/hermie/android/app/build/outputs/apk/release/app-release.apk`    | 105.0 MB |
| app bundle | `apps/hermie/android/app/build/outputs/bundle/release/app-release.aab` | 66.9 MB  |

`apksigner verify --print-certs` on the APK and `keytool -printcert -jarfile` on the bundle print the
same certificate and the same digest, which is the check `docs/release.md` asks for:

```
CN=Sebastiaan Eekhof, OU=Unknown, O=FullStack Studio, L=Den Haag, ST=Zuid-Holland, C=NL
SHA-256: e67957e2756807764d842cbd47b6b4daad9b410445839dceb857d19cb5809f0c
```

`CN=Android Debug` would have been the tell that the four `HERMIE_UPLOAD_*` properties had not
reached Gradle. It is not there, so the upload key signed both.

**The APK is the thing to install**; the `.aab` is for Play and a device cannot take it. It is 105 MB
because it carries all four ABIs, so the install itself takes a while over USB — that is not a hang.

One consequence of testing a **release** build: the `hermie-dev-launch` Intent channel is gated on
`FLAG_DEBUGGABLE` and is therefore inert here. Nothing can be pre-filled from the command line; the
gateway address and the sign-in have to be typed on the device, which is the point of this pass.

### Getting it onto one device when two are attached

With a phone and a tablet both plugged in, a bare `adb install` refuses rather than guessing. List
them first and address each one by serial:

```sh
adb devices -l
# List of devices attached
# 1A2B3C4D5E6F   device product:... model:Pixel_7   transport_id:1
# R9WT201XXXX    device product:... model:SM_X200   transport_id:2

APK=apps/hermie/android/app/build/outputs/apk/release/app-release.apk
adb -s 1A2B3C4D5E6F install -r "$APK"      # the phone
adb -s R9WT201XXXX install -r "$APK"       # the tablet
```

`-r` reinstalls over an existing copy and keeps its data. It only works when the **signature
matches**. Anything already on these devices was signed with the debug key, so the first install of
this build will fail with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Uninstall first:

```sh
adb -s <serial> uninstall dev.hermie.app
```

That wipes the app's data along with it — the keystore-backed credentials included — so onboarding
starts from nothing afterwards. For this pass that is what is wanted; it is worth knowing before
somebody does it by accident to a device that was mid-test.

### Reading the logs

The app's own output is drowned by the system log, so filter to the process:

```sh
adb -s <serial> logcat -c                                       # clear first, then reproduce
adb -s <serial> logcat --pid=$(adb -s <serial> shell pidof dev.hermie.app)
adb -s <serial> logcat -s ReactNativeJS:V                       # the JS console only
```

`pidof` returns nothing until the app is actually running, so launch it before that second command.
A crash takes the process with it, which takes the `--pid` filter with it — for that, read the crash
buffer instead, which survives:

```sh
adb -s <serial> logcat -b crash -d
```

### The checklist

Each line is something to look at and mark. "Pass" means the described thing was seen, not that
nothing obviously exploded. Run the whole list on **both** devices unless a line says otherwise —
the tablet is not a big phone, and the two-pane layout is the reason.

**Onboarding and sign-in**

1. The wizard accepts a scheme-less gateway address (`host:9119`) and the probe reports which scheme
   it landed on. Pass = the found-over line names `http://` or `https://` and matches reality.
2. The warning about a connection in the clear appears for a plain-`http` address that is **not** on
   a private network, and does not appear for one that is. This was measured on an emulator against
   a tailnet name; a real phone has a real DNS resolver and is the better test.
3. Sign-in completes and a cold restart comes straight back to the chats list, still signed in. Pass
   = no second sign-in. This is the Android keystore doing its job.
4. **`--auth native`, against a gateway configured for it.** The in-app WebView flow has never been
   run on Android — it is the largest untested branch on this platform. Also worth forcing the
   documented refusal: a gateway with extra headers configured should make
   `webViewMayCarryHeaders()` return false and the app should say so rather than fail silently.

**The conversation**

5. Send a message and watch a reply stream in. Pass = the bubble grows, and the transcript stays
   pinned to the newest line without being dragged there.
6. An approval arrives and both answers work. Pass = allow and deny each reach the bot and the
   request stops being pending.
7. Attach a file, and separately attach a **photo** from the picker. The photo path
   (`expo-image-picker` → `ImageManipulator` → `image.attach_bytes`) has never been carried through
   to a sent message on Android — the menu entry was opened once and nothing was picked.
8. Scroll back through a long transcript. Pass = it stays smooth. The wallpaper stacks a base
   gradient plus a per-corner bloom behind an inverted list and no frame timings have ever been
   taken on real silicon; if it stutters, say where and how far back.
9. The crons list loads and a cron delivery appears in the transcript where it belongs (ADR-0013).

**Layout and system behaviour**

10. **Rotate the tablet.** `REGULAR_LAYOUT_MIN_WIDTH` is 700, so landscape should give the
    sidebar-plus-detail shell and portrait may too, depending on the tablet's width in dp. Pass =
    the two panes appear at the right moment and the transition does not drop the open chat. A large
    phone in landscape can cross 700 dp as well (one emulator measured 914 dp), so check it there too.
11. Hide the sidebar and bring it back. Pass = the slim rail keeps the way back plus Activity, Crons
    and Settings, and nothing moves more than one tap away.
12. Dark and light, switched from the **system** setting while the app is open. Pass = the whole app
    follows, including the avatar tints, which `contrast:check` does not cover and which have to be
    looked at.
13. The hardware back button: closes an open panel, then a sheet, then leaves the app — in that
    order, and without the transcript jumping. There is one unreproduced sighting on record of
    dismissing the keyboard with back during a streaming turn leaving the transcript slightly above
    the bottom with the jump pill over the newest bubble. If it happens, note exactly what was on
    screen.
14. **Reduce Motion should be OFF** here. A stock AVD ships all three animation scales at zero and
    reports it as on, which made every emulator pass useless for this. Real hardware is the first
    honest reading: pass = animations actually animate.
15. **Home-screen widgets.** No Android widget has ever been drawn — no emulator was started for the
    2026-09-21 widget pass. Place one from the launcher's widget picker. Pass = it renders with the
    right avatars and a tap opens the app at the right place.
16. **Nothing vibrates, and that is expected.** `VIBRATE` is in `blockedPermissions`, so `haptic()`
    reaches a native module that cannot fire. Confirm it does not crash anything; a buzz would be
    the surprise.

### When something fails

Capture enough that it does not have to be reproduced to be understood:

- The filtered `logcat` from `adb logcat -c` through the failure, and `adb logcat -b crash -d` if the
  app disappeared.
- `adb devices -l` output, so the model and the serial are on the record — an OEM skin is a variable
  and half of these lines have never met one.
- The device's Android version and its width in dp
  (`adb -s <serial> shell wm size` and `adb -s <serial> shell wm density`), which is what decides
  whether the two-pane layout should have appeared at all.
- A screen recording for anything about motion, scrolling or layout, because a still frame cannot
  show a stutter: `adb -s <serial> shell screenrecord /sdcard/hermie.mp4`, Ctrl-C to stop, then
  `adb -s <serial> pull /sdcard/hermie.mp4`.

Add what comes back to this file as a new dated section rather than editing this one — this one is
the plan, and what actually happened is the finding.

## The upload path, against a real gateway (2026-09-21, last)

Everything about `POST /api/files/upload-stream` in this file above was read out of
upstream's source or exercised against the fake. This is the first time the app's
own code ran it against a real `hermes serve` — 0.21.3, ungated, session-token
auth — with a real model at the other end. Three findings, one of them a bug in
this repository.

The scripts imported the real `uploadFile`, `withFileReferences` and
`GatewayConnection` rather than re-implementing any of them, which is the only
way this is evidence about the app rather than about a script.

### What the app puts on the wire, verbatim

```
POST https://<gateway>/api/files/upload-stream
header names: content-type, x-hermes-session-token
content-type: multipart/form-data; boundary=----formdata-undici-…
  part "path":      /root/<workspace>/uploads/hermie/2026-09-21/enna7d3m-boodschappen.txt
  part "overwrite": true
  part "file":      filename="boodschappen.txt", Content-Type: text/plain
```

200, with the envelope the module's `UploadedFile` already expects:

```json
{
  "ok": true,
  "entry": { "name": "…", "path": "/root/…", "is_directory": false, "size": 127, "mime_type": "text/plain" },
  "path": "/root/…",
  "root": null,
  "locked_root": null,
  "can_change_path": true
}
```

`root: null` and `locked_root: null` are the "ordinary self-hosted, absolute-only"
row of the policy table above, confirmed rather than inferred. The reference the
app builds from `path` expands: the bot answered a prompt about the uploaded text
file by quoting the marker word out of it **with no tool calls at all**, which is
the gateway inlining the file rather than the agent going to fetch it. That is the
whole path proven end to end.

Size is not a problem here either. 5 MB, 25 MB and 60 MB bodies all returned 200
through the reverse proxy in front of this gateway, so the client's 100 MB cap is
the real limit rather than an optimistic one.

### A `cwd` of `/` uploaded into the gateway's filesystem root

A session created without a working directory reports `info.cwd = "/"`.
`uploadPathFor` strips trailing slashes, so `"/"` became `""` and the file went to
`/uploads/hermie/…` — the root of the machine the gateway runs on. It **succeeded**,
because this gateway runs as root with nothing locked, and it created a directory
in `/` that had to be deleted afterwards. On a gateway that is not root it would
fail with a path error naming nothing.

The module's rule was already right — refuse rather than guess — and its
`no-workspace` message already says the right thing. The guard was simply asking
the wrong question: `"/"` is truthy. It asks about the normalised value now, and
`file-upload.test.ts` pins `/`, `//` and `///`.

Worth recording alongside it: the question this file left open about whether
`info.cwd` arrives populated or lazily is answered. The Bot Chats the app actually
resumes report `info.cwd` populated **and** `lazy: true` at the same time, so the
two are not alternatives.

### An image reaches the bot as a pointer, not as a picture

`stageFile` sends every picked and every dropped file down the `@file:` route,
images included. `@file:` on a binary yields a "this file is on disk" block, so the
model has to go and open it with a tool — and when that tool needed an approval
nobody was there to answer, the bot said so plainly rather than guessing:

> I cannot see or inspect the image contents because the tool run needed to read
> the PNG was blocked before execution.

With tools available it does get there: a five-stripe PNG came back described
correctly, via `vision_analyze` and `terminal`. But in an earlier run the model
**invented** "8 × 8 pixels" for a 3 × 3 image, so a plausible answer about a picture
is not evidence that anything read it.

The gateway has the right call and it works. `image.attach { session_id, path }` on
an uploaded PNG answered `{"attached": true, "width": 500, "height": 400,
"token_estimate": 85}` — the gateway decoded the image itself. Routing uploaded
`image/*` through `image.attach` after the HTTP upload is therefore the obvious
next move, and it is **not** done here: it was not proven that the pixels then
reach the model's context rather than a tool, and a change that swaps one unproven
path for another is not an improvement. Filed as the next thing to measure.

### What this did not prove

- **React Native's `FormData` with a `{uri, name, type}` part.** The browser branch
  was the one exercised, because a standards-compliant `FormData` rejects the other
  shape — which is exactly why the code branches. The three parts are identical
  either way, so the risk is small, but it is read rather than watched.
- **Gated (`native_pkce`) auth on the upload route.** Only the session-token flow
  ran. The bearer-refresh gap recorded in `file-upload.ts` is precisely the thing a
  gated gateway would exercise.
- **Whether `image.attach` puts pixels in the model's context**, as above.

The gateway was left clean: every session created was closed and deleted, every
uploaded file removed, and the directories the probes made — including the one in
`/` that the bug produced — deleted. The two canonical Bot Chats on that box were
resumed read-only to read `info.cwd` and closed again without a prompt.

## Motion, measured on a simulator (2026-09-21, last)

One motion table, four surfaces that used to blink into existence, and a
recording to say whether any of it reads as native. The numbers below are from an
**iPhone 17 Pro (iOS 26.5)** running the Debug build against the fake gateway,
with `--hermieTraceScroll`.

### Reading the trace at all took three attempts, and that is worth writing down

`--hermieTraceScroll` writes with `console.log`, and in a dev client that goes to
**Metro's terminal** and nowhere else. Two channels that look like they should
carry it do not:

- **`xcrun simctl spawn <udid> log show|stream`** never sees it. Hermes'
  `console.log` does not reach `os_log` in this configuration, so no predicate
  finds it — a filter on `[scroll]` over the whole system log answers nothing at
  all.
- **`npx expo start` redirected to a file** prints the banner and then nothing.
  Device logs are an interactive-terminal feature of the CLI, and `CI=1`, which
  does make it non-interactive on purpose, disables reloads without turning them
  on.

What works from a script is Metro's own inspector: `http://localhost:8081/json/list`
lists a CDP target per connected app and `Runtime.consoleAPICalled` over that
socket carries every line. That is the route to use next time the trace has to be
read without a person at a keyboard.

One trap cost most of the attempts, and it is not about logging. **The bundle
installed on these simulators was the Release one.** A Release build defines no
`devLaunchArguments`, so every development argument is inert: `--hermiePreset`
changed nothing, `--hermieTraceScroll` produced no trace, and the app rendered
its last cached transcript so convincingly that it looked connected. Nothing says
so on screen. Installing
`ios/build/SimDerivedData/Build/Products/Debug-iphonesimulator/Hermie.app` and
launching again fixed all of it at once — and the tell, in hindsight, was that
Metro had served no bundle and the fake gateway had logged no request.

### The scroll itself

One flick through the fixture transcript, from the trace:

| What                                | Measured             |
| ----------------------------------- | -------------------- |
| Scroll events in one flick          | 59                   |
| Median interval                     | **17 ms** (~59 fps)  |
| Intervals over 34 ms (a lost frame) | **1**, at the settle |
| `content` height during the scroll  | **926.0, unchanged** |
| Blank cells (`[blank]`)             | **0**                |

The single long interval is 51 ms across the last four events, where the offset
is moving by 0.3 pt a frame — the list coming to rest, not a stutter. The content
height never moving is the more important row: no row re-measured mid-scroll, so
nothing shifted under the reader.

Two height changes recorded on 2026-09-20 are **still there**, both at mount and
neither touched by this round:

```
[row] +201 user-r:1     h=112.0 (new)    →  +251 h=95.0  (-17.0)
[row] +200 assistant-r:6 h=1652.7 (new)  →  +250 h=299.0 (-1353.7)
```

The first is `Bubble.tsx` measuring its inline clock on a line of its own for one
frame, once per mount. The second is a long reply mounting unfolded and folding
on the next frame. Both are one-frame flickers on a cold open rather than
anything the reader's finger can provoke, and both are still worth fixing.

### What was watched rather than measured

On the iPhone, in the Lime preset, with the app connected to the fake gateway:
the native-stack push into a chat and the swipe back are the platform's own and
were not touched; the jump-to-latest pill now rises out of the composer instead
of appearing over it; the chat opens with the transcript pinned to the newest row.

On the **iPad Pro 13" (M5)**, the wide two-pane shell, the sidebar's selected-row
tint and the overlay panel behave as before — the panel's timing moved from a
token called `sheet` to one called `panel` at the same 420 ms, so nothing about
it should look different, and nothing did.

### What this did NOT verify

- **The prepend anchor, on a device.** `maintainVisibleContentPosition` holding
  its place through `prependHistory` is covered by the controller's tests and by
  the prop's own contract, and it was not watched on a simulator: the fake
  gateway's fixture chat is seven rows, so `loadOlder` answers `start` on the
  first ask. A long scenario is what that needs.
- **Reduce Motion.** Still no way to turn it on from `simctl` — `simctl ui`
  offers appearance, contrast and content size and nothing else — so the zero
  durations are covered by tests and unwatched. A stock Android AVD reports it as
  ON, which makes the emulator useless for the opposite reason.
- **Haptics.** A simulator has no Taptic engine, so the calls are unobservable
  there, and the one behaviour this round changed — nothing fires in a Mac
  window — is a decision about `RUNS_ON_MAC` rather than something a simulator
  can show. A test pins it.
- **Frame drops under a streaming reply.** The trace above is one flick through a
  settled transcript. The interesting case is a reply arriving while the reader
  scrolls, which needs the fake gateway's `--stream-delay` and a longer sitting.

## Push, on a simulator (2026-09-21)

The app half of [ADR-0017](adr/0017-push-through-hermie-web.md), measured on an
**iPhone 17 Pro (iOS 26.5)** and an **iPad Pro 13" (M5)** running the Debug build
against `packages/fake-gateway`. What made this verifiable at all is that a
registration is not an API call to anything: it is a section of `ui_meta`, so the
whole round trip can be read back with one HTTP request to the fake gateway's
`/api/profiles`.

### A simulator does mint a real Expo push token

This was the open question, because a simulator has no APNs device token in the
sense a phone does. It works: `getExpoPushTokenAsync({ projectId })` answered
`ExponentPushToken[…]` and the row landed on the default profile exactly as
`packages/hermie-web/src/push/registrations.ts` reads it —

```json
{
  "registrations": {
    "i…": {
      "v": 1,
      "platform": "ios",
      "types": { "message": true, "request": true, "dm": true, "cron": true },
      "preview": false,
      "updatedAt": 1789965204,
      "transport": "expo",
      "token": "ExponentPushToken[…]"
    }
  },
  "seen": {}
}
```

`preview: false` and all four types on is the default the switch writes, and the
token is a send ADDRESS rather than a credential — which is why it is in `ui_meta`
and not the secret store.

### The heartbeat had a race, and only a device showed it

`seen` stayed `{}` with a chat open for well over a period, while the
registration beside it updated twice. The cause: the store's installation id is
the key a beat is written under, and a chat that comes on screen before the disk
read finishes beats into nothing — then nothing asks again until the interval
comes round a minute later. Launching straight onto a chat
(`--hermieOpen chat:researcher`) loses that race every time, which is why the
unit tests did not: they hydrate first because they await it.

`PushSync.boot` now re-runs `syncHeartbeat` after `hydrate`, and
`syncHeartbeat` beats once for a timer whose first beat stamped nothing.
Re-measured: `"seen": { "i…": 1789965425 }` within seconds of the chat opening.
`push-sync.test.ts` pins it as "beats once the store has hydrated, for a chat
that opened before it did".

Worth writing down beside it: the ADR's heading calls this "last seen **per
chat**", and the daemon's reader keys `seen` by INSTALLATION id with no chat in
it. The app writes what the reader reads. The consequence is that a tablet with
any chat open suppresses a message notification about any chat on that device;
`ChatScreen` says so where the beat is driven.

### `simctl push` reaches the app, and the Allow/Deny category is real

`xcrun simctl push <udid> dev.hermie.app <file>.apns` delivers to the installed
build with no Expo round trip. Two payloads were used; both put the app's own
data under `body`, which is the key `expo-notifications` reads `content.data`
from:

```json
{
  "Simulator Target Bundle": "dev.hermie.app",
  "aps": { "alert": { "title": "Researcher", "body": "needs your input" }, "category": "hermie.request" },
  "body": { "bot": "researcher", "type": "request", "requestId": "…" }
}
```

- A plain `message` payload posted a banner reading "Researcher / sent a
  message"; tapping it opened that chat.
- A `request` payload posted under `hermie.request` and, expanded, showed the
  **Allow** and **Deny** buttons the category registers.

### The forged Allow does what the threat model says

The decisive one. With the app sitting in **Writer's** chat, a `request` payload
naming `requestId: "rm -rf /"` was pushed and **Allow** tapped. The app came to
the front, navigated to **Researcher's** chat, and sent nothing: no
`approval.respond`, and no answered-approval chip in the transcript. That is
ADR-0017's rule — "a notification is a hint that something happened, never an
instruction" — behaving as written, on a device rather than in a test.

### What this did NOT verify

- **A real Expo delivery.** Everything above is `simctl push`, which hands the
  payload to the device directly. The Expo Push API, its receipts and the
  `DeviceNotRegistered` retirement are the daemon's half and were not exercised.
- **Android.** No notification was delivered to an emulator this round. The two
  channels (`default`, `needs-input`) are registered from the same `prepare()`
  the simulator ran, but their importance is unobserved — and a stock AVD's
  notification settings are their own subject.
- **A revoked permission mid-session.** The "turned it off in system settings"
  path is covered by a test against a fake platform; `simctl privacy` has no
  verb for notifications, so it was not reproduced.

### The browser transport is the least verified of the three

`platform.web.ts` and `public/hermie-push-sw.js` were not run in a browser at
all. What is tested is the part between the browser's answer and the row —
the VAPID base64url decoding, the projection of a `PushSubscription` onto the
`webpush` shape, and the gate that reports the whole feature unavailable where
`isSecureContext` is false (`__tests__/push-web.test.ts`). What remains, and
needs a TLS deployment of Hermie Web with `--push` to close:

- **Service-worker registration and scope.** jsdom implements no
  `navigator.serviceWorker`. That `expo export --platform web` copies
  `public/hermie-push-sw.js` to the export root — which is what gives it a scope
  covering the app — is read from Expo's behaviour, not watched.
- **`pushManager.subscribe`.** No push service, no endpoint, and no
  implementation of `applicationServerKey` to reject a key this code got wrong.
- **`GET /push/vapid-public-key`.** The daemon does not serve it yet. The client
  accepts either `{"key":…}` or `{"publicKey":…}` so the two halves cannot miss
  each other on a field name, and answers "unavailable" for anything else.
- **The worker's own two handlers.** `push` and `notificationclick` run in a
  ServiceWorkerGlobalScope; a stand-in for `clients.matchAll`,
  `showNotification` and the rest is a second implementation, and it is the
  first one that would have the bug.
- **Permission from a user activation.** Several browsers require
  `Notification.requestPermission()` to be called inside one. The switch in
  Settings is what calls it, which satisfies that by construction — but by
  construction is not the same as observed.

## The push daemon, server-side (2026-09-21, later again)

What was built this round is the half of [ADR-0017](adr/0017-push-through-hermie-web.md) that needs
no device in the room: `hermie-web --push`, its gateway connection, the watcher, both transports,
and the availability stamp. The app side — minting an installation id, writing a registration,
writing the `push.seen` heartbeat, drawing a notification and re-validating an approval before
answering it — is untouched, so **nothing below has been observed on a phone**.

### Three constraints of this package decided most of the design

`packages/hermie-web` ships as a self-contained CommonJS `dist/server` with **no `node_modules`
beside it** — the Dockerfile says so and the release job zips `package.json`, `bin`, `dist` and
nothing else. Three consequences, all of them visible in the code:

- **The shared JSON-RPC client could not be imported.** `packages/hermes-shared` is ESM TypeScript
  consumed as source, and a cross-package import would emit a `require` the released artefact cannot
  resolve. `push/link.ts` therefore mirrors `json-rpc-gateway.ts`'s contract — request ids and a
  pending map, `event` notifications, the `gateway.ping` heartbeat, `session.events.since` replay
  with per-session watermarks and the epoch check — and says at the top that the shared file is
  right where the two disagree. The same applies to the cron and bot-DM header parsers, whose
  canonical forms are in `packages/transcript`.
- **`ws` is a devDependency, so the transport is Node's global `WebSocket`.** Making `ws` a runtime
  dependency would break the "installs nothing" property of the image and the zip.
- **Web Push is hand-rolled.** RFC 8291 and RFC 8292 out of `node:crypto`: ECDH on P-256, two HKDF
  rounds, AES-128-GCM in one `aes128gcm` record, and an ES256 JWT signed with
  `dsaEncoding: 'ieee-p1363'` because Node's default DER signature is what every push service
  rejects with an unhelpful 401.

**If any of those constraints is ever relaxed, the first three files to revisit are
`push/link.ts`, `push/inbound.ts` and `push/web-push.ts`** — each is a copy of something that has a
better home.

### The link refuses things rather than merely not doing them

ADR-0017 says the daemon "is a reader: it never submits a prompt, answers a question, or changes a
setting." A sentence in a document that nothing enforces is a sentence, so `GatewayLink.request`
checks an allowlist and refuses `profiles.configure` unless `ui_meta` is all it carries. Both are
pinned by tests against the fake gateway. `approval.pending` is on that allowlist and
`approval.respond` is not, which is the difference between reading a queue and answering for somebody.

### The unverifiable assumption was made opt-in instead of default

The first cut of this advertised `client.capabilities {server_requests: true}` so approvals would
arrive live, and then never answered one — which is safe **only** if a session's transport fans a
request out to every peer, so the app receives the same question and answers it. ADR-0017 quotes that
fan-out from upstream's reaper comments and the fake gateway reproduces it, but it has never been put
to a real `hermes serve`. On a backend that routes to one peer instead, the daemon receiving an
approval and holding it open takes the question away from the person it was for — the worst failure
this feature could have, and one nobody would diagnose from the app.

So the default is not to ask. Open questions now come from two places that cost the gateway nothing
it was not already doing:

- **`session.resume`'s snapshot** — `open_requests`, and `pending_approval`, which is the queue entry
  and therefore the only trace of a question raised before this connection existed. The fake gateway
  grew both: `raiseApprovalOn({ queueOnly: true })` stages exactly that case, and `session.resume`
  now answers `pending_approval` from the queue the way the contract says it does.
- **An `approval.pending` poll**, the same RPC and the same 30 s the app's `APPROVAL_POLL_MS` uses,
  and only while at least one device is registered.

`--push-server-requests` turns the live route back on for an operator who knows their gateway. The
cost of the default is up to thirty seconds of latency on an approval notification; the cost of the
flag on the wrong gateway is the approval.

One thing this exposed: the same question reaches the watcher under up to three envelopes — a live
`srq-N`, a resume's `open_requests` (a NEW `srq-N` after each reconnect) and `pending:<request_id>`
from the snapshot or the poll. Keying dedupe on the envelope buzzes once per route and once per
reconnect. The queue's own `request_id` is the identity, and a clarify — which has none — falls back
to the JSON-RPC id.

And an ordering trap worth recording: the link hands a resume's snapshot to its callback while the
`session.resume` call is still settling, which is **before** the watcher knows which bot that session
belongs to, so those notifications were silently dropped. The watcher now reads `open_requests` and
`pending_approval` off the resume result itself, once the mapping exists.

### Classifying a turn is five rows, not a transcript

A cron delivery and a bot-to-bot DM arrive as an ordinary `role: "user"` row with a header spliced in
front — no event, no `display_kind`, no metadata ([ADR-0013](adr/0013-cron-deliveries-in-the-transcript.md)).
The only place the answer lives is that row.

The first cut read it with `session.history`, which is unpaginated: on a long chat that is the whole
transcript downloaded to look at its last row, once per finished turn. It now reads
`GET /api/sessions/{id}/messages?limit=5&order=latest` — the same route, the same `null` contract and
the same "newest rows last" ordering as the app's own `reconcileTailFor`, so `lastInboundRow` scans
from the end either way. `session.history` stays as the fallback for a gateway with no REST surface,
which is a supported gateway rather than a broken one. The guards are unchanged: it runs only when
somebody is registered, and both routes failing degrades to "the owner typed" rather than to silence.

The REST rows spell the body `content` rather than `text`, which the classifier already handled; the
integration test lets those requests through to the real fake gateway rather than stubbing them, so
what is exercised is the route and not a fixture.

### What the integration suite actually proved

Against `@hermie/fake-gateway` over a real socket, with only the two push services stubbed:

- a seeded registration plus a staged cron delivery produces **one** Expo send, titled with the
  bot's display name, bodied `cron “…” reported`, carrying no part of the report;
- a staged bot-to-bot delivery is read as a DM and names the sender;
- an approval produces a notification carrying the request id and the `hermie.approval` category,
  with the command left on the gateway — including when it was raised BEFORE the daemon started
  (resume snapshot) and when it was raised with no live frame at all (poll);
- one question carried by a live frame, a resume snapshot and a poll at once buzzes exactly once,
  across a reconnect;
- nothing is polled while no device is registered, and `client.capabilities` is never sent unless
  `--push-server-requests` asked for it;
- a finished turn is classified from five REST rows, with `session.history` never called — and from
  `session.history` when the REST route answers 404;
- a `push.seen` stamp a few seconds old silences an ordinary message and a ten-minute-old one does
  not — and neither silences the approval;
- dropping the socket after a send, reconnecting and replaying the same turn out of the gateway's
  ring sends nothing a second time;
- the Web Push body is decrypted with the test subscription's own private key, so what is asserted
  is that a browser could read it;
- the availability stamp lands in `hermie-app.push` on the default profile while `hermes-bots` — the
  marker another tool owns — is still there afterwards.

One real race came out of writing those: the roster is read before the chats are resumed, so
"watching" and "listening" are not the same moment, and an event arriving between the two belongs to
no session yet. `PushWatcher.resumed` now exists so a caller can wait for the second thing.

### What is NOT verified

- **Anything on a device.** No phone, no browser, no service worker. Nothing has actually buzzed.
- **A real `hermes serve`.** Every gateway interaction here is against the fake. The `ui_meta`
  compare-and-swap it reproduces was probed against 0.21.3 for ADR-0016, but `pending_approval` on a
  resume, the shape `approval.pending` answers with, the REST messages route's ordering, and the LRU
  pinning the ADR warns about were not.
- **The fan-out of server requests**, which is now the thing `--push-server-requests` is gated on
  rather than something the default relies on. Whether a real backend sends a request to every peer
  or to one is still unknown; the point of the change is that nobody finds out the hard way.
- **A real Expo or push-service round trip.** Both senders are exercised against stubs. Ticket and
  receipt shapes come from Expo's documentation; a 201 from a push service is assumed rather than
  seen.
- **An OIDC-gated sign-in.** `hermie-web login` is covered end to end against a stubbed token
  endpoint and a real loopback listener, but no identity provider has been through it, and the
  no-refresh-token refusal has never been triggered by a real provider.
- **The LRU cost.** Nobody has run this against a gateway with `max_live_sessions` set to watch the
  resident set behave.
- **Long-running behaviour.** The receipt sweep, the availability heartbeat and the ticket ageing
  are all on quarter-hour and five-minute timers that no test waits out.

## Four reports from build 163, on an iPad that can now be tapped (2026-09-21, later)

The thing that changed about this round is the instrument. Every earlier section
here opens with some version of "`simctl` has no tap verb", and everything behind
a tap was therefore covered by tests and unwatched. A dedicated simulator tool
now injects taps, long presses and arbitrary touch PATHS in device points, which
is what made three of the four reports below reproducible rather than reasoned
about. Everything was driven on an **iPad Pro 13" (M5)** and an **iPhone 17 Pro**,
Debug, against `packages/fake-gateway`, with the recipe this file already
records (`RCT_USE_PREBUILT_RNCORE=0`, a UTF-8 locale, `xcodebuild` + `simctl
install` + `--hermieGateway`).

### A backdrop that was only ever the space ABOVE the sheet

Reproduced and then fixed, both watched. `BottomSheet`'s scrim was a `flex: 1`
sibling ABOVE the panel in a column, so it was exactly the leftover height over
the sheet. On a phone that is the whole backdrop and the defect cannot be seen.
On the iPad the panel is capped at `SHEET_MAX_WIDTH` and parked over the content
column, so most of what a reader sees as backdrop is BESIDE it — and that area is
the `KeyboardAvoidingView` that centres the panel, a transparent view, which
absorbs a tap exactly as an opaque one does.

Measured on the iPad, window 1032 × 1376, with the chat options sheet up: the
panel occupies x ≈ 422…978. A tap at **(350, 1100)** — left of the panel, well
below its top edge — left the sheet open. With the scrim moved to
`StyleSheet.absoluteFill` and the column set to `pointerEvents="box-none"`, taps
at **(350, 1100)** and **(1012, 1100)** both close it. The A/B was done by
flipping that one prop through Metro's fast refresh, so the two screenshots
differ by one line of code.

`__tests__/sheet-backdrop.test.tsx` pins the two properties that ARE the hit test
— the scrim's absolute fill, the column's `box-none` — and says in its own header
that it is not hit testing, because the test renderer has no layout engine. The
tap is the evidence; the file is the regression.

### The accent that is a swatch, drawn as a word

`InsetButtonRow` defaulted to `tone='accent'` and rendered `<Text color={tone}>`.
`accent` is the swatch FILL and has no contrast floor — deliberately, because
holding it to one would rule out both the Graphite accent and the studio's lime.
Measured on the inset card each Settings row sits on:

```
graphite/dark  accent(fill)=1.33   accentText=7.25
lime/light     accent(fill)=1.14   accentText=6.11
blue/dark      accent(fill)=2.02   accentText=6.84
```

The owner reported Graphite. Lime light was worse.

Two things were wrong and only one of them is a colour. `npm run contrast` could
not fail, because a fill is not an ink and nothing measured it — and it also
never reached the surface in question: `surfacesFor` measured the four GLASS
variants, the bubbles and three tints, and the inset card is `elevation.e3c`, a
flat rung that no glass recipe touches.

Both are closed, and the first one structurally: `Text`'s `color` prop is typed
`TextColorRole`, which is `ColorRole` minus the three fills, so naming a fill is
a compile error. That alone turned up **seven more** call sites drawing a status
word or a chip in an unfloored colour — a subagent's `completed`/`running` words,
a ledger row's `ok` tone. The check now also measures the opaque rungs `e1`, `e2`,
`e3` and `e3c` against every ink. `e4` is the one rung with a narrowed list: it is
not a panel, it is the selected segment of a segmented control, and the only ink
drawn on it is `text`. 743 pairs across three themes.

A type-level line in `contrast.ts` fails to compile if a role is ever added to
`TextColorRole` without being added to the table, which is the difference between
a table that is complete and one that happens to be.

### A bare `k` that was a ⌘K, and the two gates behind it

The native allow-list already required Command for `search`, so the reported
keystroke should have been impossible. It was not, and the cause is written out
three inches above it in the same file: `HermieMacModule` kept a `shiftLatch`
because GameController's polled `isPressed` sticks ON when a modifier's key-UP is
delivered to another window. Command has exactly the same problem and had no
latch — so a ⌘ released over another app leaves `command` true for ever, and every
bare letter on the table becomes its own chord. It is one mechanism for every
modifier now (`heldModifiers`), cleared on scene activation and on keyboard
connect, and a modifier is believed only when the poll and the latch agree.

**Not reproduced on a device**, and it cannot be from here: making the poll stick
needs a real modifier released into another window, and the simulator control has
no chord injection. What is reproduced is the shape of the bug in its Shift form,
which is already in this file under "the owner's report is what it looks like
when it is trusted".

Two gates were added in front of the dispatcher, and those ARE tested
(`desktop-shortcuts.test.tsx`, 20 cases):

- **`typing`** travels with the event. The GameController handler sits below the
  responder chain — which is what makes it survive a presented `Modal` — so it
  cannot tell a shortcut from a keystroke; it reports whether the first responder
  is a `UITextInput` and `useShortcut` decides. Only the composer's own list keys
  and ⌘W are delivered while a field has the caret.
- **A modal scope stack.** `search`, `toggleSidebar`, `nextChat`, `previousChat`
  and ⌘1…9 go to the surface UNDER an open sheet or panel, so they are dropped
  while one is up. `BottomSheet` and `OverlayPanel` register; `SidebarOverlay`
  deliberately does not, because at that width the overlay IS the chat list.

The menu bar's own path reports `typing: false` whatever is focused, and that is
not an oversight: a `UIKeyCommand` is IN the responder chain, so the focused text
view was offered the keystroke first and declined it.

**A finding this round did not fix.** On a Mac both paths are live, so ⌘W fires
`onShortcut` twice — once from GameController and once from the menu item — and
`closeTopmost()` twice closes two levels. Suppressing the keyboard path for
menu-provided actions is the obvious fix and is wrong: the menu path is a
responder-chain path, which is the one thing that does not survive a presented
`Modal`, and that is the case ⌘W matters most in. A timing-based dedupe is worse
than the symptom. It wants a decision, not a patch.

### "Move up and Move down are gone" — on the platform's menu, they are not

A long press on a chat row on the iPad draws the system menu with **Open, Mark as
read, Colour ▸, Move to section ▸, Move up, Move down, Add divider above,
Archive**. Screenshot taken. Nothing is missing there, and nothing in the history
ever said "Move to top".

What IS true, and is the one place the report is literally right: the FALLBACK
sheet — the menu on Android and on any build whose native side predates
`HermieContextMenuView` — was never moved onto the shared model.
`row-menu-items.ts` opens by saying the two menus "are two ways of drawing ONE
list of intentions"; only the native drawing ever read it. The sheet offered a
colour, Archive, and one line per section, the first of which is the top group —
so on that path, moving a chat to the top really was all a reader could do to the
order. It is rendered from `rowMenuItems` now, with the colour node drawn as
swatches and a submenu opened as a `SheetPage`, and it reports to the same
handler the native menu does.

### The drag, and what it was missing

It worked; it did not feel like anything. Driven on the iPad with a touch path —
press, 400 ms dwell, then eight samples down one row — the row moved and the
arrangement committed through `moveToIndex`, which is `ui_meta`. What was absent
was every part of the gesture that is not the translation: the lift was a style
that switched (`scale: 1.02` in one frame), the drop was instant, and the other
rows did not move at all — a two-point line said where the row would land.

Now: `lift` springs 0 → 1 and the scale and shadow interpolate off it;
`rowShift` decides which rows move aside and they spring on the native driver;
releasing springs the lifted row into the gap and commits on that animation's
completion, so the re-render that follows moves nothing. All three collapse to
zero under Reduce Motion through `Animated.timing(duration: 0)`, which keeps the
completion callback that commits the drop on exactly one code path.

The drop LINE is gone and the objection that put it there is preserved beside its
grave: it said a gap costs a layout pass per row per slot change. True of a gap
made of layout; this one is `transform` on the native driver and touches neither
layout nor the JavaScript thread, and `rowShift` moves only the rows between the
lifted row's place and the gap.

Watched, mid-drag, at 780 ms into the path: the neighbour had moved up into the
vacated slot with the lifted row still under the finger. **Not** separately
confirmed by eye: the shadow and the 1.03 scale, which at a dark theme's contrast
and a screenshot's resolution are not distinguishable from the unlifted row.

Two more, watched: a dwell of 1.2 s before moving gets the system context menu
instead of the drag, which is the documented split and is what the Files app
does; and `delayLongPress={300}` means a path that drifts a point or two during
the dwell arms neither.

**The grab cursor is not implemented, and cannot be from JavaScript.** React
Native 0.81's `CursorValue` is `'auto' | 'pointer'` and nothing else
(`StyleSheet.d.ts:30`). A grab cursor over a draggable row and a grabbing cursor
during the drag need a `UIPointerInteraction` in the local module.

### The slash walkthrough, and two things it found

On the iPhone, against the fake gateway: `/` opens the popover with `/model`,
`/reasoning`, `/status` and `/help`; `/mo` narrows it to `/model` alone; sending
`/model` prints `ⓘ /model — Current model: example-provider/exam…` in the
transcript. All watched.

Two defects in between, both fixed and both re-watched:

- **Return did not take the highlighted row.** `submit()` has always put the list
  first, and on a phone it was never reached: `submitBehavior` is `'newline'`
  without a hardware keyboard, so Return inserted a line break and `onKeyPress`
  declined it. The list is now `'submit'` while it is open, on any keyboard.
- **The send button could not send a slash command at all.** It called `submit()`,
  which prefers the list — so with `/model` fully typed the list stayed open on
  the exact match and the button re-accepted a suggestion instead of sending, with
  no way out, because the only thing that dismisses the popover is Escape. It
  sends now. Return stays ambiguous and keeps the list; a tap on the round button
  is not ambiguous.

### The bubble tail from 7747ddf, zoomed

Dark Blue, incoming bubble, bottom-left corner at 3× : the tail is the bubble's
own colour with no seam and no darker notch where the two meet. The fix holds.

### What this round did NOT verify

- **Anything on a Mac.** ADR-0011's build is scripted and the run needs a window;
  the owner's own Hermie holds that bundle identifier. Every "on a Mac" sentence
  above is about the iPad build, which is the same binary.
- **The stale-Command fix itself**, for the reason given above. What is verified
  is that it compiles, that the Shift path it generalises still answers, and that
  the two JavaScript gates behind it do what they say.
- **Reduce Motion**, still. `simctl ui` offers appearance, contrast and content
  size and nothing else, so the zero durations in the drag are covered by the one
  code path and by tests, and unwatched.
- **Haptics**, still: a simulator has no Taptic engine, so the per-slot tick added
  to the drag is unobservable there.
- **Render counters under a drag.** The claim that the aside animation costs no
  layout pass is read off the native driver's contract and off `rowShift`'s own
  arithmetic, not off a trace.
- **Android.** The fallback row menu is the path Android actually uses, and it was
  exercised in Jest and on neither an emulator nor a device.

## The reconnect that never recovered (2026-09-21, later still)

Reported from the Mac build: Tailscale off gave "Reconnecting…", Tailscale back
on left it saying "Reconnecting…" until the app was relaunched. The dial ladder
looked healthy in the code — full jitter, a 15 s cap, a redial on every close —
and it was. What was not healthy is that **a connectivity report could stop the
ladder, and only another connectivity report could start it again.**

`GatewayConnection` kept an `online` flag from
`@react-native-community/netinfo` and put it in four places: `alive()` in the
dial loop, the early return in `onTransportClosed`, the early return in
`scheduleReconnect`, and both branches of `setOnline`. Each one reads as a
sensible battery saving on its own. Together they are a state with no exit that
does not come from outside.

Two ways in, and both are reproduced against the fake gateway in
`packages/gateway-client/src/connection.test.ts`:

- **A report that never comes back.** `setOnline(false)` tore everything down —
  socket, retry timer, dial token — and set `offline`. Nothing in the object
  ever dials again; `scheduleReconnect` returns before it arms a timer, and
  `runDial`'s `alive()` is false before it does anything. The only wake-up is a
  later `setOnline(true)`. A tailnet interface going away and coming back is
  exactly the transition a connectivity API is worst at, and the gateway on the
  other end of it was reachable the whole time. The test
  _recovers from a connectivity report that never comes back_ stages it: every
  dial it now makes would have succeeded, and none of them used to happen.
- **A flap around a real drop**, which is the worse of the two because the
  header kept saying the connection was up. Offline arrives while the socket is
  live, so the 2.5 s grace starts and the socket is deliberately left alone. The
  socket then dies for real — and `onTransportClosed` threw the close away,
  because `!this.online`. Online arrives inside the grace, the flap rule says
  "the socket never came down, there is nothing to redial", and the connection
  sits on `ready` over a dead socket for ever. The probe that found this asserts
  a round trip rather than a status, because the status is the part that lies:
  _redials when the socket dies inside the offline grace and the report flaps
  back_.

Which of the two the owner hit is **not established**. Both end in a connection
that only a relaunch fixes, and neither can be told from the other by looking at
the app. The label in the report ("Reconnecting…" rather than "Offline") fits
neither exactly — `offline` is its own word in `strings.chat.subtitle` — so
either NetInfo reported something in between, or the header was showing the last
status before a stall the second path explains. It is recorded here as unproven
rather than tidied up into a story.

### What connectivity is allowed to do now

Advice about timing, never permission to dial. `online` survives in exactly
three places, all of them cosmetic or an acceleration:

- it picks the **word** in `scheduleReconnect` — `offline` instead of
  `reconnecting` — so a reader still gets told which it is;
- it delays the teardown of a **live** socket by `OFFLINE_GRACE_MS`, which is
  the original and still-good reason the grace exists: a Wi-Fi/cellular handover
  should not rebuild every session;
- coming back online **collapses a pending backoff** through `retryNow()`, but
  only when the last dial did not fail. A dial that failed inside
  `DIAL_FAILURE_RECENT_MS` means the gateway rather than the radio is
  unreachable, and the ladder it earned is left to climb — it is capped, so
  recovery is at most one interval away either way.

The ladder itself now runs whatever NetInfo says. That costs battery in a
genuine outage — a capped ladder is four dials a minute for as long as the app
is in the foreground — and it is a deliberate trade against a connection that
cannot be recovered without a relaunch. A dial with no radio fails in
milliseconds; a phone in a pocket is `paused`, which still stops everything.

`retryNow()` is new on `GatewayConnection`: reset the ladder to the bottom and
dial now. It is deliberately harmless to call at any time, and deliberately does
**not** restart a connection that stopped for a reason it can explain —
`needs_signin`, a refused certificate, a gateway that rejects this address.
Redialling those fails the same way and erases the explanation.

### What this did NOT verify

- **Anything on a Mac, or on any device.** Every sequence above is driven
  against `packages/fake-gateway` in Node. No Tailscale interface was taken down
  and put back while the app watched.
- **What NetInfo actually reports** when a tailnet interface appears and
  disappears, on a Mac or on iOS. The fix is written so that the answer does not
  matter, which is the point, but it also means the answer is still unknown.
- **A negative DNS cache**, the other suspect for "the gateway is back and the
  dial still fails". If CFNetwork holds a negative answer for a MagicDNS name,
  the ladder now keeps asking — which is the best this layer can do about it —
  but nothing here measured whether it happens.

## Web QA (2026-09-21)

A pass over the browser build, driven in a real Chromium against
`packages/fake-gateway` in cookie mode behind `packages/hermie-web` — the
`npm run web` pair. Walked signed out and signed in, at 1280, 820 and 390, in
both colour schemes. What follows is the defect list the pass produced, what was
fixed, and — at least as important — what it did not get to.

### One note on method, because it cost an hour

**Viewport emulation and screenshots are not the same picture.** The first hour
was spent reading a screenshot that showed a layout the DOM did not have: a
narrower sidebar, no tab strip. `innerWidth` said 1280 and `getBoundingClientRect`
agreed with it, while the image was a render at the pane's own size. Every
geometric claim below therefore comes from measuring the DOM, and the images are
used for how a thing LOOKS, never for where it is.

The same care caught two defects that were not defects. A chat row announced
`Researcher, Online` while its subtitle read `Offline · last seen 17:27` — the
same `presence` prop feeds both and they cannot disagree; the tree had been read
mid-transition, before presence arrived. And a bubble reading
`first linesecond linethird line` looked like newlines being eaten, which would
have been a serious rendering bug; sending `alpha\nbeta gamma` through the
composer proves the whole path is intact — Shift+Return inserts, bare Return
sends, and the bubble keeps the break. That bubble is residue from an earlier
session that typed three lines into a field one line at a time.

### Fixed

| What                                                                                                                                | Commit    |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| The document said nothing about itself: no manifest, no `theme-color`, no `apple-touch-icon`, no `color-scheme`, no page background | `f39b303` |
| The browser tab named the route KEY (`Bots` for the screen headed Chats), or nothing at all in the wide layout                      | `e2b12f1` |
| Sign-in: Return did not submit; no `autoComplete`, so no password manager; accessible names shouted                                 | `d15a4f6` |

Each is described in its own commit message. The two worth repeating here:

- **The white flash.** The bundle is 2.35 MB and the first paint happens before
  any of it runs. With no background on `html`/`body` that gap was white, which
  on a dark theme is the most visible thing the build does. The template paints
  it from `prefers-color-scheme`; `platform/status-bar.web.tsx` — a deliberate
  no-op until now, whose own header said `theme-color` was the document's problem
  — corrects both the meta and the page background from the live theme, which is
  what covers a visitor who has PINNED Light against a dark system, or picked a
  preset whose background is a third colour again.
- **`color-scheme` is not cosmetic.** It is what makes the user agent draw its
  OWN widgets — scrollbars, the caret — in the dark palette. No app-side styling
  reaches them. macOS hides scrollbars until you scroll, which is why nobody
  here had seen the light-grey slab every other platform draws.

### Found, not fixed

In rough order of how much they cost a user.

- **A markdown link is a `div`, not an `<a>`.** `markdown/Inline.tsx:305` renders
  a `Text` with `accessibilityRole="link"`, which react-native-web does not map to
  an element (its role table has `button` and `list` and no `link`), so what ships
  is a `role="link"` div with no `href`. The press goes to `Linking.openURL`,
  which does open a new tab and does pass `noopener`. What is lost is everything
  a browser gives an anchor for free: no keyboard focus, no middle-click, no
  cmd-click, no "copy link address", no URL in the status bar — and `noreferrer`
  is absent, so the full referrer reaches the destination. The fix is RNW's
  `hrefAttrs`, which is a shared-file change rather than a seam and wants its own
  round.
- **Decorative icons stay in the accessibility tree on the web.** `ui/Icon.tsx:96`
  hides itself with `accessibilityElementsHidden` and
  `importantForAccessibility` — the iOS and Android props. RNW honours neither;
  it wants `aria-hidden`. Several controls (the four tabs in `SidebarFooter.tsx:87`,
  the archived row, the DM rollup, `DisclosureRow`) deliberately carry no
  `accessibilityLabel` because "the label under the icon is what a screen reader
  reads". Chrome's own tree does compute a name from the text and the tabs read
  correctly there; a second reader on the same page returned four tabs with no
  name at all. So the premise those components were written on is false on this
  platform even where the symptom does not always show.
- **`TextField` can emit an empty accessible name.**
  `ui/primitives/TextField.tsx:49` ends `?? ''`, and `aria-label=""` REMOVES a
  name rather than falling through to the content. Only reachable when a field
  has neither label nor placeholder, which is why nothing visibly broke.
- **Focus rings stop at text fields.** `ui/useFocusRing.ts` draws a proper ring
  and is used in exactly two places (the composer, the bots search). Buttons and
  list rows are real `<button>` elements and do get the browser's default ring —
  drawn tight to the box, in the UA colour, ignoring the row's radius and the
  glass under it. Markdown links get no focus at all, per the item above.
- **Day separators are `<h1>`.** A transcript has one per day and the page has no
  real first-level heading, so a reader navigating by heading gets a list of
  dates and nothing else.
- **The gateway's address is Hermie Web's own.** Settings → Gateway → Address and
  the wizard's Ready step both show `http://127.0.0.1:9120`, which is the app's
  origin because the proxy makes it so. The sign-in step one screen earlier says
  `talking to 127.0.0.1:9119`, correctly. Two screens in one flow naming two
  different things "the gateway" is the defect; `/hermie/config.json` already
  carries the upstream host that the sign-in step reads.
- **The welcome copy shows its markup.** "the machine running \`hermes serve\`"
  renders with the backticks visible: the wizard draws plain text where the
  transcript would draw a code chip.
- **The sign-in error is not announced.** "That user name and password were not
  accepted." appears with no `role="alert"` and no live region, so a screen
  reader is told nothing happened.
- **No maskable PWA icon.** A maskable icon needs the backdrop at full bleed and
  the mark inside a circle of 80% of the canvas; the mark's corners reach 460 of
  the 409 that allows, so it needs two transforms in one image and
  `scripts/lib/svg-raster.mjs` composites every shape through one. Android draws
  the `any` icon on a white circle of its own until the rasteriser can layer.
- **Two untranslatable literals**, both hard-coded past the string tables:
  `ui/BottomSheet.tsx:413` (`"Dismiss"`) and `chat-ui/TypingIndicator.tsx:64`
  (`"Replying"`).
- **Console noise on every load.** Two `useNativeDriver` warnings from
  `Animated`, and RNW warns that `selectable` is deprecated on every markdown
  render in a dev build.
- **`design/tokens.md` is stale.** It gives the app background as `#F2F2F7` /
  `#000000`; neither string appears anywhere in `apps/hermie/src`. The live
  values are per preset in `ui/themes.ts` — blue is `#EAF3FF` / `#070F1D`, which
  is what the new document template and `app.config.ts`'s splash colours should
  be read against.

### Measured

Scrolling, on the heaviest transcript this fixture can produce: the Researcher
chat with the fold expanded, so a code block, a five-row table and three nested
lists are all live. 2263 px of content in a 793 px viewport, walked top to bottom
and back twice in 60 px steps, timed with `requestAnimationFrame` deltas and
`PerformanceObserver` on `longtask`:

| Run             | p50    | p95    | p99     | max   | frames > 16.7 ms | long tasks |
| --------------- | ------ | ------ | ------- | ----- | ---------------- | ---------- |
| Unthrottled     | 8.3 ms | 8.5 ms | 13.4 ms | 13 ms | 0 of 100         | 0          |
| 4× CPU throttle | 8.2 ms | 9.7 ms | 14.6 ms | 15 ms | 0 of 100         | 0          |

A p50 of 8.3 ms is the display's own 120 Hz cadence, so nothing is being dropped
rather than everything being fast. No long task fired in either run.

**This is not the 400-row measurement that was asked for.** The fake gateway has
no large-transcript fixture and no flag for one, and building 400 rows means 200
send-and-reply round trips through the live socket. What the numbers above cover
is a heavy transcript, not a long one, and the list's own recycling is therefore
untested here.

### Not covered

Said plainly, because a defect list that implies coverage it does not have is
worse than a short one. **Read this against the second pass below**: some of it
is covered now, some of it is covered for a different reason than expected, and
the conversation surface is still the big hole.

- **Most of the conversation surface.** Streaming and the fold were watched; tool
  cards, thoughts, bot-to-bot lines, cron cards, the approval and clarify sheets
  (backdrop click, Escape, drag), the queued strip with Steer/Edit/Delete, the
  slash popover, the attach menu, attachments by picker, drag-and-drop and paste,
  and the jump-to-latest pill were **not** exercised.
- **The chats list beyond opening a row.** Search, dividers, archive, mouse drag
  reorder, the right-click context menu and arrow-key navigation were not driven.
- **⌘K and the rest of the shortcut table.** Only Escape was tested, closing
  Settings one level.
- **Crons and Activity**, beyond the fact that the tabs open.
- **Safari.** It is installed; Firefox is not. Neither was driven, so no
  cross-browser difference in this list has been observed rather than reasoned
  about — which matters most for `backdrop-filter`, where the glass lives.
- **The service worker.** Registering `/hermie-push-sw.js` failed in the browser
  this pass was driven from, with Chromium's generic "An unknown error occurred
  when fetching the script." The file is served with `text/javascript` and
  `127.0.0.1` is a secure context, so the likely cause is the automation
  environment rather than the app — but it was not reproduced in a stock browser,
  so push on the web remains exactly as unverified as it was before.

## Web QA, second pass (2026-09-21, last)

The list the pass above produced, worked through in its own priority order,
with everything re-checked in a real browser afterwards. Twenty commits. What
follows is what is now true, what this pass found that the first one had not,
and — still the part that matters most — what it did not get to.

### The method note that earned its place this time

**Programmatic scrolling is not scrolling.** Setting `scrollTop` on the
transcript's scroller fires a scroll event, moves the list and measures
perfectly well — and it does not make `onEndReached` fire, so the list never
pages in older history. Two hours went into "the browser build cannot reach the
start of a long transcript" before a real wheel event over the same list grew
it from 240 rows to 818. Every claim about paging below comes from wheel input;
`scrollTop` is used only where the question is how long a frame took.

The same care settled the service worker. Registering a path that 404s, an
`image/x-icon` and the real worker all failed with Chromium's identical
"An unknown error occurred when fetching the script.", where a browser with
service workers switched on distinguishes all three. So the refusal is the
automation environment's, as the first pass suspected — now with evidence
rather than reasoning, and Web Push is still unverified.

### Fixed

In the order the previous section listed them.

| What                                                                       | Commit               |
| -------------------------------------------------------------------------- | -------------------- |
| A markdown link was a `div` with a press handler; now an `<a href>`        | `e5fd553`            |
| Decorative marks stayed in the accessibility tree — 14 on one transcript   | `2d78caa`            |
| `accessibilityState` never reached the browser at all: 32 call sites       | `9d8b50d`            |
| `TextField` could emit `aria-label=""`, which REMOVES a name               | `c794035`            |
| Focus rings stopped at text fields; every button, row and tab had the UA's | `af595ad`            |
| Day separators were the page's only `<h1>`                                 | `a7b5b36`            |
| Settings and the wizard called Hermie Web's own origin "the gateway"       | `83c26cc`            |
| The welcome copy showed its backticks                                      | `da936a1`            |
| The sign-in error was not announced                                        | `62df06b`            |
| No maskable PWA icon                                                       | `d92fc8c`            |
| Two untranslatable literals (`"Dismiss"`, `"Replying"`)                    | `242f4bc`            |
| Console noise: `useNativeDriver`, and a service worker retried every time  | `9b9528f`, `2e6c17a` |
| `design/tokens.md` gave an app background that is in no source file        | `c0aecb6`            |

Each commit message carries its own reasoning. Four are worth repeating here,
because they turned out to be bigger than the line above them.

- **`accessibilityState` is dropped on the floor by react-native-web.** The
  defect list said "decorative icons stay in the tree"; fixing that exposed
  the larger one underneath. RNW's prop table takes `aria-expanded`,
  `aria-selected`, `aria-checked`, `aria-disabled` and `aria-busy`, and an
  `accessibilityState` object reaches nothing. Thirty-two call sites authored
  the spelling the browser cannot hear, so every tab in the strip, every
  disclosure in a transcript — tool cards, thoughts, folds, DM rollups, cron
  cards — every switch in a sheet and every busy button shipped with no state
  on them. React Native accepts the aria spelling and normalises it back into
  `accessibilityState` on the host node, so the phones are unchanged;
  `accessibility-state.test.tsx` pins both halves, and pins the absence of the
  old spelling by reading the source.
- **The focus ring is one CSS rule, because nothing in React can reach
  `:focus-visible`.** It takes its colour from `--hermie-focus`, declared for
  both schemes in the document template and corrected from the live theme by
  `status-bar.web.tsx` — the same path the page background already used, so a
  pinned preset rings in its own accent. `:focus-visible` and not `:focus`: a
  ring on every mouse click is noise on a chat list, while a field somebody
  just clicked into is one they are about to type in.
- **A heading with no level is an `<h1>`.** The fix is not "make the date
  stamp an `<h2>`" but "give the page something to be second to": each
  screen's own title is now the first level, a grouped section's quiet label
  the second, and a day stamp a section of the transcript. The document also
  resets user-agent heading styles, because RNW's reset covers `Text` and not
  the `View` a heading can also be — a date stamp's box was inheriting
  `font-size: 1.5em` from the element it had just become.
- **The maskable icon needed the rasteriser to layer.** A maskable image is
  cropped to whatever silhouette the launcher likes, so the backdrop has to
  reach every edge while the mark stays inside a circle of 80% of the canvas:
  two mappings of one drawing, where `render` composited everything through
  one. A shape may now carry its own transform. The safe box is measured, not
  assumed — fitted to 1000 the mark's furthest point is the tail's TIP at
  607.5 from the centre, not a corner, so 674 is the largest box that fits
  inside 409.6 and 664 is that with six points to spare.

### Found by driving it, and fixed

Everything here is new. None of it is a browser-only bug except where it says
so; the browser is where it was noticed.

- **Sign out did not sign out.** `clearCredentials()` empties the secret
  store, which on the phones IS the credential — and in a browser holds
  nothing, because the session is the gateway's own `HttpOnly` cookie. So the
  app returned to the wizard, the session stayed alive on the gateway, and the
  next reload signed straight back in as the person who had just left. Found by
  signing out during this pass and reloading. `CookieSessionCredentials` has
  always known how to `POST /auth/logout`; nothing called it. `b9983e7`
- **The password form was unreachable after a sign-out.** `draftFromConfig`
  synthesises a probe from the stored gateway so the wizard can resume on the
  sign-in step, and a preference file cannot know whether the provider takes a
  password — the entry it writes says `false`. The step started in `ready`
  whenever the draft carried a probe and then believed it, so every resume
  offered the redirect and nothing else. The in-app form, the one the previous
  pass had just taught to submit on Return and to be filled by a password
  manager, was unreachable for exactly the visitor who had used it. `62df06b`
- **An ungated gateway was told it was too old.** `authModeOf` answers
  `session_token` for a gateway that is not gated at all, and the blocked
  notice tested "anything that is not cookie". The screen said "not gated by an
  identity provider" and "it requires a sign-in but does not advertise the
  cookie flow" one under the other. `e91044c`
- **…and then offered a Continue that could never be pressed.** A
  session-token gateway is a genuine dead end in a tab — this build keeps no
  bearer token at all, for the reasons `platform/secret-store.web.ts` sets out
  — and the step rendered nothing at all rather than saying so. `a899dd0`
- **A right click on a chat row did nothing.** The row menu (open, mark as
  read, colour, move, add a divider, archive) was reachable by one gesture: a
  long press, which is right on a phone and is not a thing anybody does with a
  mouse. React Native has no secondary-click event, which is why the Mac
  answers this with a native view; the browser has the event. `0b2c7c0`
- **The `+` labelled New cron did not make a cron.** It navigated to the
  crons screen and left the reader to find the same `+` again at the bottom of
  the list. Not a browser defect — the same header, and the same behaviour, on
  every platform. `79815e2`
- **A refused service worker was retried by every caller.** `ensureWorker`
  left `registration` at `null` after a failure, which is indistinguishable
  from "not tried yet". Eighteen console errors on one transcript. `2e6c17a`

### Measured, on a transcript long enough to mean something

`--history-rows <n>` (`ba44b5a`) writes the history a real gateway would
already have had in front of the fixture, so 400 rows no longer means 200
round trips through the live socket. The rows are mixed — a short question, a
paragraph that wraps several times, a fenced code block, a tool call — because
four hundred identical one-line bubbles measure a list of identical one-line
bubbles.

Driven on the Writer chat with ~390 rows, deliberately under
`REST_HISTORY_THRESHOLD` so the whole conversation loads in one request and
paging is not part of what is being timed. 41,474 px of content in an 842 px
viewport, flung end to end and back twice at 240 px per frame — a fling, not a
walk: the list gets no spare frame to catch up in. `requestAnimationFrame`
deltas, `PerformanceObserver` on `longtask`, CPU throttling through the
DevTools protocol and verified against a busy loop (18 ms against 5 ms, so the
4× is real).

| Run             | p50     | p95     | p99      | max      | frames > 16.7 ms | long tasks |
| --------------- | ------- | ------- | -------- | -------- | ---------------- | ---------- |
| Unthrottled     | 8.3 ms  | 10.9 ms | 12.9 ms  | 19.1 ms  | 2 of 339         | 0          |
| 4× CPU throttle | 10.6 ms | 41.0 ms | 138.5 ms | 237.9 ms | **157 of 341**   | 8          |

**This is the first jank this project has recorded.** Unthrottled the list is
what the previous pass found on a short one: a p50 at the display's own 120 Hz
cadence and two dropped frames in a thousand. At 4× — a mid-range laptop, or a
phone — it drops 46% of its frames and the worst is a quarter of a second. No
long task fired until the very end of that run, which is the shape of the
problem: the work is spread across frames rather than concentrated in one, so
it is the list's per-frame measuring and mounting rather than a single
expensive operation.

A second measurement, for scale: the Researcher chat paged to 25,580 px
unthrottled gave p95 12.0 ms, p99 15.2 ms, max 17.1 ms and 1 dropped frame of 189. The cliff is the throttle, not the length.

Paging itself works and is worth stating, because it was half-suspected of
being broken: wheel-scrolling to the far end walked the list from 240 rows to
818 a page at a time, and the oldest fixture row was reachable.

### Safari

Loaded from `open -a Safari http://127.0.0.1:9120`, captured window-only. It
renders the app: the dark scheme off the system, the glass card with its
radius and tint, the `hermes serve` chip in the right face, the primary button
in the theme's accent. Nothing visibly differs from Chromium at the same
width.

Beyond that this is honest rather than complete:

- **The page could not be driven.** `do JavaScript` needs "Allow JavaScript
  from Apple Events" in Safari's Developer settings, which is a security
  setting this pass would not change; `source of front document` returns the
  template, not the rendered DOM.
- **Signing in was not attempted**, so the transcript, the sheets and
  `backdrop-filter` over real content were not seen in Safari. A card over a
  flat background cannot show whether a blur is being applied.
- **The focus ring was not reached.** Plain Tab moves between form fields only
  in Safari's default configuration, and neither Tab nor Option+Tab drew a ring
  on the wizard's button through UI scripting. That is Safari's "Press Tab to
  highlight each item" being off by default rather than a finding about the
  rule — but it is a real thing about who can reach the app's controls in
  Safari, and it is unresolved.

### Still not covered

Shorter than last time, and still not short.

- **Most of the conversation surface, again.** Tool cards, thoughts,
  bot-to-bot lines, cron cards, the approval and clarify sheets (backdrop
  click, Escape, mouse drag), the queued strip with Steer/Edit/Delete, the
  slash popover, the attach menu, attachments by picker, drag-and-drop and
  paste, and the jump-to-latest pill were **not** exercised. The reason is
  worth writing down so the next pass does not repeat it: the long-transcript
  measurement was set up by injecting 585 turns into the running fixture, which
  buried every one of those shapes under four hundred rows of generated
  history. Do the conversation sweep FIRST, against a clean fixture, and start
  the long one with `--history-rows` on a server of its own.
- **The chats list beyond search and the context menu.** Search filters
  correctly and Escape closes the menu; mouse drag reorder, arrow-key
  navigation, and actually performing archive and add-divider were not driven.
- **⌘K and the shortcut table.** Escape was exercised twice (the row menu, and
  Settings one level). Nothing else.
- **Crons and Activity in depth.** The crons editor opens from the chats `+`
  and cancels cleanly; nothing past that.
- **Settings sub-pages.** The Gateway group was read closely because its
  address was wrong; the sub-pages were not opened.
- **390 px and 820 px.** Everything above is 1280. The narrow layouts were not
  re-walked after any of these changes.
- **The light scheme.** Every screenshot in this pass is dark.
- **Web Push**, exactly as unverified as it was, and now for a reason that has
  been demonstrated rather than guessed.

### One thing left deliberately

The browser tab keeps the last screen's title while signed out: signing out of
Settings leaves "Settings · Hermie" on a page showing the wizard, and a fresh
visit shows "Hermie". `page-title.web.ts` follows the route, and the wizard is
not a route. Small, real, and not touched this round.

## Web QA, third pass (2026-09-21, last)

The conversation sweep the two passes above kept deferring, done FIRST and on a
clean fixture as the second pass asked — and then the 4× jank it measured, on a
server of its own started with `--history-rows 390`. Five commits.

What follows is what was driven, what was fixed, what was found and left, and
the part that matters most: how much of the sweep this pass did NOT reach.

### The method note

**The control surface had a hole in it, and it was the reason for a whole
column of "not covered".** Two of the three question shapes a client has to
survive could be raised by typing a sentence into a chat — "approve" parks the
turn on an approval, "delegate" fans out — and `clarify` could only be raised by
a test holding the gateway object. So the clarify sheet was the one question
card no manual pass had ever opened, which is exactly what both passes above
report. `POST /__fake/request {profile, method, params}` raises any
server→client request from outside the process, and the sheet opened first try.

The second note is about the browser and not the app: **Puppeteer's drag is two
`mousemove` samples**, and `PanResponder` builds its gesture from a stream of
them. A real-input drag from the sheet's grip therefore proves nothing, and
synthetic events only reach the responder system when they are dispatched on a
node whose `composedPath` contains the view carrying `panHandlers` —
react-native-web's `ResponderSystem` reads the path off the event, so a
`mousemove` dispatched at `document` or at whatever is under the pointer never
gets there. Twenty moves dispatched on the sheet's own panel do, and the sheet
dismissed on release.

And one measurement mistake worth recording because it cost two runs: **a blank
row detector inside the timing loop is a layout thrash**. Calling
`getBoundingClientRect` on every mounted row once per frame added long tasks
that were not there, and made an improved list look worse than the one it
replaced. Blankness is now checked at rest, between runs.

### Fixed

| What                                                                      | Commit    |
| ------------------------------------------------------------------------- | --------- |
| Show thinking wrote the setting and did nothing to the conversation       | `5722ac4` |
| An answered card swallowed the next question that reused its transport id | `b41029a` |
| Every keyboard shortcut was dead in a tab — ⌘K, ⌘1…9, and the slash list  | `a3000c8` |
| Every mounted row was rebuilt on every scrolled frame                     | `b1e4b66` |
| `clarify` could not be raised from outside the gateway process            | `98b38b7` |

Three are worth repeating, because each turned out to be bigger than the line.

- **`version` is the reducer's counter, and one read-time copy lies about it.**
  Verbosity works because it hands the row a different `presentation`, which the
  row's memo key compares. Show thinking is answered by handing the row a COPY
  of the same item with `reasoning` stripped — same id, same version, same
  presentation — so the memo declared the two identical and the transcript kept
  drawing thoughts after the switch was off. The same line also rebuilt every
  assistant row on every call, which on a four-hundred-row conversation is four
  hundred allocations per streamed frame for rows that never had a thought.

- **`srq-N` is a per-process counter.** `cache.ts` already carries
  `lastSeqSessionId` because "the gateway restarts event numbering at 1 for
  every runtime session"; server-request ids have the same property and never
  got the same protection. An answered "Allowed once" restored from the cache
  sits on `srq-1`, the first question of the new session arrives as `srq-1`, and
  `applyServerRequest` dropped it — no card, no sheet, a turn parked forever on
  an answer nobody was asked for. Reproduced by accident (a clarify raised
  against a restarted fake gateway showed the previous session's approval) and
  then on purpose. The queue id already had the right rule written beside it in
  `openApprovalIdOf`; the transport id now has it too.

- **The whole shortcut table was dead on the web, and Escape hid it.**
  `subscribeToShortcuts` had one source, the `HermieMac` native module, and
  `requireOptionalNativeModule` returns null in a tab — so it subscribed to
  nothing and returned an unsubscribe for it. ⌘K, ⌘,, ⇧⌘S, ⌘↑/⌘↓, ⌃Tab, ⌘1…9 and
  the composer's own bare ↑, ↓ and Tab all come down that road. Escape kept
  working the whole time because it arrives through `keyboard-modifiers.web.ts`,
  a different seam, which is why nothing ever looked broken. The seam is split
  the way `keyboard-modifiers` already is, and `deliver` now reports whether a
  screen took the action so the browser prevents the default only then — a bare
  Tab still moves focus while no suggestion list is open.

### Verified, at 1280 in the dark scheme

Driven in Chromium against the clean fixture. Each of these was watched in the
DOM rather than in an image, per the first pass's rule.

- **Tool cards** expand and collapse: `aria-expanded` flips, the body mounts and
  unmounts, the card goes 76px → 225px → 76px.
- **Thoughts** appear and disappear the moment the switch moves, both ways.
- **Verbosity** — Quiet hides tool cards entirely, Normal collapses them. Quiet
  was the stored default on this machine, which is why the first look at the
  conversation had no tool cards in it at all.
- **Cron cards** and the **bot-to-bot line** render and carry their disclosures
  (`cron-delivery-*-toggle`, the `Message to @writer` line with its reply
  preview).
- **The approval sheet** — raised by a prompt containing "approve", four
  choices, Escape closes it and leaves the question in the transcript as a row
  with an Answer button, and answering it turns the row into
  "Allowed once · rm -rf ./build".
- **The clarify sheet** — raised through the new control endpoint: the question,
  three choices, a free-text field, Submit, Lock answer and Later.
- **Backdrop click** dismisses, and the geometry behind that fix is real: at
  1280 the panel is capped and centred over the content column, and
  `elementFromPoint` beside it returns the scrim, not the column.
- **Mouse drag** on the grip dismisses on release (see the method note for what
  that does and does not prove).
- **The attach menu** opens above the composer inside the content column, 16px
  radius, a float shadow and no tail, and Escape closes it one level.
- **The slash popover** — `/` opens it, ↑ and ↓ move the highlight, Tab takes
  the highlighted entry into the field without moving focus, Escape closes it,
  and the argument-taking `/reasoning` keeps the list open afterwards.
- **⌘K** puts the caret in the chat search, **⇧⌘S** collapses and restores the
  sidebar, **⌘2** opens the second chat — and ⇧⌘S while the caret is in the
  search field does nothing, which is `shortcutIsDeliverable`'s typing gate
  working rather than a bug.
- **Paging** on the long fixture: wheel-scrolling to the far end grew the list
  from 8,932px to 47,000px, and no offset in a fling leaves the middle of the
  viewport undrawn.

### Measured, before and after

Same fixture and same harness as the second pass: the Writer chat with
`--history-rows 390`, ~47,000px of content in a 793px viewport, flung end to end
and back twice at 240px per frame, `requestAnimationFrame` deltas and a
`longtask` observer, CPU throttled through the DevTools protocol and verified
against a busy loop.

| Run                 | p50     | p95     | p99     | max     | frames > 16.7 ms | long tasks |
| ------------------- | ------- | ------- | ------- | ------- | ---------------- | ---------- |
| Unthrottled, before | 8.3 ms  | 10.3 ms | 12.8 ms | 35.8 ms | 2 of 775         | 0          |
| 4×, before          | 12.0 ms | 35.5 ms | 39.6 ms | 97.5 ms | **344 of 775**   | 1          |
| Unthrottled, after  | 8.3 ms  | 9.9 ms  | 11.9 ms | 17.3 ms | 3 of 775         | 0          |
| 4×, after           | 10.7 ms | 24.4 ms | 44.0 ms | 240 ms  | **145 of 775**   | 3          |

Dropped frames at 4× go from 44% to 19% and p95 by a third. **It does not reach
the p95 of 20ms that was asked for, and the long-task count is not better.**

Where the time went, and where it still goes:

- **The memo that was not reached.** `TranscriptRow` has been memoized since it
  was written; `VirtualizedList` never gets that far. The list re-renders on its
  own state every time the render window moves, `CellRenderer` has no
  `shouldComponentUpdate`, so `renderItem` runs again and the FRAME around the
  memoized row — its hooks, a `ContextMenuHost`, two wrapper views — ran for
  sixty-odd rows every frame. Identical output either way, which is why it
  survived. That is most of the p95 improvement.
- **The window was never stated.** `windowSize` defaults to 21 — twenty-one
  VIEWPORTS — and `maxToRenderPerBatch` to 10, which is ten Markdown bubbles
  mounted inside one frame. Eleven and four.
- **Markdown was not the cost.** `markdown/blocks.ts` already holds an
  exact-string cache and a streaming-append cache, so a row re-mounted by a
  fling is not re-lexed. Deferring off-screen markdown, which the brief
  suggested, would buy nothing here and would change row heights on an inverted
  list, which moves the reader.
- **A forced reflow of 125ms per run, from `get y`.** That is
  react-native-web's own scroll event: `normalizeScrollEvent` builds
  `contentOffset`, `contentSize` and `layoutMeasurement` as GETTERS over
  `scrollTop`, `scrollHeight` and `offsetHeight`, so every reader of the event —
  ours and `VirtualizedList`'s own — flushes layout of the whole scroller right
  after React invalidated it. Real, and second-order next to the mounting.
- **What is left is the mounting itself.** A fling at 240px per frame mounts a
  viewport of rows every ~55ms whatever the window is, and four Markdown bubbles
  in one frame is ~6ms of real work, which is 24ms at 4×. Getting under 20
  means making a row cheaper to mount rather than mounting fewer of them.
- **`removeClippedSubviews` is a no-op here.** react-native-web's `View` has no
  such prop. The web's own answer is `content-visibility: auto` with
  `contain-intrinsic-size`, and a wrong intrinsic size on an INVERTED list moves
  the reader — so it wants its own round with the scroll trace on, not a line in
  this one.

### Found, not fixed

- **A cached answered request row is history the gateway does not have.**
  `cache.ts` keeps answered approvals and clarifies, deliberately — an "Allowed
  once" is a record. But it is restored with no session identity, so the only
  thing keeping it distinguishable from a new question is the collision fix
  above. Giving a cached request the same `lastSeqSessionId` treatment the
  event watermark has would make the id question moot.
- **Signed out, the app calls its own origin the gateway.** "Your session on
  127.0.0.1:9120 has expired" on the signed-out notice, which is Hermie Web's
  address and not the gateway's — the same defect the second pass fixed in
  Settings and in the wizard, in a third place.
- **The fixture's `/login` page cannot sign anybody in**, and the app's
  signed-out "Sign in" button navigates to it. It is a stub that exists to prove
  the proxy carries HTML, so the form has no action and submits to itself as a
  GET with the password in the query string. Harmless for a fixture credential
  and not the app's defect — but it means the one route the signed-out screen
  offers is a dead end in development, and a pass that did not know to POST
  `/auth/password-login` by hand would read that as the app being broken.
- **`initialNumToRender` and the first screen.** Raised to 14 here by
  measurement, not by design: nobody has ever looked at what the first frame of
  a chat actually draws on a phone.

### Not covered

Shorter than the last two lists in some places and longer in others, because
this pass spent its room on the two items above.

- **820px and 390px, and the light scheme.** Everything in this pass is 1280 in
  the dark scheme, exactly as the second pass was. The narrow layouts have now
  not been walked for three passes.
- **Attachments, entirely.** The file input, drag-and-drop onto the page and
  pasting an image were not driven, and neither were the composer's pending
  thumbnails. The attach MENU was; what it opens was not.
- **The queued strip, Steer/Edit/Delete**, and the jump-to-latest pill.
- **Mouse drag reorder of chat rows** — the lifted row, the neighbours shifting,
  the drop between — and arrow-key navigation in the chat list. The keyboard
  seam that would carry the second of those exists now; nothing was driven
  through it.
- **Settings sub-pages and Esc one level**, and **Crons and Activity in depth**.
  Untouched for three passes.
- **Whether the sheet's panel follows a mouse drag.** The release dismisses;
  whether the panel tracks the pointer on the way could not be measured, because
  a synchronous dispatch loop reads the transform before `Animated` has
  committed a frame.
- **Web Push**, still, and for the reason the second pass demonstrated.

## Three reports from Hermie Web 0.1.1 (2026-09-21, last)

One screenshot carried two of them: a `stat` run the owner had pasted, drawn
struck through, and the same paste standing in the chat twice after a refresh.
The third was the one the QA passes above kept deferring — `Show more` moving
the page.

### A single tilde is not a deletion, whatever GFM says

GFM opens strikethrough on ONE `~` pair, and `marked` implements exactly that.
In prose it is nearly always right; in a chat with an agent it is nearly always
wrong, because the text people paste is shell. Two prompts:

```text
root@hermes:~# stat -c '%u:%g %n' /usr/bin/sudo
0:0 /usr/bin/sudo
root@hermes:~#
```

is one `del` token from the first `~` to the last, so the reader loses both
tildes AND sees the output crossed out as though the agent had retracted it.
`~/dir` in a sentence pairs with the next `~` just as happily.

The rewrite is in `marked-compat.ts`, beside the `blockSkip` one, and it is one
character: marked spells the optional second tilde `~~?` and it appears in
exactly three inline rules — `del`, `delLDelim`, `delRDelim` — and nowhere else
in the rule set. The tokenizer counts the tildes it found on the left and
demands the same count on the right, so rewriting every copy to a fixed pair
says one thing: two open, two close, a lone `~` is a character. `~~gone~~` is
untouched, `~~cd ~/old~~` still strikes across the tilde inside it, and because
the change is in the lexer it holds for the owner's own bubble as much as for a
reply — which is where this one landed.

`plain-text.ts`, the notification-preview stripper, already required `~{2}`. It
has been right about this the whole time.

### An interim message means a reply is no longer proof the turn ended

The resume rule written under "The reported bubble was a resume projection
landing beside its own row" above reads a durable assistant row after the
matching prompt as proof that turn is finished — so the `inflight` describing
the same prompt must be a NEW turn, and gets its own bubble. That is true of a
turn that answers once.

A session with interim assistant messages on does not answer once.
`_interim_assistant_cb` seals a mid-turn note, the gateway persists it as its own
assistant row, and the turn goes on working. Refresh at that moment and the tail
reads prompt, reply — a finished turn by the old rule — so the still-running
turn's `inflight.user` was projected again below the note. The report: the same
paste at 20:54 and again minutes later, with one row for it in the gateway's
database.

What separates the two shapes is a number the gateway already sends and nothing
read: `turn_started_at`, on `SessionLiveInfo` beside `running`, and on
`session.resume`'s result. A reply stamped at or after the running turn began was
written BY that turn and says nothing about the turn being over; a reply stamped
before it belongs to the turn that ended. Both are Unix seconds off the same
clock as the row's own `timestamp`, so the comparison needs no tolerance and no
local clock. `resumeSnapshotOf` now forwards it — from the top level or out of
`info`, whichever the gateway answered — and `applyResumeSnapshot` falls back to
`state.info`, which the cold-open path has already dispatched a step earlier.

**When no start is reported the old rule stands unchanged**, deliberately.
Without a start there is nothing to place the reply against, and guessing "still
the same turn" swallows a case `duplicate-cron-turns.test.ts` pins down: an
hourly job whose body has not changed, delivered again after the previous run
was answered, is a second card and not a re-description of the first.

The contract question under "Worth filing upstream" above is unchanged and is
still the real fix. `inflight.row_id` would make this whole family impossible to
hit; `turn_started_at` only makes one more member of it decidable.

### `Show more` on the web needs LESS anchoring, not more

`maintainVisibleContentPosition` is not implemented in react-native-web at all,
which makes the obvious guess that the web build needs more help holding the
reader's place than the native one. It needs none, and the hold written for iOS
is the entire displacement.

An inverted list on the web is `transform: scaleY(-1)` on the scroller plus the
same flip on every cell (`VirtualizedList`'s `verticallyInverted` and
`VirtualizedListCellRenderer`'s `cellStyle`), and a browser preserves
`scrollTop` across a content change. Under that flip a preserved `scrollTop`
pins every DOM offset that did not move — which is the whole conversation below
the growth, `Show more` included, because a cell lays its body out at larger DOM
offsets than its own footer.

Measured on that exact DOM rather than in the app: a 400pt scroller, twelve
flipped cells, one body grown by 300, at three starting offsets and on the way
back.

| start | growth | `Show more` moves | with `holdTarget` applied |
| ----- | ------ | ----------------- | ------------------------- |
| 200   | +300   | 0                 | +300                      |
| 0     | +300   | 0                 | +300                      |
| 600   | +300   | 0                 | +300                      |
| 500   | −300   | 0                 | −300                      |

The newer rows below it move by the same numbers. So the reader loses their
place by exactly the amount the fold grew, every time, which is the report.

The seam is `platform/scroll-anchor.ts` / `.web.ts` — `ANCHORS_GROWTH_ITSELF`,
false on every native platform and true in a browser — and `holdPlace` refuses at
the tap rather than at either correction site, so nothing downstream has a target
to aim at. Doing nothing is also what Reduce Motion asks of this path: there is
no movement left to shorten.

### What is still unverified

- **The web fix has not been seen in the app.** The browser build refuses a
  token gateway by design ("This gateway cannot be used from a browser"), so
  `npm run web`'s cookie mode is the only way in and that means typing the
  fixture password. What WAS checked is that the seam resolves: the exported
  bundle carries this module as `const t = !0`. The tap itself is covered by
  jest with the flag mocked on.
- **The interim resume fix has not been seen against a real gateway.** The fake
  gateway models no `inflight` at all, so every case here is the reducer's own
  suite. Whether a real `session.resume` fills `turn_started_at` on the top
  level, only inside `info`, or not at all decides whether the fix fires — and
  if it is absent the old behaviour is what happens, not something worse.

## A slash command's answer, and the command that answered for nothing (2026-09-21, last)

Two reports from the running app, both about a slash command and neither about
the same thing. One command lied about what it had done; every command's answer
was invisible at the level the app ships on.

### A command's answer was dropped at `quiet`, and folded everywhere else

`slashOutput` emitted a plain `notice`, and `selectors.ts` drops every non-error
notice at `quiet` — which is the default (`store/settings.ts`), and the setting
nobody changes. At `normal` and `verbose` what it drew was a folded `LedgerRow`:
a chevron, a title, and the answer behind a tap the reader had no reason to
expect. Both halves of the owner's sentence, in one cause: "command response
altijd zichtbaar; nu alleen zichtbaar als thinking aan staat; standaard
uitgeklapt."

The fix is a `NoticeKind` of its own, `command`, which is `full` at every level
and opens itself. The reasoning is in the amendment to
[ADR-0013](adr/0013-cron-deliveries-in-the-transcript.md); three mechanical notes
belong here.

**The kind is this client's, not the gateway's.** The reducer accepts
`noticeKind` off a `notice` event for the single value `command` and maps
everything else — including kinds it knows — onto a plain `notice`. The privilege
behind the kind is "the owner typed the thing this answers", and only the surface
that watched them type it can assert that. A gateway that started sending the
field could otherwise promote its own narration into the one family `quiet`
cannot drop.

**Open-by-default lives in the expanded PROVIDER, not in the row.** A row that
opened itself by branching on its own props would re-open every time
virtualisation scrolled it back into the window, so a reader who closed a
five-kilobyte `/help` would find it open again a moment later — the exact bug
`expanded.tsx` was written to prevent, arriving from the other direction. The
provider went from a set of open ids to a map of explicit CHOICES: an absent key
means untouched, so the row's own default applies, and a present key is what the
reader last did.

**One shape, whatever the length.** Title is the command as typed, body is the
whole answer, always. It used to depend on the length — one line went into the
title with an empty body, which `NoticePill` then drew with no disclosure at all,
while a longer one was titled `/help — 214 lines`. Two shapes meant a reader had
to work out which one they had before they could read it, and the short one could
not be folded away at all.

#### What is unverified here

- **It has not been seen in the app.** There is no signed-in gateway available
  from here. What exists is the selector's own suite, a jest test that drives the
  row through the unmount virtualisation causes, and a controller test that the
  kind is on the event. What a `quiet` transcript with a two-hundred-line `/help`
  open in it actually looks like on a phone has not been looked at.

### `/new` printed "New session started!" and started nothing

`slash.exec` does not run in the session you are looking at. Upstream spawns a
SEPARATE CLI process per session for worker commands
(`tui_gateway/methods_tools.py::_SlashWorker`), and `/new` inside that process
(`hermes_cli/cli_session_mixin.py`) rotates the WORKER's session and prints the
line. Nothing is mirrored back except the commands named in `_SLASH_MIRRORS`
(`tui_gateway/methods_slash.py`: model, approvals, personality, prompt, …), and
`new` is not among them. So the reader was told a session had started, the next
message went to the same session with the same system prompt, and the bot itself
confirmed as much when the owner asked it.

Upstream's desktop app intercepts `/new` client-side for exactly this reason
(`apps/desktop/src/lib/desktop-slash-commands.ts`, handler
`prepareDefaultNewSession(); startFreshSessionDraft()`). Hermie has to intercept
it too, but it cannot do what the desktop does — open another session — because a
bot here has exactly ONE chat and that chat is identified by its title
(ADR-0007). "Start fresh" therefore means: retire the conversation holding the
title `Bot Chat`, then mint its successor under it.

**Two facts in the state layer decide the whole shape of that, and neither is
visible from the RPC surface.**

The first is that a canonical chat **cannot be renamed while it is hidden**.
`hermes_state_titles.py::_set_session_title` refuses it outright:

> This is the bot's canonical Bot Chat — its name is its identity, and renaming
> it would orphan the conversation.

The straightforward reading of "retire it by renaming it" therefore fails on
every real gateway with a 4022. What makes it work is the sentence upstream wrote
beside the check — _"Hidden is the discriminator: canonical chats are born
hidden; a visible session merely named 'Bot Chat' stays renameable"_ — so
`session.set_hidden {hidden: false}` comes first. The retired conversation
becoming an ordinary visible session is also where a reader would go looking for
it.

The second is that **`session.title` is session-scoped**: `_with_db(…,
session_scoped=True)` over `_sess_nowait`, which is a plain lookup in the live
`_sessions` map. The durable id — the one everything else in this app is keyed
by, and the one that resolves for `session.list`, `session.resume` and every REST
route — comes back `4001 session not found`. It takes the RUNTIME id, and what it
renames is that session's `session_key`.

Two smaller things came out of the same file:

- **`session.create` persists no row for an empty draft.** The title rides as
  `pending_title` until the first prompt, so a successor nobody has typed into
  yet is invisible to `session.list` and to `profiles.list`'s canonical lookup. A
  `session.title` call straight after the create takes the other road —
  `_ensure_session_db_row`, which applies the queued `hidden` on the way — so the
  new chat is a real, findable, hidden `Bot Chat` before the first message.
  Without it, a relaunch in that window would resolve no canonical row and mint a
  THIRD chat.
- **The roster is the thing that would undo the switch.** `profiles.list`
  re-resolves each bot's chat by title on every call
  (`methods_profiles.py::_canonical_session_row` → `get_session_by_title`), and
  `setBots` overwrites every bot wholesale. A poll that left before the rename —
  or one that arrives during the window above and reports no canonical chat at
  all — would put the chat back on the conversation the owner just put away. So a
  switch PINS the id it switched to, and the pin clears the moment the roster
  names it.

The order is retire, create, title, close, and every step that can fail rolls
back towards "nothing happened": a refused argument falls back to the dated name,
a failed create puts `Bot Chat` back and re-hides. The one outcome worse than
`/new` doing nothing is `/new` leaving a bot with no chat.

`/new`, `/reset` and `/clear` are also answered by `knowsSlashCommand` **before
the catalogue has loaded**, which no other command is. Every other command
degrades harmlessly when the catalogue is late — the line goes out as a prompt
and the gateway understands a leading slash — but a `/new` sent as a prompt is a
request to the MODEL to start a new session, and it will happily report that it
has.

#### What is unverified here

- **None of it has been seen against a real gateway.** There is no signed-in
  gateway available from here, so every claim above about upstream is read from
  the pinned source and every claim about behaviour is the fake gateway and the
  suites. What needs a hand check, on a device against a real gateway: typing
  `/new` and confirming the bot reports a NEW session id and a rebuilt system
  prompt on the next message; that the retired conversation appears in the
  gateway's session list under `Bot Chat · <date time>`; and that `profiles.list`
  then resolves that bot's canonical chat to the successor rather than to nothing.
- **The un-hide has a visible side effect nobody has looked at.** The retired
  conversation leaves `hidden`, so it now appears in every client's session
  browser — Hermes Desktop's sidebar, the TUI's list. That is intended, since it
  is what keeps the conversation findable, but what a sidebar that has never held
  a `Bot Chat · …` row looks like afterwards has not been seen.
- **Whether a real gateway persists the successor's row on the post-create
  `session.title`.** The path through `_ensure_session_db_row` is read from
  source; the fake writes a row on `session.create` regardless, so no test here
  can tell the two apart.
- **`session.close` against a session the gateway has already reaped.** Treated
  as best effort and swallowed, which is a guess about a 4001 rather than a
  measurement.

## The composer, the two names, and a badge that hid itself (2026-09-22)

Five reports, and the thread running through three of them is the same: a fact
the app knew and did not draw.

### An empty slash popover was the app knowing and not saying

`ChatController.querySlash` wrapped both completion calls in a `catch` that
answered `{ items: [] }`, and `Composer` opened the popover on
`suggestions.length > 0`. So a gateway that refused `commands.catalog` or
`complete.slash` produced exactly the same composer as a gateway with no
commands: nothing. The owner typed `/` on his phone against his own gateway and
saw an empty field, while the same build showed the list on the web and on the
simulator — which is what made it read as a platform bug rather than as a
refusal, and sent the search in the wrong direction.

The ring in `gateway/rpc-failures.ts` was written for precisely this family and
its own header says so. It was doing its job; nothing a reader can see was
reading it. `noteRpcFailure` now hands the failure BACK to the caller as well as
into the ring, and `querySlash` carries it beside its items.

**Beside, not instead of, and that is the interesting case.** `complete.slash`
answers out of the live session; `commands.catalog` is what `knowsSlashCommand`
routes on. A catalogue that refused while completions kept working gives a
reader a list that looks perfect and a Return that sends the accepted pick to
the model as prose. That state now says so.

The `Loading…` row exists because "slow" and "silent" were indistinguishable
from the outside, and the only honest way to tell them apart is elapsed time:
`SLASH_SLOW_MS` is 400, long enough that a gateway on the same machine never
draws it.

### The slash popover's arrow keys had nothing to aim at

A `ScrollView` cannot be asked to scroll to a child. The slash list's arrow keys
therefore moved the highlight and nothing else, and a real gateway answers a
bare `/` with thirty-four commands in a 220pt box — so the fourth down-arrow put
the selection below the fold and every press after that changed something
invisible. Rows report their own boxes on layout and the effect does the
arithmetic. Boxes are dropped whenever the candidate list changes, because index
3 of `/mo` and index 3 of `/model` are different rows at different heights.

### A collapsed folder deleted information it was supposed to summarise

`folderCounts` skipped a muted bot before adding either number. Open, that bot's
row showed four unread; closed, the folder showed none — so collapsing a folder
_removed_ a fact rather than aggregating it. The owner's rule splits the two:
unread counts muted chats, the needs-input dot does not. A badge on a list
somebody opened on purpose is not an interruption; a dot that says "a bot is
blocked until you answer" is. `BotRow` had already made this call by drawing the
bell and the unread pill side by side. ADR-0019 stated the old rule and has been
corrected in place with a dated note.

### The handle was in the roster the whole time

`profiles.list` has carried `name` and `display_name` since the roster was
written, and `store/bots.ts` has carried a comment about the difference for just
as long. `ChatHeader` had an `@handle` line — and it drew only when no
`subtitle` existed, while `subtitleFor` answers for every connection state. It
was therefore dead in the app and alive only in the gallery, which is why it
survived so long looking implemented.

Both names are drawn now, and which one leads is one app-wide setting. Three
things about the shape are worth keeping:

- **The rule is a pure function**, because the widget projection needs it and
  runs inside a store subscription with no hooks available to it.
- **One name is one line, in both orders.** `researcher` over `Researcher` is a
  second line that invites the reader to hunt for a difference that is not
  there, and the case-only pair is the commonest shape on a real gateway.
- **Avatar initials and tints follow the primary line.** `initialFor` takes the
  first character and `tintIndex` hashes the whole string, so leaving the avatar
  on the other name would give a hyphenated handle an initial and a colour
  nothing else in the app uses.

The setting is an additive field on an **unbumped** `hermie-app` version. The
reasoning is already in the `folders` field's comment and it is worth repeating
because it inverts the instinct: a reader that meets a `v` it does not know
treats the whole section as unreadable and re-seeds it from its own local copy,
so bumping would not protect this key from an older build — it would hand that
build the power to delete the arrangement.

### The drag column had three tap targets in the space of one

Edit mode drew a 26pt handle containing two 15pt arrow glyphs, each its own
`Pressable`. The column is what the pan responder is attached to, so the one
thing a reader is meant to grab was the hardest of the three to hit. It is a
single six-dot grip now. Stepping one position at a time moved to the row's
`accessibilityActions` — on the ROW, which is the element VoiceOver focuses —
and the context menu's Move up / Move down were already there.

**Folders did not get the grip, deliberately.** `use-row-drag` is keyed by bot
name from end to end — `handleHandlers(botName)`, `liftedKey: bot:<name>`, and a
commit through `dropBot` — so dragging a folder is not implemented at all. A
handle labelled "Hold to drag" that cannot be dragged is a worse affordance than
no handle, so folders gained the reorder actions and the menu items and nothing
that promises a gesture. Generalising the drag hook from bot names to row keys
is the piece of work that would let the grip go there too.

## What could not be verified, and two things that were not built

There is no signed-in gateway reachable from here, so **nothing below has been
seen against a real `hermes serve`**. Every claim about upstream is read from the
pinned clone; every claim about behaviour is the fake gateway and the suites.

- **The slash-failure row has not been seen on a device.** The report it answers
  is specifically the owner's iPhone against his own gateway. What is covered is
  the controller's failure shape on a refusal and on a timeout, and the
  composer's three popover states. What a real 4018 from `commands.catalog`
  actually reads like at phone width has not been looked at.
- **The arrow-key scroll is measured against reported boxes, not a rendered
  list.** The test feeds `onLayout` six 50pt rows in a 220pt window. Whether a
  real row with a wrapping description measures what this assumes is unchecked.
- **The name order has not been seen on a gateway where the two names differ.**
  The fake's fixtures and this repo's tests use generic names.
- **The widget's one line following the setting has not been seen on a home
  screen.** The projection is covered; WidgetKit reloading on a settings change
  is not, and the native renderers were not rebuilt.

### `profiles.configure` cannot set a display name

Item 4 of this round asked for the display name to become editable through
`profiles.configure`, with the fake gateway taught to accept `display_name`.
**That call has no such field, and adding one to the fake would make the suite
green over a feature that cannot work.**

The vendored contract
(`packages/hermes-shared/src/gateway-contract.generated.ts`,
`ProfilesConfigureParams`) lists `profile`, `name`, `ui_meta`,
`ui_meta_expected_revisions`, `soul`, `description`, `model`, `provider`,
`confirm_expensive_model`, `disabled_skills`, `enabled_toolsets` and
`enabled_mcp_servers`. No display name. `name` identifies the profile rather
than renaming it.

Upstream agrees, and the handler is the part that matters:
`tui_gateway/methods_profiles.py`'s `profiles.configure` branches on `ui_meta`,
`soul`, `description`, the model pair and the three config lists, and **ignores
every other key silently**. It does not refuse. `applied` simply would not
mention `display_name`, and `ok` is `all(applied.values())` over whatever else
the request carried — so a save that changed nothing would report success and
the name would revert on the next roster poll. That is worse than a refusal,
because a refusal is visible.

Upstream _can_ set one — `hermes_cli/profiles.py::set_profile_display_name`
writes `display_name` into `profile.yaml` — but it is reachable only through
`hermes profile rename` on the gateway host. There is no RPC and no REST route.

So item 4 was **not built**. The honest ways forward, in the order I would pick
them:

1. **Store an app-side override in the per-bot `hermie` `ui_meta` section**
   (ADR-0016). The app already owns that key, the bridge already syncs it with a
   compare-and-swap, and it works on every gateway. The cost is that the name is
   Hermie's rather than the profile's: the TUI, Hermes Desktop and the bot-mode
   `@handle` resolution would go on seeing the gateway's copy.
2. **Leave it read-only and say where it comes from**, which is what the sheet
   does today and what its header comment already explains at length.

Option 1 is a product decision about whose name it is, not a mechanical gap, so
it should be the owner's call rather than a build agent's. The profile sheet's
About group now at least shows the handle and the display name as two separate
rows, so the thing that cannot be edited is labelled correctly while it waits.

### Chat text size was not built

Item 6 asked for a Small / Default / Large / Extra large control scaling the
bubble and markdown type scale. The plumbing it needs — a persisted app-wide
setting in the `hermie-app` slice, read defensively, surfaced in Settings →
Appearance — is exactly the plumbing the name order just laid down, so it is
cheap to add on top.

What stopped it this round is ownership: the type scale it has to move is read
by the markdown renderer, and `src/markdown` belongs to another agent's worktree
in this round. Landing a change that reaches into those files would collide on
merge. The store field, the `ui_meta` field and the Appearance row are the same
shape as `botNameOrder`; the only new decision is whether the scale multiplies
the `type` tokens in the theme — which markdown would inherit for free, and
which needs no edits under `src/markdown` at all — or is threaded through the
bubble components one at a time. The theme is almost certainly the right seam.

## Rich content in a reply (2026-09-22)

### A renderer that learns its own size late is a renderer that moves the reader

The obvious way to draw a ` ```mermaid ` fence is the `mermaid` package, and the obvious way
to set `$$…$$` is KaTeX. Both were rejected for one reason, and it is the same reason in both cases.

`mermaid` measures text with `getBBox`, so on iOS and Android it needs a `WebView`; KaTeX positions
every glyph from a metrics table that assumes four bundled fonts, which load asynchronously. Either
way the final size of the box arrives **after** the row has already been laid out. The table under
"`Show more` on the web needs LESS anchoring" above is the measurement of what that costs on this
list: a body grown by 300 displaces everything below it by 300, at every starting offset, every
time. A diagram that settles two frames after it mounts does exactly that, with nobody having
touched anything — and unlike `Show more` there is no tap to hang a correction off.

So the geometry is arithmetic instead. A node's box comes from its label's character count and the
font size, the same estimate `CodeBlock.tsx` already uses for a listing's natural width; a
fraction's height is two leadings and a rule. Nothing measures, nothing loads, and the row is its
final height on the first frame. `react-native-svg` was already in the bundle for the icons and the
bubble tails, so this added no dependency at all.

The security question that usually comes with Mermaid disappears with the library: there is no
script engine and no navigation here, so `securityLevel: 'strict'` has no equivalent because it has
no equivalent problem. A label is characters in a `Text`.

### What is not covered

- **The subset is genuinely a subset**, and the fallback is what makes that acceptable rather than
  what hides it. `sequenceDiagram`, `classDiagram`, `gantt`, and a `subgraph` inside a flowchart all
  answer `null` from the parser and land in a code block. So does `\begin{…}`, and so does any LaTeX
  command not in `math/symbols.ts`.
- **Inline mathematics is one line, and cannot be otherwise.** React Native will not lay a `View`
  out inside a `Text` on Android, so `$\frac{a}{b}$` is `a/b` with brackets wherever the extent would
  be ambiguous. Only `$$…$$` gets boxes.
- **None of it has been seen on a device.** Every claim above is jest against the real renderer and
  the real lexer; the layout constants — a rhombus at 1.35× its box, a 46pt gap between ranks — were
  chosen from the same character-advance estimate the tables use and have not been photographed on a
  phone. What that can be wrong about is spacing, not stability: the numbers are wrong in the same
  direction on every frame.

### The context ring has no table of model context sizes behind it

The brief for this round said `CONTEXT_LIMITS` in `@hermie/gateway-client/context` "already knows
model context sizes". It does not: that constant is the per-field character caps for the `ui_meta`
context section the gateway plugin renders into a system prompt — `displayName: 80`, `about: 600` —
and it has nothing to do with a model's window. Nothing else in the tree knows a window size either.

That turned out to be the right shape rather than a gap to fill. The only two numbers a ring can
honestly be drawn from are `usage.context_used` and `usage.context_max`, both of which the gateway
already sends, and **without the second there is no ring**. A local table keyed off `usage.model`
would be a promise about somebody else's product: it is right until a provider ships a longer window
or a gateway reserves part of one, and when it is wrong it is wrong in the direction that tells a
reader they have room they do not have. `contextUsageOf` answers `null` and every surface hides.

`usage.context_percent` is ignored for a smaller version of the same reason. The contract does not
say whether it is a fraction or a hundredth, and the two cannot be told apart for any session under
one per cent — which is every session for its first few turns. The percentage is derived from the
same division that draws the arc, so the label and the ring cannot disagree.

The capability gate is the gateway's own refusal rather than a version test: one `session.usage`
call per connection, and a failure turns it off for the life of that connection. It is recorded in
the RPC failure ring, because a swallowed error nothing anywhere admits to is the defect
`rpc-failures.ts` was written for.

### What is not covered

- **Not seen against a real gateway.** Every case is the fake, which now answers `session.usage` and
  carries the same reading inside `session.resume`'s `info`. Whether a real `hermes serve` fills
  `context_max` for every provider, or only for the ones whose catalogue it has, decides how often
  the row appears — and if it never does, the behaviour is the absent row rather than anything worse.
- **The row does not animate.** A `session.usage` tick lands several times a second during a turn and
  the ring simply redraws; nothing was measured about whether that reads as motion or as noise on a
  sheet the reader has open while a turn runs.

### An export is a file, not a `message`

`Share.share({ message })` needs no file and no dependency, and it was the wrong answer. A share
sheet handed a bare string can only reach a destination that TAKES text — Messages, Mail's body, a
note — and cannot save. Somebody who asked to export a conversation wants to keep it, so the one
destination that matters most is the one a string cannot reach.

So `platform/share-text.ts` writes into the cache directory with `expo-file-system` and hands the
resulting `file://` to the existing `shareFile` seam. `expo-file-system` was already in
`node_modules` as a dependency of `expo` itself, which means it is already in the native build; it
has been added to `apps/hermie/package.json` explicitly anyway, because a module reached through
somebody else's dependency edge is a module that disappears the day they drop it.

The cache directory rather than `document`, deliberately: an export is a hand-off, the system copies
what it needs the moment a destination is picked, and what is left behind is a duplicate of a
conversation the gateway already has. `document` is backed up and, with file sharing on, visible in
Files for ever.

The browser half makes a `Blob`, hands its object URL to the same seam, and revokes it on a timer
rather than in the same tick — revoking immediately races Safari's own read of the blob and lands as
a download of zero bytes.

### What is exported is what is on screen

`chat.items` has already been through the verbosity filter, the bot-to-bot toggle and the thinking
toggle, and that list is what the serializer is handed. A chat set to Quiet exports the quiet
conversation. The alternative — exporting the full state — would hand somebody a file containing
rows their own settings have been hiding from them, which is a worse surprise than a short file.

The serializer itself is pure and lives in `@hermie/transcript`, so it is vitest rather than jest.
Two things it deliberately does not do: it does not strip a reply's Markdown for the `.txt` file,
because those are the author's characters and an export must not edit what it preserves; and it does
not format a timestamp, because a file saved on this device should read in this device's clock and
the package has no business knowing what that is — the caller passes a formatter in.

### What is not covered

- **Neither seam has been run on a device or in a browser.** The jest cases drive the rows and the
  verb; whether an iPad's share sheet accepts a `text/markdown` file from the cache directory, and
  whether a browser's download honours the name for an object URL, are both unverified here.
- **There is no entry in the message context menu.** The brief offered "message menu / chat options";
  the options sheet is where a whole-conversation action belongs, and a per-message row that exported
  the whole chat would be a menu line about something other than the message it was opened on.

### A disabled menu line says something a missing one cannot

`Edit and resend` and `Regenerate` both put a new turn on the gateway, so neither can be taken while
one is already running. The obvious implementation is to leave them out of the menu for the
duration — and it is wrong for the same reason a control that appears and disappears is worse than
one that greys: a reader who opens the menu mid-turn and sees nothing learns that the feature does
not exist on this row, and stops looking. A greyed line says "not now".

So `turnRunning` disables rather than filters, and the guard is repeated at the tap. Three paths meet
there and only one of them is UIKit's: a `UIMenu` will not fire a disabled item, but the fallback
sheet draws a flat list, a keyboard can reach a row, and the turn can start between the menu opening
and the selection landing.

### `Regenerate` takes the gateway's road where there is one

`/retry` goes down `chat-controller.runSlash`, the same path every other command takes — same
directive handling, same notices, same failure reporting. The gateway knows what the turn was and
re-runs it, so the conversation gains a reply and not a second copy of the prompt that produced it.

Where the catalogue does not carry `/retry` — an older gateway, a profile without the command — the
fallback sends the reader's previous prompt again. Not the newest row: a cron delivery and an inbound
bot message both land on the user role, and repeating one of those would be repeating somebody else's
words. A conversation with no prompt of the reader's own in the visible list refuses and says so,
which is better than sending something that was never asked for.

The catalogue is the one the composer's autocomplete already reads, and a catalogue that has not
arrived yet answers "no" — the safe direction, because the fallback works everywhere and `/retry` is
an optimisation on it.

### What is not covered

- **Neither line has been selected against a real gateway.** `/retry` exists in the vendored contract
  and in upstream's command list; whether a given profile's catalogue carries it, and what its
  directive answers with, is unverified here. If it answers with a `send` directive the slash path
  already handles that — but nobody has watched it.
- **`Edit and resend` puts the references back as TEXT.** A turn holds `@file:` and `@image:`
  directives and `stripUserText` lifts them out of the body, so appending them to the draft is the
  round trip. It has not been driven through the composer's own chip rendering, and an image comes
  back as a chip rather than a thumbnail because the bytes are long gone from this device.
- **`Copy as Markdown` was already there** and is unchanged. It is still hidden on a message whose
  markdown and whose words are the same string, which is deliberate — two identical Copy lines read
  as a bug — and the brief's "add it next to the existing copy" was already satisfied.

## The app lock, and the two frames nobody looks at (2026-09-22)

A lock on the app is mostly not a cryptography problem. It is a rendering
problem and a lifecycle problem, and both of them are about frames a person
never deliberately looks at: the one between the splash handing over and the
first read off disk, and the one the operating system photographs on its way
out.

### The plate is not an overlay, and the difference is the feature

The obvious shape is a full-screen view with a high z-index over the app. It is
the wrong one, and not for a style reason. Under an overlay the transcript is
still mounted, the chat list is still mounted, the WebSocket is still open and
the query client is still refetching — so the lock holds a person's eyes and
nothing else. Everything it was supposed to keep back is one `opacity: 0` bug,
one `Modal` that fails to present, or one screenshot API away.

`features/lock/AppLock.tsx` therefore does not render `children` at all while it
is up, and it sits ABOVE `GatewayProvider` in `app/App.tsx` rather than inside
it, so a locked app holds no connection either. The test asserts the absence
rather than the covering — `expect(screen.toJSON()).not.toContain(SECRET)` —
because "is the plate on top" is the kind of claim that goes quietly false.

The cost is real and is the reason to write it down: unlocking re-mounts the
provider and re-dials. The stores are module-level and survive, so what is paid
is one trip up the reconnect ladder, not the conversation.

### `immediately` has to lock on the way OUT

iOS takes the app-switcher snapshot on the transition to `inactive`, not on the
return. A lock applied when the app comes back is therefore a lock applied one
frame after the card in the switcher has already been drawn from the transcript.
So `background()` is what locks at `immediately`, and the store maps BOTH
`inactive` and `background` onto it. `inactive` is also what a "Designed for
iPad" window on a Mac reports when it loses focus, which is the transition that
matters there.

That mapping opens a trap, and it is the reason `prompting` exists on the store
rather than being a spinner: **the Face ID sheet itself takes the app out of
`active`.** Without the guard, asking for an unlock fires `inactive`, which locks
the app underneath its own prompt, which on success unlocks it and on any
subsequent lifecycle event locks it again. An unlock that cannot finish because
asking is what breaks it. Every AppState change is ignored while a prompt is in
flight.

### The frame between the splash and the preference

The threshold is in `AsyncStorage`, which is asynchronous, so there is a real
moment where the app does not know whether it is locked. Three things can be
drawn in it and two are wrong:

| Drawn while the preference is unread | Who sees the wrong thing               |
| ------------------------------------ | -------------------------------------- |
| the app                              | everyone who turned the lock ON        |
| the plate                            | everyone who did not                   |
| a field of `elevation.e0`            | nobody — it is the splash's own colour |

`AppLock` draws the third and the gate's `ready` flag is set in exactly one
place, so the blank lasts one disk read. `__tests__/app-lock-gate.test.tsx` pins
the first frame by holding the biometric prompt open on a deferred promise;
without that, hydration wins the race and the assertion passes for the wrong
reason.

### `getEnrolledLevelAsync`, not `hasHardware` plus `isEnrolled`

The intuitive pair answers the wrong question. `isEnrolledAsync()` is about
BIOMETRICS, so it answers false on a phone with a passcode and no face — a phone
this lock works perfectly well on, because `disableDeviceFallback` stays at its
default and the platform collects the passcode itself.
`getEnrolledLevelAsync()` distinguishes `NONE` from `SECRET` (PIN, pattern,
passcode) from the two biometric levels, which is exactly the four-way split the
settings screen needs: refuse, refuse with a reason, "it will ask for your
passcode", and the ordinary case.

`NONE` is split further by `hasHardwareAsync()`, because only one of the two
sentences is actionable: "this device cannot" versus "set up a passcode first".

### A cold start ignores the grace period, deliberately

`15m` does not mean "unlocked for fifteen minutes after the process died". The
grace period exists so that switching to a password manager and back does not
cost a prompt, and a process the OS killed is not that. There is also nothing
honest to measure against — the only record of when the app went away died with
it — so honouring it would mean trusting a timestamp written to disk to decide
whether to ask for a face. `start()` locks whenever the threshold is not `off`.

### What is unverified here

- **No real Face ID, Touch ID or BiometricPrompt has been through this.** There
  is no device in reach from here. Everything above about the module is read from
  `expo-local-authentication`'s own types and source; everything about behaviour
  is the pure machine's table and a jest suite with the SEAM
  (`platform/biometrics`) mocked, not the module. What needs a hand check: that
  the iOS prompt appears at all with `NSFaceIDUsageDescription` set the way
  `app.config.ts` sets it, that a cancelled prompt leaves the plate up rather
  than dismissing it, that the passcode fallback appears after a run of failed
  faces, and that the `prompting` guard is actually enough — i.e. that no
  lifecycle event arrives between the guard clearing and the app becoming active
  again.
- **The app-switcher snapshot has not been looked at.** The claim that
  `inactive` is the transition to lock on is Apple's documented behaviour, not
  something measured here. What a locked Hermie's card in the switcher looks
  like on a device is unknown.
- **What a Mac window reports.** `client.ts` already records that the AppState
  values a "Designed for iPad" window reports have never been measured. The lock
  inherits that gap: whether a Mac window losing focus reports `inactive` — and
  therefore whether `immediately` locks when you click another app — is a
  reasonable reading of an iOS binary's behaviour and nothing more.

## Cloudflare Access, and the request a web view cannot make (2026-09-22)

A service token gets a REQUEST past Cloudflare Access. It does not get a
BROWSER past it, and the sign-in page is a browser. Everything awkward about
this feature is downstream of that one sentence.

### What `source.headers` does and does not cover

`react-native-webview`'s `source.headers` applies to the load the app initiates.
It does not apply to anything the page does afterwards, and there are two
different kinds of "afterwards":

| What the page does                           | Reached by `source.headers` | Reached by a document-start script |
| -------------------------------------------- | --------------------------- | ---------------------------------- |
| `fetch` / XHR to the gateway (`/login` POST) | no                          | yes                                |
| a sub-resource on the gateway origin         | no                          | no (not a scripted request)        |
| a top-level navigation it performs           | no                          | no                                 |

The middle row is why the script exists at all and the bottom row is why it is
not enough. The gateway's `/login` form posts with `fetch`, so without the
script a password provider behind Access is answered by the Access login page —
inside a web view that is already showing a sign-in, which is about as confusing
as a failure gets. `/auth/native/authorize` then navigates to the identity
provider and the provider navigates back, and those are top-level navigations:
no header this app sets and no wrapper this app installs is on them.

So the operator instruction in ADR-0004 — exempt `/auth/*` and `/login` — is not
a convenience. It is the only configuration in which the in-app flow completes
on a service token, and it is now in the field's own hint rather than only in a
decision record.

### The https rule, and why it is not an inconvenience

`frontDoorHeaders` returns `{}` for an `http://` or `ws://` address. A service
token is a long-lived bearer credential for a whole Access application, and this
app deliberately supports cleartext (ADR-0014) because a tailnet has already
encrypted the path — those two facts do not belong on the same wire. Conduit
applies the same rule in `Conduit/Services/CloudflareAccess.swift` and gives the
same reason.

The combination this forbids does not exist in practice: Access terminates TLS,
so a gateway behind it is reachable over https or not at all. What the rule
actually catches is a half-finished setup — an address typed without a scheme
that fell back to http, a `http://` typed out of habit — and the address step
says the token is being withheld rather than letting it look like a wrong
secret.

### `cf-access: present`, computed once

The developer screen is one screenshot away from an issue tracker, so the rule
is that it never holds a header value to begin with. `describeFrontDoor` runs at
the provider, at connect time, and what goes into the connection store is the
phrase. `redactHeaders` exists for anything that has to show a whole map, and it
replaces EVERY value rather than a list of known names — the custom preset is
there precisely so somebody can put their proxy's secret in a header this
codebase has never heard of, and a redaction allowlist is a list somebody
forgets to add to.

### Turnstile: read, not built

Conduit has a live-WebKit regression test for this,
`ConduitTests/TurnstileSubframeBoundaryTests.swift`. What it establishes is that
Cloudflare's Turnstile WebView requirements need the navigation delegate to
ALLOW `about:blank` and `about:srcdoc` subframe navigations, and that cancelling
a `srcdoc` subframe stops its document instantiating at all — measured against a
real engine rather than reasoned about.

Hermie's equivalent is `onShouldStartLoadWithRequest`, and
`inspectSignInNavigation` returns `continue` for everything that is not the
loopback redirect. So on the face of it the app already allows what Turnstile
needs. Two things stop that being a claim:

- **Whether the callback fires for subframes at all has not been measured**, on
  either platform. iOS routes it through `decidePolicyForNavigationAction`,
  which WebKit does consult for subframes; whether `react-native-webview`
  forwards a subframe navigation to JavaScript, and what it passes as the URL
  for `about:srcdoc`, is not something reading the prop's documentation settles.
- **No Access policy with Turnstile has ever been put in front of this app.**
  There is no tenant to point it at from here.

Nothing was added for it. An allowance written for a callback that may never
fire is a line of code that encodes a guess and then gets copied — and if the
callback does fire and does cancel, the symptom is specific and findable: the
Access challenge renders as an empty box. That is worth more than a speculative
`if`.

### What is unverified here

- **No real Cloudflare Access front door has been through any of this.** There
  is no tenant available from here. Everything is the gateway client's suites
  against a mocked `fetch`, the app's suites against a mocked resolver, and the
  header names read from Cloudflare's documented service-token scheme.
- **The document-start script has never run in a web view.** It is asserted as a
  STRING — that it is built from the values, that it pins both origins, that a
  hostile secret cannot close the literal — and jest's web view is a stand-in
  that renders props. Whether `injectedJavaScriptBeforeContentLoaded` actually
  beats the gateway's own page scripts to `window.fetch` on WKWebView is the
  prop's documented contract and not a measurement.
- **The redirect-back behaviour is reasoned, not observed.** The claim that the
  Access edge answers the returning top-level navigation with its own login page
  follows from how Access works; what that looks like inside the sign-in modal,
  and whether the interactive Access login completes there under `incognito`
  with `sharedCookiesEnabled={false}`, has not been seen.
- **The origin binding has never rejected a real record.** Its tests write the
  mismatch by hand. The case it is for — a restore onto another device, or a
  record from a build before the binding existed — cannot be produced here.

## Two sentences the setup step could not say (2026-09-22)

The address step had a message for every failure kind and no way to say the two
things that actually resolve a stuck setup: that the address is fine and the
NETWORK is the problem, and that there is something to press.

### Why the hint is a code and not a sentence

`probe.ts` already wrote a private-network line, in the gateway client, in
English. That is right for a library with no string table and wrong for the app,
which has one — a screen printing a sentence composed inside a package is a
screen whose voice cannot be read from `i18n/strings.ts`, and the word that
needed changing would be in the file nobody looks in.

So `classifyProbeFailure` answers in codes. `GatewayError` gained one structured
field to make that possible, `sawLandingPage`, because the decision needs to
know whether a WEB PAGE came back and the only other record of that was the
English sentence it would have had to match on. `error.hint` stays exactly as it
was, for callers that are not this app.

### What the private-network line requires, and what it refuses

Two triggers, both facts rather than inferences:

| What happened                | Host                        | Link     | Says it |
| ---------------------------- | --------------------------- | -------- | ------- |
| a web page came back         | `10.x`, CGNAT, `.ts.net`, … | any      | yes     |
| a web page came back         | a public name               | any      | no      |
| JSON that is not a gateway's | `10.x`                      | any      | no      |
| nothing answered             | `.ts.net`                   | cellular | yes     |
| nothing answered             | `.ts.net`                   | Wi-Fi    | no      |
| nothing answered             | `.ts.net`                   | unknown  | no      |
| nothing answered             | a public name               | cellular | no      |
| anything                     | loopback                    | any      | no      |

The refusals are the point. A "check your VPN" told to somebody whose gateway is
simply switched off costs them the next twenty minutes, and the earlier version
of this line went out for every landing page on any host — which sent readers to
a tunnel when what they had was a typo. Wi-Fi is excluded for the same reason:
on a LAN, an unreachable tailnet name is as likely to be a gateway that is off.
Loopback is excluded because the device IS that network.

**The case it deliberately misses**: a Headscale operator's own domain. Nothing
here resolves a name, so `hermes.example.org` that only answers inside a tunnel
looks public and gets the ordinary sentence. Reading it as private would mean
guessing about every public name on the internet, and the sentence it would
produce is the one that wastes the most time when it is wrong.

### The link is asked for after the failure, not held

`networkWatcher.kind()` is a new method on the seam rather than a second value
on the subscription, because nothing reacts to it: the one reader is this hint,
and it asks in the probe's own `catch`. That also makes the answer describe the
moment the probe ran rather than whenever the step last mounted — which on a
phone that has just left the house is a different answer.

NetInfo's four values collapse to `wifi`, `cellular`, `other` and `unknown`, and
`none` maps to `other` on purpose: "no interface at all" is a real answer, and
it is one this hint must not read as mobile data. The browser seam answers
`unknown` unconditionally rather than reaching for `navigator.connection`, which
is unimplemented in Safari and Firefox, is a fingerprinting surface, and would
buy one sentence in a wizard step the web build does not have.

### A test that had to change, and why

`__tests__/onboarding-address-step.test.tsx` asserted the pinned-https message
with `toHaveTextContent(string)`. That matcher is EXACT in
`@testing-library/react-native` — `matches(..., exact = true)` in
`build/matches.js` — not a substring check the way jest-dom's is. The failure
mode is also worth knowing: the assertion never passes, `waitFor` spins, and
what the run reports is "Exceeded timeout of 5000 ms" with no mention of text at
all, which reads as a hang rather than as a mismatch.

The fixture address in that test is `hermes.fss.internal` and NetInfo's test
double reports `cellular`, so it is exactly the pair the new sentence is for.
The assertion now spells out the whole message; the new suite uses regexes.

### What is unverified here

- **Nothing here has been seen on a device.** No gateway behind a landing page,
  no phone taken off a tailnet onto mobile data. The link type comes from
  NetInfo's jest double, which reports `cellular` unconditionally, so what a
  real `NetInfo.fetch()` answers on a phone with Wi-Fi assist, on a Mac, or on
  an iPad with no cellular radio at all has not been looked at.
- **`other` for `none` is a reading, not a measurement.** It matters only if a
  device can report `none` while a probe still fails in a way worth hinting
  about, which would be odd.
- **The landing-page detector is unchanged and still crude**: `<!doctype html`
  or `<html` in the first 2000 characters. A proxy that answers with an error
  page that opens with a comment or a BOM is not detected, and never was.

## Round R4: the chat's menu, the pill, the drag, approvals, notifications, text size

Seven things were asked for. Six landed; the seventh is partly done and the rest
of it is written down at the bottom rather than half-wired.

### The (…) menu was a sheet, and a sheet moves the chat

The owner's report was four words long — _"nu schuift alles"_ — and the cause
was not a bug. `ChatOptionsSheet` is a `BottomSheet`, a `BottomSheet` is a
`Modal`, and on the compact shell it dims the window, takes the keyboard and
pushes the transcript up to make room for itself. Every one of those is the
screen moving because somebody asked what their options were.

The first level is now a floating glass surface laid out ABSOLUTELY beside the
transcript rather than above it, which is why nothing behind it shifts. That is
asserted rather than eyeballed: `chat-options-popover.test.tsx` compares the
transcript's `contentContainerStyle` before and after opening, because every
other assertion in that file would still pass if the list quietly re-padded
itself.

**Popover or sheet is decided by measuring the chat column**, never by
`Platform.OS`. A Mac window dragged narrow and a phone are the same problem, and
only one of them is a platform. A column that has not laid out yet reports `0`,
which is "not known" rather than "too narrow", so the very first open before
layout takes the sheet instead of guessing.

The deeper pages still open the sheet, and open it ON the page asked for.
`initialPane` was a development-only lever for photographing a page on a
simulator this machine can only launch; it is now also the hand-over, and its
doc comment says so.

### The header pill: the width stopped being derived

The status line had already been taken out of the pill's intrinsic width — it is
an absolutely positioned child, which Yoga leaves out of its parent's measure —
and the owner still reported the pill changing size while a bot thinks.

Rather than re-argue the box model, the width stopped being a question anything
can answer. A **ruler** — the name at the same type token, laid out with nothing
around it and nothing to shrink against — reports the name's own width once, and
the column is given that number as an explicit `width`. The only thing that can
move the pill now is the bot being renamed, and the ruler is keyed on the name so
that case re-measures.

**Why this rather than reserving the widest status:** the owner's parenthetical
offered both. Reserving the widest of the four state labels would make the pill
as wide as `Offline · last seen 09:12` on every chat, which is wider than most
bot names and would change the whole header's composition. Pinning to the name
keeps the pill the size it already is and removes the failure mode.

### The drag was keyed by bot name, end to end

`folder-rows.ts` has described the chat list in row KEYS — `bot:<name>` and
`folder:<id>` — since it was written. `use-row-drag.ts` took bot names and
rebuilt `` `bot:${name}` `` in two places, so the one kind of row whose key it
did not speak was the one kind it could not pick up: `anchors.findIndex` for a
folder could only ever miss, which put the lift's origin at anchor 0 and moved
every neighbour the wrong way.

The hook now takes and reports keys and nothing else, and `onCommit` hands the
key back for the screen to make sense of. The folder row gets the identical
lift, shadow, neighbour shift and settle rather than a second implementation
standing beside the first.

One rule is the folder's own and is stated in ADR-0019's amendment: **a folder
only ever lands at the top level, because folders do not nest.** A drop target
inside some other folder has no meaning for a folder, so `topLevelIndexOf` turns
it into the position that folder occupies — "next to that one", which is the
only reading a reader can predict. Dropping a CHAT onto a folder still puts it
inside; that anchor is untouched.

### Approvals: the sheet is how a question arrives, not the only way to answer

ADR-0010 stands and its amendment says why. The sheet's argument is about
ARRIVAL — a question that holds the agent's turn has to reach a reader who may
be a thousand rows away — and it says nothing about the reader who has already
scrolled to the call and decided.

**The gateway gap:** an approval carries a tool NAME and no tool-call id. So
nothing in the transcript can say with certainty which card a question belongs
to, and `ToolCard` therefore takes the question as a PROP and never looks one
up. The host matches on the name and on the card not having finished. Two
concurrent calls to the same tool would draw the question twice — the same
question, not the wrong one, and answering either answers it. Working around it
in the app rather than asking upstream is the standing rule.

### Per-chat notification types: why the schema is NOT bumped

The brief asked for a schema bump with tolerance. It is deliberately not bumped,
and this is the one place the round went against the instruction on purpose.

`PUSH_SECTION_VERSION` is checked **per row** by the notifier, and a row whose
`v` it does not understand is **dropped**. Bumping would therefore not protect
`perBot` from an older plugin — it would unregister the device and make the
phone go quiet. The field is additive instead, in exactly the shape `folders`
and `botNameOrder` already use in the same section: a notifier that has not
learned it keeps honouring the global types, which is what it did before the
field existed. `chat-notification-types.test.tsx` pins the version so that this
decision has to be taken again deliberately rather than by accident.

**The plugin-side key**, for the plugin round: `hermie-app` → `push` → `perBot`
→ `<bot name>` → `<push type>` → boolean. It sits BESIDE `registrations` and
`seen` rather than inside a device's row, because it is a decision about the
reader rather than about a device — the same argument `mutes` makes. It is
PARTIAL: a type a chat does not mention follows the global switch. The merge
rule is `effectivePushTypes(global, overrides)` in
`packages/gateway-client/src/push.ts`, exported so both sides read one rule
rather than two that happen to agree.

### Text size scales the transcript and not the chrome

A provider around the transcript supplies a theme whose `type` tokens are
multiplied; everything under it — `Text`, the Markdown blocks, the code blocks,
the bubbles — already reads `theme.type`, so a component added tomorrow follows
without being told to. A prop would have to be threaded through every row, and
the first one somebody forgot would stay 17pt while the rest of the conversation
grew.

A scale of exactly 1 provides the OUTER theme object unchanged rather than a
copy, so the default costs nothing — not even a context value that differs by
identity from the one above it, which the transcript's row memoisation would
otherwise notice.

### What could not be verified

- **Nothing in this round has been seen on a device or against a real gateway.**
  There is no gateway running here and no simulator this machine can drive, so
  every assertion is a test-renderer assertion.
- **The popover's measurement.** The popover-or-sheet decision reads a width
  from `onLayout`; in the tests that width is handed in. What an iPad in Split
  View, a Mac window being dragged, or a phone in landscape actually reports has
  not been looked at, and neither has whether 400pt is the right threshold on
  any of them.
- **The header pill's ruler.** The test renderer has no layout engine, so the
  ruler's own `onLayout` is invoked with a number rather than measured. That the
  ruler genuinely reports the name's INTRINSIC width — and not a width
  constrained by the centring column it sits in — is reasoned from the fact that
  it is absolutely positioned with only `left` and `top` set, and has not been
  measured.
- **The drag gesture itself**, as ADR-0019 already said: a `PanResponder` needs
  a touch and the boxes it reads come from a real layout pass. The folder drag
  is exercised as arithmetic plus "the grip carries a responder".
- **Two concurrent calls to the same tool** drawing one approval twice. It needs
  a gateway that will do that.
- **Anything the notifier does with `perBot`.** The app writes the key and the
  merge rule is tested; no plugin reads it yet. That is the plugin round's.
- **`onboarding-probe-hints.test.tsx` flaked once** in a full run ("clears the
  actions once the address answers") and passed on its own and on every rerun.
  It is untouched by this round; noting it because it was seen.

### Item 3 (sessions) is only partly done

**Delivered:** `Refresh` in the chat's menu — re-read the roster, which is where
a canonical session id comes from, then re-open the chat, which resumes and
replays. That is the gateway-restart case, and a pull gesture cannot express it
because on an inverted transcript a pull already means "older messages".

**Not delivered, and not started:** `session.branch` and the Branches section,
`Pin`, and the "Past conversations" page with rename and `session.delete` for
non-canonical sessions. None of it is stubbed and none of it is half-wired —
there is no dead code to clean up. What it needs, in the order it would be
built:

1. controller methods over `session.branch`, `session.list` (per profile,
   `include_hidden`) and `session.delete`, with the fake gateway extended and
   `upstream-shapes.test.ts` kept honest against the vendored contract;
2. a model for a session that is NOT the canonical one — branches and retired
   `Bot Chat · <date>` conversations are ordinary visible sessions, and the
   one-canonical-chat rule (ADR-0007) means the chat list must never offer to
   delete or hide the canonical one, so the model has to make that a type
   distinction rather than a check somebody can forget;
3. the surfaces: a Branches group under the bot in the chat list, a Past
   conversations page opened from the bot profile sheet, and the row menu items.

`Pin` is independent of all of that — it is a `Record<string, true>` in the
chat-layout store, synced in the app-wide section like the mutes, and a sort
inside `folderRows`. It was left out because it changes the order the drag
arithmetic reads, and this round had already changed that arithmetic once.

## Voice: speaking, listening, and an RPC that does neither (2026-09-22)

### The gateway's voice methods are for the gateway's own machine

The round's brief said to offer "Gateway voice" when `voice.tts` answers audio, and "Gateway
transcription" when `voice.record` advertises it. **Neither method does what that describes**, and
the reading is short enough to put here in full because the contract does not make it obvious.

`tui_gateway/methods_voice.py::voice.tts` is nine lines. It takes `text`, refuses an empty one,
starts a thread running `_speak_text_with_barge` — which calls `speak_text` from `hermes_cli.voice`
— and answers `_ok(rid, {"status": "speaking"})`. `speak_text` plays through **the gateway host's
speaker**. The vendored type agrees and is the shortest possible summary of the problem:

```ts
export interface VoiceTtsResult {
  status: string
}
```

No bytes, no base64, no url, nowhere for any of them to go. Called from a phone against a gateway on
somebody's laptop, the laptop starts talking.

`voice.record` is the same shape pointing the other way. It calls `start_continuous(...)`, which
opens **the gateway host's microphone**, and answers `{"status": "recording"}`; the transcript
arrives later as a `voice.transcript` event. `VoiceRecordParams` is `{action, session_id, profile}` —
there is no field for client audio. It also refuses with 4015 unless `HERMES_VOICE` is `1` on the
gateway process, which a client can only change by calling `voice.toggle {action: "on"}` and
flipping a **process-global** env flag that every other surface on that gateway shares.

`wake.feed` is the only RPC in the protocol that takes a client's audio: base64 int16 mono, 16 kHz
only, a 64 000-byte cap, and it answers `{fed: bool}`. It feeds the wake-word detector. There is no
path from it to a transcript.

So: **there is no RPC that takes audio from a client and answers with text, and none that answers
with audio to play.** Both gateway options in the brief describe a capability that does not exist.
Building either would have meant teaching `packages/fake-gateway` a shape the real gateway does not
have, and going green over a feature that cannot work — which is the trap `profiles.configure` and
its missing `display_name` set in the previous round, recorded above. ADR-0021 is the decision.

### What a speech engine wants is not what a screen wants

`markdown/plain-text.ts` already answers "what are the words" and it is the wrong answer for a
speaker, in four places:

- **A code block is read as its shape.** Forty lines of TypeScript spoken one character at a time is
  ninety seconds that cannot be paused anywhere useful, so it becomes `Code block, 40 lines`. Up to
  two short lines are read out instead, because a one-liner is often the whole answer and
  summarising it would hide the reply.
- **A table is read a row at a time**, cells separated by commas and rows ended with a full stop.
  Column alignment is a fact about a screen.
- **A link reads its label**, which is the call `plain-text.ts` already makes.
- **Mathematics is read as its SOURCE.** This is the one that needs care rather than taste.
  `a_1 + b_2` inside `$…$` is ordinary, and CommonMark's intraword rule does not save it: `_1 + b_`
  is a legal emphasis run between two non-word characters, so an unmasked pass through the existing
  stripper produces `a1 + b2` and silently deletes two subscripts. Maths is therefore masked out
  before the inline pass and restored afterwards, exactly as written.

The mask is NUL, because it is the one character neither a model nor the stripper acts on — and it
is built with `String.fromCharCode(0)` rather than written as an escape, because **Prettier rewrites
that escape to the raw byte** and a source file with a NUL in it is one that `grep`, `diff` and most
editors treat as binary. That was observed here, not guessed at.

### A stop is not a completion, in three separate machines

The same guard appears in `SpeechReader`, `DictationMachine` and `VoiceLoop`, and it is the same
defect in each: the platform can deliver a callback for a session that has already been replaced.

- `speechSynthesis.cancel()` does not reliably suppress the `end` event, so a stop can look like a
  finished utterance and advance the queue — which would make "stop reading" start the next reply.
- Android's recognizer delivers `error` and then `end`; iOS can deliver `end` alone. Treating `end`
  as the last word twice restarts a loop that had already moved on.
- A permission dialog can be granted after the reader has let go of the button.

Every one of these is answered by a generation counter captured at start and checked in each
callback, rather than by a boolean — because the two events can arrive in either order and a flag
cannot tell "we are stopping" from "we have already started something else".

`expo-speech`'s `onStopped` is deliberately routed to nothing for the same reason: the seam calls
`Speech.stop()` before every `speak`, so mapping `onStopped` to `onDone` would advance the queue on
the very call that was replacing its head, and the queue would lose an item per tap.

### The mic's long press was already taken

The brief put voice mode behind "the composer's mic long-press menu". It is not there, because
**press-and-hold IS dictation**: hold the mic to talk, let go to stop, which is what the platform
keyboards' own dictation keys do and what `press-to-talk.ts` implements from two timestamps. A menu
on the long press would take that gesture away from the feature the button exists for, on the one
platform — a phone — where there is no other secondary gesture.

So voice mode is reached from the chat options sheet, which the brief offered as the alternative,
and from an `accessibilityAction` on the mic that VoiceOver's rotor and a secondary click both
reach.

### Four rules that make the loop usable rather than alarming

All four are in `features/voice/voice-loop.ts` with every side injected, and each of them exists
because the obvious implementation is unpleasant rather than broken:

1. **An empty transcript is never sent.** Without it the loop asks the bot to answer a cleared
   throat, and the bot obliges.
2. **The transcript is shown for a second before it goes**, with a cancel, on by default. Voice mode
   speaks FOR the reader; a recognizer that mishears should not be able to put words on a
   conversation with no moment to stop it.
3. **Silence ends the utterance** — the recognizer's own final result where it gives one, 1.5 s
   after the last thing heard where it does not, because some recognizers in continuous mode never
   volunteer a final. The timer is armed only once something HAS been heard, so a reader who takes
   three seconds to start is not cut off before they begin.
4. **A tap interrupts rather than leaves.** "Stop talking, let me speak" is the commonest thing
   anybody wants in this mode, and a tap that also closed the overlay would lose the mode by doing
   it. Leaving is the swipe and Escape.

`no-speech` is deliberately NOT an error inside the loop: in a hands-free conversation it means the
reader paused to think, and stopping the whole mode over it would make the feature unusable. Every
other failure does stop, so a broken recognizer cannot spin.

### Two menu lines that were never drawn

Not a voice defect, but it was found by landing on it. `TranscriptList` builds each row's context by
naming fields one at a time — the comment above that memo explains why it cannot spread `handlers` —
and **four of the fields `TranscriptContext` declares were never named**: `onEditResend`,
`onRegenerate`, `turnRunning` and `lastAssistantId`. Every one of them arrived `undefined` at every
row, so `Edit and resend` and `Regenerate` were drawn nowhere in the app.

`message-actions.test.ts` calls `messageMenuItems` directly and passed throughout, which is exactly
how a gap like this survives: the unit under test was correct and nothing tested the wiring.
`__tests__/chat-ui/transcript-menu-wiring.test.tsx` covers the round trip now, by standing in for
`ContextMenuHost` — which renders its children bare wherever there is no native menu, so the items
never reach the tree and no ordinary query could see them.

### What is unverified here

**No device audio was available for any of this.** Everything above is the suites and a reading of
the platform APIs; what a device check has to cover:

- **The iOS silent switch.** `useApplicationAudioSession: false` hands the synthesiser its own
  session, which is what gets ducking, interruption by a call or Siri, and resumption afterwards —
  but the CATEGORY that session takes is the platform's choice and not a parameter, so whether a
  reply is read aloud with the ring switch set to silent is genuinely unknown. If it is silenced,
  the fix is an `AVAudioSession` category of our own, which means adding `expo-audio` purely to
  configure one.
- **Ducking against music, and what happens on a phone call.** Same session, same reason.
- **Whether on-device recognition is actually available** on a given iPhone, iPad, Mac window or
  Android device, and what `supportsOnDeviceRecognition()` answers there. The whole capability gate
  hangs off it, and a `false` means no microphone button at all — which is the intended behaviour
  and still needs to be seen rather than assumed.
- **What `getSupportedLocales().installedLocales` returns in practice.** Empty is handled (the
  picker offers the device language alone) but whether a phone with two keyboard languages reports
  two entries, or none, has not been looked at.
- **The permission dialogs.** Both usage strings are asserted by `microphone-config.test.ts` and
  neither has been seen on a device; a missing one does not produce a refusal on iOS, it terminates
  the app.
- **The Android `<queries>` entry.** The plugin writes it, and the failure it prevents — a release
  build that cannot see the recognition service while a debug build can — only shows up after
  release.
- **Voice mode end to end against a real gateway.** The loop is covered with fake timers and fake
  engines; nobody has spoken to a bot and heard it answer. In particular, the reply is picked as the
  first assistant row that is new since the send and arrives after the turn ends — a chat where a
  cron delivery or a bot-to-bot reply lands in that same window has not been watched.
- **Haptics.** `choice` on both edges of listening, which is `selectionAsync`. Whether that reads as
  punctuation or as noise at the rate a hands-free loop produces it is a judgement nobody has made
  with a phone in their hand.
- **The overlay at phone width, and the ring's gain.** `RING_GAIN` is 0.35 against a level the
  recognizer reports in roughly −2…10 decibel-ish units, converted in the seam. Both numbers are
  chosen rather than measured.
- **Dictation on the web.** The Chrome and Safari path is written from the API's documented
  behaviour; neither has been driven in a browser here.
