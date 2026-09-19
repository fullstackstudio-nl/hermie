# Releasing Hermie

Two halves. The half a machine can do on its own — build the macOS app and an
Android APK, and publish them against a tag with the right CHANGELOG section —
is `.github/workflows/release.yml`. The half that needs an account someone owns
— TestFlight, Play internal testing, a Developer ID certificate — is written out
below, because it is done by hand until somebody decides otherwise.

## Version numbers

One number, written down in four places: the root `package.json`, the app's
`package.json`, `version` in `apps/hermie/app.config.ts`, and
`CFBundleShortVersionString` in the hand-maintained macOS `Info.plist`. Setting
them by hand is how three of them end up stale, so:

```sh
npm run set-version -- 0.2.0            # the marketing version
npm run set-version -- 0.2.0 --build 7  # and the build number
npm run set-version -- 0.2.0 --check    # report, change nothing
```

The script fails if a pattern stops matching rather than skipping the file. Read
the diff before committing it.

The build number is separate on purpose: App Store Connect and Play both refuse
a second upload with a build number they have already seen, and that happens on
a rhythm of its own. On iOS and Android EAS owns it — `production` has
`autoIncrement` set, so EAS raises it per build. On macOS it is
`CFBundleVersion`, and `--build` is how it moves.

`eas.json` sets `cli.appVersionSource` to **`local`**: the version EAS builds is
the one in `app.config.ts`, in the commit being built. The alternative,
`remote`, keeps it on EAS's servers, which is convenient for a team that
releases from a dashboard and wrong for a repository where the macOS project
cannot read it — with `remote`, the number in the macOS app and the number on
the phone drift apart with nothing to catch it. Local keeps the tag, the
CHANGELOG and all four platforms on the same number.

## Cutting a release

1. `main` is green: `npm run typecheck && npm run lint && npm run format && npm test && npm run test:app`.
2. Turn `## [Unreleased]` in `CHANGELOG.md` into `## [0.2.0] - YYYY-MM-DD`, and open a
   fresh empty `Unreleased` above it. Add the link definition at the foot of the
   file. Check what the release notes will say:
   ```sh
   node scripts/changelog-section.mjs 0.2.0
   ```
3. `npm run set-version -- 0.2.0`.
4. Commit (`chore(release): 0.2.0`), tag, push:
   ```sh
   git tag v0.2.0
   git push origin main v0.2.0
   ```
5. The tag triggers two workflows. `ci.yml` runs the checks and the three native
   builds; `release.yml` builds the macOS app and the Android APK, and publishes
   a GitHub release with them attached and the CHANGELOG section as its notes.
6. Then the store halves, below.

A release can also be rehearsed without a tag: run **Release** from the Actions
tab. It builds and uploads both artefacts and skips the publish step.

## What the automated release produces

| Artefact                   | What it is                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| `Hermie-macos.zip`         | The macOS app. Signed and notarised when the secrets are set, unsigned when not. |
| `Hermie-android-debug.apk` | A debug-signed APK, installable on any device with unknown sources allowed.      |

The Android artefact is a **debug** build on purpose: a release APK needs an
upload key this workflow does not have, and an unsigned one cannot be installed
at all. The Play artefact comes from EAS instead.

## Secrets

All of these are repository secrets in GitHub → Settings → Secrets and variables
→ Actions. Every one of them is optional: with none set, the release workflow
still produces working unsigned artefacts, which is what a fork gets.

| Secret                        | Used for                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`       | Base64 of the Developer ID Application certificate and key |
| `MACOS_CERTIFICATE_PASSWORD`  | The password on that .p12                                  |
| `APPLE_ID`                    | The Apple ID that submits to the notary service            |
| `APPLE_TEAM_ID`               | The ten-character team identifier                          |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID                 |
| `EXPO_TOKEN`                  | An EAS access token, if EAS builds are ever moved into CI  |

The workflow reads them once into step outputs, because a step's `if:` cannot
see the `secrets` context. Missing certificate secrets mean an unsigned build;
missing notarisation secrets mean a signed but un-notarised one. Both say so in
the job's annotations rather than failing.

## macOS: signing and notarisation

Needed because macOS refuses to open a downloaded app that is neither signed nor
notarised without the user going through Gatekeeper by hand — which is exactly
the kind of instruction nobody should be following.

**Once, to set the secrets up:**

1. In the Apple Developer account, create a **Developer ID Application**
   certificate and install it in the login keychain.
2. Export it from Keychain Access as a .p12, with a password, including the
   private key. Then:
   ```sh
   base64 -i DeveloperID.p12 | pbcopy
   ```
   Paste that into `MACOS_CERTIFICATE_P12`, and the export password into
   `MACOS_CERTIFICATE_PASSWORD`.
3. At appleid.apple.com, create an app-specific password for the Apple ID that
   will submit to the notary service. That is `APPLE_APP_SPECIFIC_PASSWORD`;
   `APPLE_ID` is the address itself.
4. The team identifier is in the Apple Developer membership page.
   `APPLE_TEAM_ID`.

**What the workflow then does**, and what to run locally to reproduce it:

```sh
cd apps/hermie/macos
pod install
xcodebuild -workspace Hermie.xcworkspace -scheme Hermie-macOS \
  -configuration Release -derivedDataPath build/DerivedData \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY='Developer ID Application' \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  OTHER_CODE_SIGN_FLAGS='--timestamp --options runtime' \
  build

ditto -c -k --sequesterRsrc --keepParent \
  build/DerivedData/Build/Products/Release/Hermie.app Hermie-macos.zip

xcrun notarytool submit Hermie-macos.zip \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait

xcrun stapler staple build/DerivedData/Build/Products/Release/Hermie.app
# and rebuild the zip from the stapled bundle, or the download still warns
```

Three things bite here:

- **`--options runtime`.** Without the hardened runtime the notary service
  rejects the submission, with a report that does not obviously say so.
- **`ditto`, not `zip`.** A `.app` is a bundle of symlinks; a plain zip of one
  arrives at the notary service broken.
- **Staple, then repackage.** The ticket is attached to the app, not to the
  archive that was submitted. A zip made before stapling still makes the user
  click through a warning.

Release must be used rather than Debug: only the Release configuration runs the
build phase that bundles the JavaScript into the app. A Debug product needs a
Metro server to start at all.

If `notarytool` rejects a submission, `xcrun notarytool log <submission-id>`
with the same credentials prints the reason per binary.

## iOS: TestFlight

Not in CI. It needs an EAS project, which ties the repository to one Expo
account — `extra.eas.projectId` is deliberately absent from `app.config.ts` so
that a fork gets its own rather than inheriting ours.

```sh
npm i -g eas-cli
eas login
cd apps/hermie
eas init                     # writes extra.eas.projectId; commit it
eas build --platform ios --profile production
eas submit --platform ios --latest
```

`eas build` asks for the Apple credentials the first time and keeps them. The
`production` profile has `autoIncrement` on, so the build number rises per
build; the marketing version is whatever `set-version` put in `app.config.ts`.

For a build on somebody's device before that, `preview` is an internal
distribution build; for a build that runs on a simulator, `development`.

## Android: Play internal testing

Same shape:

```sh
cd apps/hermie
eas build --platform android --profile production      # an .aab
eas submit --platform android --latest --track internal
```

`eas submit` needs a Google Play service-account key the first time. The
`production` profile builds an app bundle because that is what Play takes;
`preview` builds an APK, which is what a person can sideload.

## Before the first store submission

Things that are fine for a source build and not for a store listing. None of
them block a tagged GitHub release.

- **`expo-dev-client` is in the plugin list**, which puts
  `SYSTEM_ALERT_WINDOW` in the Android manifest. Play asks about that
  permission. Move the plugin behind a condition on the EAS profile, or accept
  the question and answer it.
- **macOS has no keystore-backed secret store.** `SECURITY.md` and
  `docs/platform-notes.md` both say so. A macOS download is a development build
  until that is fixed.
- **Privacy answers.** App Store Connect and the Play data-safety form both ask
  what leaves the device. Hermie sends what the user types to the gateway the
  user configured, and to nothing else; there is no analytics SDK and no
  third-party network call in the app.
- **`ITSAppUsesNonExemptEncryption` is already `false`** in `app.config.ts`, so
  the export-compliance question does not come back on every upload.

## The icons

`design/icon.svg` is the source. Everything the app ships — the iOS and Android
icons, the adaptive foreground, the splash image, the favicon and the macOS
asset catalogue — is rasterised from it:

```sh
npm run icons          # rewrite them
npm run icons:check    # fail if any of them is stale (CI runs this)
```

Changing the artwork means editing the SVG and running `npm run icons`, never
editing a PNG. The renderer is deterministic, which is what makes the check
meaningful.
