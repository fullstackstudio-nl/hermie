# hermie-mac

One boolean: is this build of the iOS app running on an Apple Silicon Mac as "Designed for iPad"?

`ProcessInfo.processInfo.isiOSAppOnMac` is the only answer Apple gives, and React Native does not
expose it. `Platform.isMacCatalyst` is a different question — it reads `TARGET_OS_MACCATALYST`, a
compile-time flag that is false for an unmodified iOS binary running on a Mac, which is exactly what
Hermie ships (see `docs/adr/0011-mac-via-the-ipad-build.md`).

The module is Apple-only on purpose. `expo-module.config.json` declares no Android platform, so
autolinking never offers it there, and the JavaScript side
(`apps/hermie/src/platform/runs-on-mac.ts`) asks for it with `requireOptionalNativeModule` and reads
`false` when it is absent. That covers Android, the web and the Jest environment without a second
implementation of a constant that can only ever be `false` on them.

It is a local module under `apps/hermie/modules/`, which Expo's autolinking scans by default, so
`ios/` stays fully generated and nothing has to be edited there by hand.
