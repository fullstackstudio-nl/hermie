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

| Question                                         | Answer                                         | Date       |
| ------------------------------------------------ | ---------------------------------------------- | ---------- |
| Does the iOS app build for a Mac?                | Yes — Release, signed, wrapped, `npm run mac`  | 2026-09-19 |
| Is the empty strip under the title bar gone?     | Fixed in code; **unverified at runtime**       | 2026-09-19 |
| Does a bare Return send on a Mac?                | Implemented; **unverified at runtime**         | 2026-09-19 |
| Is Shift+Return a newline on a Mac?              | Yes, inserted by hand; **unverified**          | 2026-09-19 |
| Does Escape close a sheet on a Mac?              | Implemented; **unverified at runtime**         | 2026-09-19 |
| Is `GCKeyboard` populated for an iOS app on Mac? | **Unverified** — reasoned from the SDK only    | 2026-09-19 |
| Is `expo-secure-store` keychain-backed on a Mac? | Linked and entitled; **unverified at runtime** | 2026-09-19 |
| What AppState does a Mac window report?          | **Unverified** — see "A Mac never pauses"      | 2026-09-19 |
| Is `TextDecoder` present at runtime?             | Not verified; the guard ships either way       | 2026-09-18 |

"Unverified at runtime" is exact: the app builds, is signed and is wrapped, and the code path was read
rather than watched. The owner's own Hermie was running on this machine, and two copies of one bundle
identifier cannot both run, so nothing was launched.

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

**Unverified at runtime.** Not seen in a window — see the note under Summary.

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

**Unverified at runtime.**

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
- **Whether `GCKeyboard.coalesced` is populated for an iOS app on a Mac is UNVERIFIED.** It is
  documented for iOS 14+ and macOS 11+, and a Mac always has a keyboard, but this has not been watched.
  If it comes back nil the behaviour degrades to what shipped before — Return sends, Shift+Return also
  sends, Escape does nothing — and nothing crashes: every path is a `guard let` that falls back to
  false.
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
