# Platform notes

What actually works on each platform, what had to be changed to get there, and what is still unknown.
Findings are dated, because the answers change with every SDK bump.

Everything below was measured on: macOS 27.0 (Darwin 27.0.0, Apple Silicon), Xcode 27.0, Node 26.8.2,
npm 11.19.1, CocoaPods 1.17.0, Expo SDK 54.0.37, React Native 0.81.5, react-native-macos 0.81.9.

## Summary

| Question                                    | Answer                                       | Date       |
| ------------------------------------------- | -------------------------------------------- | ---------- |
| Does `expo start` serve `platform=macos`?   | Yes                                          | 2026-09-18 |
| Does the macOS app build?                   | Yes, Debug, after the changes below          | 2026-09-18 |
| Does the macOS app run?                     | Yes — sidebar shell, system dark mode        | 2026-09-19 |
| Do the navigation libraries build on macOS? | No — react-native-screens has no macOS slice | 2026-09-18 |
| Is `TextDecoder` present at runtime?        | Not verified; the guard ships either way     | 2026-09-18 |
| Is expo-secure-store available on macOS?    | No                                           | 2026-09-18 |
| Is expo-sqlite available on macOS?          | Yes, links and compiles                      | 2026-09-18 |
| Is expo-crypto available on macOS?          | Yes, and it runs                             | 2026-09-19 |
| Is react-native-webview available on macOS? | Native module loads; rendering unverified    | 2026-09-19 |
| Is NetInfo available on macOS?              | No — importing it crashes the app            | 2026-09-19 |

"Links and compiles" is exactly that: the pod is linked into the macOS app and the app builds. It is
not a statement that the module behaves correctly at runtime — that gets verified when the feature
using it is built.

## Metro and the macOS platform

**`expo start` serves the `macos` platform.** A separate `react-native start` is not needed, which
removes the uncertainty the plan flagged. Verified by requesting a macOS bundle from the running dev
server and by the app fetching its bundle from it:

```
macos Bundled 1265ms apps/hermie/index.js (1014 modules)
```

The bundle contains 585 references to `node_modules/react-native-macos/` and no real references to
`node_modules/react-native/`, so the import rewrite in `metro.config.js` covers the whole graph,
including the deep `react-native/Libraries/...` imports that libraries use.

Two things to know about the dev server in this monorepo:

- **Metro's server root is the repository root, not `apps/hermie`.** Expo's default config watches
  every workspace package, and Metro takes the common ancestor as its server root. So the bundle URL
  is `/apps/hermie/index.bundle` or `/.expo/.virtual-metro-entry.bundle`, not `/index.bundle`. This
  is why the macOS `AppDelegate` asks for the bundle root `.expo/.virtual-metro-entry` rather than
  `index` as the react-native-macos template does.
- **Do not add the workspace root to `watchFolders`.** It looks harmless and expo-doctor will even
  ask for it if you replace the defaults, but it moves the server root and breaks the entry
  resolution. Leave `watchFolders` and `resolver.nodeModulesPaths` exactly as Expo computed them.

The dev server logs `Using src/app as the root directory for Expo Router` on start. That is a
false positive: expo-router is not installed and the entry point is `index.js`. The message comes
from the directory being named `app`.

## macOS: what had to change relative to the template

`apps/hermie/macos/` was generated from the react-native-macos 0.81.9 template and then adapted. The
template was produced by `react-native-macos-init@2.1.3`, which **does not run inside an npm
workspace** — it shells out to `npm install --save`, which npm refuses in a workspace root
("This command does not support workspaces"). It was run in a scratch directory with a matching
`package.json` and the result was copied in.

Changes made to the generated output:

1. **`Podfile`** — rewritten to load Expo's autolinking, call `use_expo_modules!` with an exclusion
   list, resolve the React Native path through Expo's autolinking config (`#{config[:reactNativePath]}-macos`),
   and raise the deployment target floor. See the two sections below.
2. **`Podfile`, `post_install`** — `REACT_NATIVE_PATH` is corrected. CocoaPods writes it as
   `${PODS_ROOT}/../../node_modules/react-native`, which is wrong twice over here: npm workspaces
   hoist the package to the repository root, and the macOS build needs `react-native-macos`. The
   Hermes and codegen script phases both read this setting, and the build fails with
   `No such file or directory` on `with-environment.sh` until it is right.
3. **`AppDelegate.mm`, `moduleName`** — changed from `@"Hermie"` to `@"main"`. Expo's
   `registerRootComponent` registers the root under `main`; the template assumes the product name.
   With the wrong name the app launches, fetches its bundle and shows an **empty grey window with no
   error** — there is no red box for a missing root component, which makes this an expensive hour if
   you do not know to look for it.
4. **`AppDelegate.mm`, `bundleURL`** — bundle root changed from `index` to
   `.expo/.virtual-metro-entry`, per the react-native-macos guide for Expo modules and because of the
   server root described above.
5. **`project.pbxproj`, "Bundle React Native code and images"** — replaced with Expo's bundling
   script, adapted for macOS: it resolves the entry with `expo/scripts/resolveAppEntry` for the
   `macos` platform, bundles through `@expo/cli` with `export:embed`, and calls
   `react-native-macos/scripts/react-native-xcode.sh`. The template's version calls a relative path
   into `../node_modules/react-native`, which does not exist in a workspace.
6. **`project.pbxproj`, `PRODUCT_BUNDLE_IDENTIFIER`** — set to `nl.fullstackstudio.hermie` in all
   four build configurations.
7. **`Podfile`, platform** — `platform :macos, '14.0'`. react-native-macos 0.81 sets its own floor at
   14.0 (`Helpers::Constants.min_macos_version_supported`); the generated codegen podspecs inherit it
   and `pod install` fails outright against a lower target.
8. **`AppDelegate.mm`, window title** — `RCTAppDelegate` titles the window after the registered
   module, so with the fix above the window said "main". The product name is set explicitly after
   `super`.

## macOS: run `pod install` after every dependency install

`npm ci` and `npm install` replace `node_modules`, and the macOS Pods project holds absolute paths
into it. Building without re-running `pod install` fails inside a dependency rather than at the
project level — the observed failure was
`SQLiteModule.swift: error: cannot find 'exsqlite3_open' in scope`, which reads like an expo-sqlite
bug and is not one. `cd apps/hermie/macos && pod install` and a clean build fix it.

iOS does not have this problem because `expo run:ios` reinstalls pods as part of its own flow.

## macOS: Expo module availability in SDK 54

Read from the podspecs in `node_modules`. A module is only linkable on macOS if its podspec declares
an `:osx` platform.

| Module                                                           | macOS      | Notes                                |
| ---------------------------------------------------------------- | ---------- | ------------------------------------ |
| `expo` / `ExpoModulesCore`                                       | yes (11.0) | the foundation is there              |
| `expo-asset`, `expo-font`, `expo-file-system`, `expo-keep-awake` | yes        | pulled in by `expo` itself           |
| `expo-constants`, `expo-manifests`, `expo-updates-interface`     | yes        |                                      |
| `expo-sqlite`                                                    | yes        | the chat cache can use it            |
| `expo-crypto`                                                    | yes        | PKCE can use it                      |
| `expo-web-browser`                                               | yes        |                                      |
| `expo-secure-store`                                              | **no**     | ios/tvos only                        |
| `expo-splash-screen`                                             | **no**     |                                      |
| `expo-system-ui`                                                 | **no**     |                                      |
| `expo-dev-client` and its dependencies                           | **no**     | no dev menu or dev launcher on macOS |
| `expo-json-utils`                                                | **no**     | a dependency of the dev-client stack |

These are listed in `EXPO_MODULES_WITHOUT_MACOS` in `apps/hermie/macos/Podfile`. Linking any of them
makes `pod install` fail, so the list is load-bearing and has to be re-checked on every SDK bump.

**The secure-store gap is the significant one.** There is no keystore-backed `SecretStore` on macOS.
`src/platform/secret-store.macos.ts` keeps values in memory for the session and mirrors them into
AsyncStorage, which is an unencrypted file in the app container. A macOS build is therefore a
development build; it should not be pointed at a production gateway. Closing this means either a
macOS-capable keychain library or a small native module of our own, and it is a prerequisite for
shipping macOS.

## macOS: third-party native modules

| Package                                           | macOS                            | Notes                                                                                                  |
| ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `react-native-webview` 13.15.0                    | yes                              | declares `:osx` and ships a `macos/` source directory                                                  |
| `@react-native-async-storage/async-storage` 2.2.0 | yes                              | declares `:osx`                                                                                        |
| `react-native-safe-area-context` 5.6.x            | podspec says yes, sources say no | it declares an `osx` deployment target but has no `macos/` source directory; the iOS sources are UIKit |
| `react-native-screens` 4.16.x                     | **no**                           | no `:osx` platform at all                                                                              |
| `@react-native-community/netinfo` 11.4.1          | podspec says yes, not linked     | its podspec declares `:osx`, but Expo's autolinking produces no macOS pod for it                       |

**react-native-screens has no macOS support**, which means `@react-navigation/native-stack` cannot be
used there. This is why the regular (sidebar plus detail) shell deliberately uses plain views instead
of a navigator, and why `Shell.macos.tsx` selects it unconditionally: the compact shell — and with it
the whole navigation stack — never enters the macOS bundle. `react-native.config.js` excludes both
packages from macOS autolinking.

Note that Expo's autolinking resolver does **not** honour `react-native.config.js` platform
exclusions: `react-native-safe-area-context` still ends up in `Podfile.lock` for macOS. It compiles,
so this is currently harmless, but the JavaScript side does not call it — `safe-area.macos.tsx`
returns zero insets, which is correct for a Mac window anyway.

The macOS bundle is 611 modules against 1009 for iOS, which is the difference these exclusions make.

## macOS: what M2 measured at runtime

The table above used to say "links and compiles" for three modules, which is a statement about
`pod install` and nothing else. Onboarding is the first feature that uses them, so they were measured
in the running macOS app on 2026-09-19 by evaluating expressions against it over Metro's inspector.

**`@react-native-community/netinfo` has no native module on macOS, and importing it is fatal.** The
app died on launch with `[runtime not ready]: Error: @react-native-community/netinfo:
NativeModule.RNCNetInfo is null`, before rendering anything. The package's podspec declares
`:osx => 10.14` and it ships a `macos/` directory, but that directory holds only a legacy
`.xcodeproj` and the podspec's `source_files` are `ios/**` — and in practice Expo's autolinking
resolver produces no entry for it at all, so `macos/Podfile.lock` has never contained it. The
package's JavaScript throws the moment it is imported, so a runtime `Platform.OS` check is too late:
the import itself has to be kept out of the bundle.

The fix follows the pattern the navigation libraries already use: `src/platform/net-info.ts` is the
seam, and `net-info.macos.ts` reports "always online" without importing the package. That is not a
loss of behaviour — the offline state exists to stop a phone burning battery on the dial ladder with
no signal, and a desktop losing its link is already covered by the connection's own reconnect ladder.
The package is also listed in `react-native.config.js` alongside the other macOS exclusions.

**`expo-crypto` works.** Not just linked: `expo.modules.ExpoCrypto.getRandomBase64String(16)`
returns real bytes in the running macOS app. PKCE therefore uses the same entropy source on macOS as
everywhere else. `src/platform/random.ts` still probes it once and falls back to the runtime's
`crypto.getRandomValues`, because a module that links is not a module that runs and the cost of
finding that out the hard way is a sign-in with a predictable verifier.

**`expo-secure-store` is confirmed absent.** The Expo module registry in the running macOS app lists
`ExpoFetchModule`, `ExpoCrypto`, `ExpoKeepAwake`, `ExpoAsset`, `ExpoWebBrowser`, `ExpoFontLoader`,
`ExpoModulesCoreJSLogger`, `ExponentConstants`, `ExponentFileSystem`, `ExpoFontUtils`, `FileSystem`
and `ExpoSQLite` — and no `ExpoSecureStore`. The AsyncStorage-backed shim in
`src/platform/secret-store.macos.ts` is load-bearing, and the warning above it stands: a macOS build
stores its tokens unencrypted and must not be pointed at a production gateway.

**`react-native-webview` is half-verified.** Its native module `RNCWebViewModule` is present in the
running macOS app, so the package's native side does load, and it is in `macos/Podfile.lock`. Whether
the view itself renders was **not** established: the onboarding screens could not be driven on macOS
from this environment, and the lazy view-manager registry gives no answer before a view is mounted.
`NativeSignInWebView` is therefore built so that the answer does not have to be known in advance — an
error boundary around the web view falls back to the system browser plus a pasted redirect, and that
fallback is also reachable deliberately from a link that is always visible while the web view is
open. The parser is shared, so the fallback is a text field rather than a second implementation.

## macOS runtime

Verified on 2026-09-19: the app launches, fetches its bundle from Metro over the `macos` platform and
renders the regular shell — sidebar with the section list, detail pane, and colours following the
system appearance (dark, in the run that was checked). Window title "Hermie".

Re-verified after onboarding landed, once the NetInfo crash above was fixed: a macOS build with no
stored gateway opens the setup wizard, in dark mode, with the form as a centred column capped at its
maximum width rather than stretched across the window.

The one runtime wrinkle worth knowing: a Debug build shows "Downloading 100%..." indefinitely if
Metro is not reachable at `localhost:8081`, with no error and no red box. Start Metro before
launching a Debug build.

## New architecture on macOS

`newArchEnabled` is `true` in `app.config.ts`, which covers iOS and Android. The macOS Podfile passes
`:fabric_enabled => ENV['RCT_NEW_ARCH_ENABLED'] == '1'`, so unless that variable is set the macOS
build uses the old architecture while the Fabric pods are still installed as part of React Native
core.

**Not verified:** whether Fabric actually works on react-native-macos 0.81, and whether the new
architecture-only libraries the plan holds back (Reanimated 4, FlashList 2, MMKV 3) can be adopted.
This needs its own spike before any of them is introduced.

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

`npx expo prebuild --platform android --no-install` succeeds. A Gradle build was **not** run: there is
no JDK on this machine (`java -version` reports no runtime), so `assembleDebug` could not be
attempted. The Android SDK is present at `~/Library/Android/sdk`. This is the largest untested gap in
the skeleton.
