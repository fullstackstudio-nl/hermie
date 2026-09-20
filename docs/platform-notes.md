# Platform notes

What actually works on each platform, what had to be changed to get there, and what is still unknown.
Findings are dated, because the answers change with every SDK bump.

Everything below was measured on: macOS 27.0 (Darwin 27.0.0, Apple Silicon), Xcode 27.0, Node 26.8.2,
npm 11.19.1, CocoaPods 1.17.0, Expo SDK 54.0.37, React Native 0.81.5.

There are three targets and two builds. iOS and Android are what you expect; the Mac is the **iOS
build** running as "Designed for iPad" (ADR-0011). Sections dated before 2026-09-19 that talk about a
native macOS target described a platform that no longer exists — they were removed rather than
rewritten, and git history has them.

## Summary

| Question                                         | Answer                                          | Date       |
| ------------------------------------------------ | ----------------------------------------------- | ---------- |
| Does the iOS app build for a Mac?                | Yes — Release, signed, wrapped, `npm run mac`   | 2026-09-19 |
| Is the empty strip under the title bar gone?     | Chat column yes, sidebar no — now fixed         | 2026-09-19 |
| Does a bare Return send on a Mac?                | **Yes** — used by hand                          | 2026-09-19 |
| Is Shift+Return a newline on a Mac?              | **Yes** — used by hand                          | 2026-09-19 |
| Does Escape close a sheet on a Mac?              | **Yes** — used by hand                          | 2026-09-19 |
| Is `GCKeyboard` populated for an iOS app on Mac? | **Yes** — the three keys above prove it         | 2026-09-19 |
| Is `expo-secure-store` keychain-backed on a Mac? | **Yes** — signed in across a quit and relaunch  | 2026-09-19 |
| Does the app launch on iOS 27?                   | **Yes, since scene adoption** — simulator       | 2026-09-20 |
| Does `AppState` survive the scene life cycle?    | **Yes** — measured, background and foreground   | 2026-09-20 |
| Can a Release build reach a gateway over http?   | **Yes, since the ATS key** — iOS 27 simulator   | 2026-09-20 |
| What AppState does a Mac window report?          | **Unverified** — see "A Mac never pauses"       | 2026-09-19 |
| Does a mouse drag still scroll a list on a Mac?  | Fixed in code; **unverified** — no Mac window   | 2026-09-20 |
| Can a drag SELECT text in a bubble?              | **No** — RN copies the whole block; see below   | 2026-09-20 |
| Why does replacing the .app sign the owner out?  | **Unresolved** — group made explicit; see below | 2026-09-20 |
| Can the simulators here be tapped and typed in?  | **Yes**, through the dedicated simulator tool   | 2026-09-20 |
| Is the sidebar tab strip present in portrait?    | **Yes** in the real shell; the gallery lied     | 2026-09-20 |
| Does `contrast:check` cover avatar tints?        | **No** — measure those by hand                  | 2026-09-20 |
| Is `TextDecoder` present at runtime?             | Not verified; the guard ships either way        | 2026-09-18 |

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

`src/platform/safe-area.android.tsx` now renders `<StatusBar style="auto" />` from `expo-status-bar`
inside the provider. That provider is the only wrapper already present on every Android screen and it
sits above the navigator, so the setting survives screen changes. Verified dark-on-light in light
mode and light-on-dark in dark mode, on both the chats list and a native header.

One caveat is left: `style="auto"` follows the _system_ scheme, which is the same source the theme
uses while Appearance is on "System" (the default). A user who pins the app to Light while the phone
is Dark gets the system's ink rather than the app's. Fixing that needs the status bar driven by
`useTheme().scheme`, which lives _below_ this provider.

### `adjustResize` is a no-op under edge-to-edge — the composer hides behind the keyboard

**Not fixed; it needs a change to shared code.** This is the worst thing found on Android.

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
  `<team>.nl.fullstackstudio.hermie`.

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
  xcrun simctl launch <udid> nl.fullstackstudio.hermie --initialUrl http://localhost:8081
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
the inner bundle):

```
Authority=Apple Development: <redacted>
TeamIdentifier=S8832KD227
[Key] application-identifier            [String] S8832KD227.nl.fullstackstudio.hermie
[Key] com.apple.developer.team-identifier [String] S8832KD227
[Key] get-task-allow                    [Bool] true
```

**No `keychain-access-groups`.** `apps/hermie/ios/Hermie/Hermie.entitlements` was an empty `<dict/>`,
because `app.config.ts` set no `ios.entitlements`. So the effective group was entirely implicit,
derived by the system from the signing identity. The embedded provisioning profile grants
`S8832KD227.*` and is a **seven-day automatic profile**, minted again whenever it has lapsed;
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
  `['$(AppIdentifierPrefix)nl.fullstackstudio.hermie']`. That is the same string the implicit
  default already resolved to, and it is first in the list on purpose: `SecItemAdd` without an
  explicit group writes to the FIRST entry and `SecItemCopyMatching` searches EVERY entry, so
  naming it moves no write and leaves every existing item readable. There is no migration. What it
  buys is that the group is declared by this repository, is auditable in `codesign`, and no longer
  depends on what the signing pipeline inferred that day. **It is prophylactic. Do not report this
  as fixed until a replace-then-launch cycle has been watched to keep the session.**

  That the write target is unchanged is measured, not argued. `codesign -d --entitlements -` on the
  bundle `npm run mac` produced after the change:

  ```
  [Key] application-identifier    [String] S8832KD227.nl.fullstackstudio.hermie
  [Key] keychain-access-groups    [Array]  S8832KD227.nl.fullstackstudio.hermie
  ```

  `$(AppIdentifierPrefix)nl.fullstackstudio.hermie` resolved to the same string the
  `application-identifier` already was — which is exactly what the implicit default resolves to. So
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
