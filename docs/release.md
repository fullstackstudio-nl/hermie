# Releasing Hermie

Two halves. The half a machine can do on its own — build the Android artefacts and
publish them against a tag with the right CHANGELOG section — is
`.github/workflows/release.yml`. The half that needs an account someone owns —
TestFlight and Play internal testing — is written out below, because it is done by
hand until somebody decides otherwise.

**The Mac is not a third release.** Since
[ADR-0011](adr/0011-mac-via-the-ipad-build.md) it is the iOS build, and Apple
offers an iPhone/iPad app on Apple Silicon Macs from the same App Store listing
unless it is opted out under **App Store Connect → the app → Pricing and
Availability**. A TestFlight tester on a Mac installs the same build the same way.
So there is nothing Mac-specific to build, sign, notarise or upload; `npm run mac`
exists for developing, not for releasing.

## Version numbers

One number, written down in three places: the root `package.json`, the app's
`package.json`, and `version` in `apps/hermie/app.config.ts`. Setting them by hand
is how two of them end up stale, so:

```sh
npm run set-version -- 0.2.0            # the marketing version
npm run set-version -- 0.2.0 --check    # report, change nothing
```

The script fails if a pattern stops matching rather than skipping the file. Read
the diff before committing it.

There used to be a fourth place and a `--build` flag for it: the hand-maintained
macOS `Info.plist` carried both the marketing version and `CFBundleVersion`,
because nothing generated them. Both are gone.

### The build number comes from git, and so does the commit in Settings

`app.config.ts` reads two things from git when the config is evaluated:

| `extra.commit`      | `git rev-parse --short HEAD` | `dev` when there is no git |
| ------------------- | ---------------------------- | -------------------------- |
| `extra.buildNumber` | `git rev-list --count HEAD`  | `1` when there is no git   |

`ios.buildNumber` and `android.versionCode` are both derived from
`extra.buildNumber`, so the three can never disagree, and the commit count is the
only monotonic number a git history hands out for free — which is exactly what
App Store Connect and Play want, since both refuse a second upload with a number
they have already seen. Settings shows all three as one line,
`Hermie 0.1.0 (68) · 79ad86d`, so a screenshot names the tree it came from.

Two consequences worth knowing. **A shallow clone lies**: `rev-list --count` on
`fetch-depth: 1` answers `1`, so any CI job that produces an uploadable build
needs the full history (`fetch-depth: 0`). And **neither call may fail the
build** — both are wrapped, and a checkout with no git simply gets the defaults.

EAS still has `autoIncrement` on the `production` profile; where it applies it
wins over the value above, and the two agree on direction either way.

`eas.json` sets `cli.appVersionSource` to **`local`**: the version EAS builds is
the one in `app.config.ts`, in the commit being built. The alternative,
`remote`, keeps it on EAS's servers, which is convenient for a team that
releases from a dashboard and wrong for a repository where the tag is the record:
with `remote`, the number EAS builds and the number in the commit drift apart with
nothing to catch it. Local keeps the tag, the CHANGELOG and every platform on the
same number.

## Cutting a release

1. `main` is green: `npm run typecheck && npm run lint && npm run format && npm test && npm run test:app`,
   and `npm run web:build` exports.
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
5. The tag triggers two workflows. `ci.yml` runs the checks and both native
   builds; `release.yml` builds the Android artefacts and publishes a GitHub
   release with them attached and the CHANGELOG section as its notes.
6. Then the store halves, below.

A release can also be rehearsed without a tag: run **Release** from the Actions
tab. It builds and uploads the artefact and skips the publish step.

## What the automated release produces

| Artefact                     | What it is                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `Hermie-android-debug.apk`   | A debug-signed APK, installable on any device with unknown sources allowed. |
| `Hermie-android-release.apk` | Signed with the upload key — only when the signing secrets below are set.   |
| `Hermie-android-release.aab` | The app bundle Play takes — only when the signing secrets below are set.    |
| `hermie-web.zip`             | Hermie Web: the compiled server, the exported browser bundle and its bin.   |
| `SHA256SUMS`                 | Digests of everything above, generated from what actually reached the job.  |

The debug APK is built unconditionally, and it is a **debug** build on purpose:
an unsigned APK cannot be installed at all, so a fork with no key still gets
something a person can put on a phone. The two release artefacts appear only when
the four secrets are there; without them the job builds the debug APK and nothing
fails.

`hermie-web.zip` is the whole web variant and needs no signing: it is a Node
package with no runtime dependencies, which is why the zip carries no
`node_modules` and the install instructions' `npm ci --omit=dev` is a no-op
today. `SHA256SUMS` is not decoration — a running Hermie Web refuses to install a
self-update the file does not list, and refuses bytes whose digest does not match
(ADR-0015). It is generated from the artefact directory rather than written by
hand, so an artefact that failed to build cannot quietly pass unverified.

There is no iOS or Mac artefact here, and there cannot be a useful one: an iOS app
that anybody can install has to be signed by a real Apple Developer team, which is
what TestFlight and the App Store are for.

## Secrets

All of these are repository secrets in GitHub → Settings → Secrets and variables
→ Actions. Every one of them is optional: with none set, the release workflow
still produces a working debug-signed APK, which is what a fork gets.

| Secret                          | Used for                                                  |
| ------------------------------- | --------------------------------------------------------- |
| `EXPO_TOKEN`                    | An EAS access token, if EAS builds are ever moved into CI |
| `HERMIE_UPLOAD_KEYSTORE_BASE64` | The upload keystore itself, `base64 -i hermie-upload.jks` |
| `HERMIE_UPLOAD_STORE_PASSWORD`  | Its store password                                        |
| `HERMIE_UPLOAD_KEY_ALIAS`       | `hermie-upload`                                           |
| `HERMIE_UPLOAD_KEY_PASSWORD`    | The key's own password                                    |

The four Android ones are read as a group: `release.yml` checks whether the
keystore secret is empty and skips the signed build when it is, the way the macOS
Developer ID signing used to be guarded. The job decodes the keystore into
`$RUNNER_TEMP` — never the workspace, where an `upload-artifact` glob could reach
it — passes the other three as `ORG_GRADLE_PROJECT_HERMIE_UPLOAD_*` environment
variables, which is how Gradle takes a project property from the environment, and
deletes the file in an `if: always()` step.

**Do not quote the secret values.** They arrive as Gradle properties, and a
properties file does not strip quotes, so `"secret"` is a password with two quote
characters in it. That failure surfaces as a `BadPaddingException` from deep inside
AGP; the config plugin checks the keystore up front and says so instead.

The Developer ID certificate, its password, the notary service Apple ID and its
app-specific password were all for the macOS `.app`, and that artefact no longer
exists — a Mac user installs from TestFlight or the App Store, where EAS holds the
credentials.

## The application identifier

`dev.hermie.app` — `ios.bundleIdentifier` and `android.package` in
`apps/hermie/app.config.ts`, and the keychain access group that follows from it. It
used to be `nl.fullstackstudio.hermie`, an App ID stuck in a personal Apple team that
cannot be moved to the paid one; nothing had ever been uploaded under it, so renaming
it cost nothing but a prebuild. A build made before the change keeps its own data: the
identifier is the container, so an installed copy is a different app to the system and
has to be signed in again once.

## The accounts, and what is still owed on each

Both halves of the store release used to be blocked on an account with a payment
behind it. Neither is any more. What is left is one irreversible step and one thing
this repository cannot answer. Written down here so the next reader does not spend
an afternoon rediscovering it.

- **The paid Apple Developer team exists**: team id `FDGV4X8F27`, which is what
  `HERMIE_APPLE_TEAM_ID` should name. It buys more than the listing. A free Apple ID
  signs an app with a **7-day** provisioning profile, so a build installed on a device
  or on a Mac stops launching a week later and has to be rebuilt; a paid team's
  profiles last a **year**. `npm run mac` works either way — it takes whatever
  `HERMIE_APPLE_TEAM_ID` names — which is why a Mac build made against a free team
  still "breaks" after a week for no other reason.
  A Mac that has never built this app also has to be added to the team's device
  list first, and `-allowProvisioningUpdates` alone will not do it: it renews
  profiles for devices the team already knows, and for a new one automatic
  signing fails with "doesn't include the currently selected device".
  `npm run mac` therefore passes `-allowProvisioningDeviceRegistration` as well,
  so a fresh machine registers itself on its first build instead of sending
  somebody to the developer portal.
- **The Android upload keystore exists.** A signed APK and app bundle build today —
  done on 2026-09-21; see the Android section below and the end of
  `docs/platform-notes.md`.
- **Play App Signing is reported on for the app.** It is a Play Console setting, so
  nothing in this repository can show it and this line records what the owner said
  rather than something checked here. Follow what it implies, though: App Signing is
  configured per app inside a Play Console account, so if it is on, that account and
  an app entry already exist. The repository says nothing either way — `eas.json` has
  an empty `submit.production` and no Play service-account key is referenced anywhere
  — so the state of the Console account is **unverified here**. Confirm it with the
  owner instead of inferring it from this bullet or the one below.
- **Registering the upload key with Play has not happened**, as far as anything here
  records. It happens once per app and **cannot be undone**: the key registered first
  is the key every later upload has to be signed with, for the life of the listing.
  It is the one step in this document worth stopping to check before doing — and the
  check is with the owner, in the Console, not in this repository.
- **An Expo project exists** and `extra.eas.projectId` in `app.config.ts` names it. It
  is there for push: a device needs it to obtain a push token and the push credentials
  live on it ([ADR-0017](adr/0017-push-through-hermie-web.md)). Nothing is built or
  served through it.

Neither the keystore nor the Apple team belongs in this repository. The keystore is
a secret and the Apple team is an account, so both live with the owner; nothing here
should ever hold either.

## iOS: TestFlight

Not in CI. It needs an EAS project, which ties the repository to one Expo account.
`extra.eas.projectId` **is** in `app.config.ts` now — it was added for push, which
needs a project to mint a token against ([ADR-0017](adr/0017-push-through-hermie-web.md))
— so it names ours. A fork should run `eas init` and replace it rather than inherit it.

```sh
npm i -g eas-cli
eas login
cd apps/hermie
eas init                     # a fork: replaces extra.eas.projectId with its own
eas build --platform ios --profile production
eas submit --platform ios --latest
```

`eas build` asks for the Apple credentials the first time and keeps them. The
`production` profile has `autoIncrement` on, so the build number rises per
build; the marketing version is whatever `set-version` put in `app.config.ts`.

For a build on somebody's device before that, `preview` is an internal
distribution build; for a build that runs on a simulator, `development`.

**This is also the Mac release.** Check App Store Connect → Pricing and
Availability and leave "Make this app available on Mac" on; a TestFlight tester on
an Apple Silicon Mac then installs the same build. Nothing else is needed, and
nothing here is Mac-specific.

## Android: the upload key

There are two keys in an Android release and conflating them is the usual
confusion. **Play App Signing** means Google holds the key that signs what users
download; it is generated by Play and nobody here ever sees it. The **upload key**
is ours, and it only proves to Play that an upload came from us. Play will not
accept an upload signed by a key it has not seen registered, and that registration
happens once per app and cannot be undone — so this key has to be kept, and losing
it means asking Play support to reset it.

The keystore lives **with the owner, outside every checkout**, and nothing in this
repository ever holds it, names it or logs it. Its location and its passwords are
four Gradle properties in `~/.gradle/gradle.properties`, which is outside the build
tree and is not read by anything here except Gradle:

```properties
HERMIE_UPLOAD_STORE_FILE=/absolute/path/to/hermie-upload.jks
HERMIE_UPLOAD_STORE_PASSWORD=…
HERMIE_UPLOAD_KEY_ALIAS=hermie-upload
HERMIE_UPLOAD_KEY_PASSWORD=…
```

**Do not put quotes round the values.** A Gradle properties file does not strip
them, so `"secret"` is a password with two quote characters in it, and the failure
arrives as `UnrecoverableKeyException: BadPaddingException` from inside AGP with
nothing pointing at the cause. The path may contain spaces and needs no quoting or
escaping either: it reaches `file()` as one string. `apps/hermie/plugins/with-android-release-signing.js`
opens the keystore before the build starts and says both of these in its error.

The same four can come from the environment instead, which is what CI uses — see
Secrets above.

### Building them

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
npm run android:release                 # prebuild if needed, then .aab and .apk
npm run android:release -- --clean      # regenerate android/ first
npm run android:release -- --aab        # the bundle only
```

It prints where the artefacts landed and how big they are. They are
`apps/hermie/android/app/build/outputs/bundle/release/app-release.aab` and
`.../apk/release/app-release.apk`.

**Which key signed a build is in the log**, on the one line beginning `hermie:` —
either the upload key with its alias, or a note that release kept the template's
debug signing because the four values are not all there. That fallback is
deliberate: a fork, and CI without secrets, still build a release. It also means a
missing property produces a **debug-signed release APK**, which installs perfectly
and is refused by Play, so check the line rather than assuming.

To confirm an artefact before uploading, compare its certificate with the
keystore's. The fingerprint is public; the key never leaves the keystore:

```sh
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs app-release.apk
keytool -printcert -jarfile app-release.aab
keytool -list -v -keystore /path/to/hermie-upload.jks -alias hermie-upload
```

All three print the same SHA-256 when the upload key signed it. A build that fell
back to debug signing says `CN=Android Debug` instead, which is the tell.

## Android: Play internal testing

Same shape as iOS:

```sh
cd apps/hermie
eas build --platform android --profile production      # an .aab
eas submit --platform android --latest --track internal
```

`eas submit` needs a Google Play service-account key the first time. The
`production` profile builds an app bundle because that is what Play takes;
`preview` builds an APK, which is what a person can sideload.

**EAS is the alternative to the keystore above, not a companion to it.** `eas build`
manages credentials itself: it will generate an upload keystore and keep it on
Expo's servers, or take yours with `eas credentials`. Either way the key is then in
two places, and which one signed a given upload is worth knowing before Play
rejects one. Pick one — the local properties for builds from this machine and from
CI, EAS if releases move to EAS entirely — and if both are in use, make sure both
hold the _same_ upload key.
The listing's images are in the repository:
[design/store/screenshots/](../design/store/screenshots/) holds a phone set at
1080×1920 and 10" and 7" tablet sets at 2560×1600 and 1920×1200, which is the
three sections Play asks for.
[design/store/README.md](../design/store/README.md) says what each one shows and
how to make them again — including the trap that a 1080×2400 phone capture is
2.22:1 and Play refuses anything wider than 2:1. **There is no iOS set**, so App
Store Connect still needs its screenshots made by hand.

## Before the first store submission

Things that are fine for a source build and not for a store listing. None of
them block a tagged GitHub release.

- **`expo-dev-client` is in the plugin list**, which puts
  `SYSTEM_ALERT_WINDOW` in the Android manifest. Play asks about that
  permission. Move the plugin behind a condition on the EAS profile, or accept
  the question and answer it.
- **The Mac build has been exercised in a real window**, so this is no longer the
  blocker it was. The three things named here before — the keychain, Return-to-send
  and the empty strip under the title bar — were all used by hand on 2026-09-19 and
  are answered in `docs/platform-notes.md`. Two smaller Mac questions are still open
  in that file's summary table: what `AppState` a Mac window reports, and whether a
  mouse drag still scrolls a list now the fix is in. Read the table before the
  listing claims anything specific about the Mac.
- **The accounts above.** The paid Apple team and the Android upload keystore both
  exist, so neither blocks a submission any more. What is left out of that section is
  registering the upload key with Play — once per app, irreversible — and confirming
  a Play Console account, which nothing in this repository can show.
- **Privacy answers.** App Store Connect and the Play data-safety form both ask
  what leaves the device. Hermie sends what the user types to the gateway the
  user configured, and to nothing else; there is no analytics SDK and no
  third-party network call in the app.
- **`ITSAppUsesNonExemptEncryption` is already `false`** in `app.config.ts`, so
  the export-compliance question does not come back on every upload.
- **The App Transport Security exception needs a review note.** See below; it is
  the one thing in this list that a reviewer will actively ask about.

## The App Transport Security note for App Review

`app.config.ts` sets `NSAllowsArbitraryLoads`, and only that key — see ADR-0014 for why adding a
second one switches the first off. Apple asks for a justification whenever a
submission lowers ATS, and the answer has to be in **App Store Connect → the
version → App Review Information → Notes**. Paste this, or something that says
the same thing:

> Hermie is a client for Hermes Agent, a server the user runs themselves. The
> server's address is typed by the user during setup and is not known at build
> time, so a per-domain `NSExceptionDomains` entry cannot be written for it. The
> common deployment is a private VPN — Tailscale or a self-hosted Headscale —
> where the gateway is served over plain HTTP on a tailnet name such as
> `host.tailnet.ts.net`, because WireGuard has already encrypted the path.
> `NSAllowsLocalNetworking` does not cover that case: a MagicDNS name is fully
> qualified, so ATS treats it as an ordinary internet host. The app talks to that
> one user-configured server and to the identity provider it redirects the
> sign-in page to, and to nothing else; it contains no analytics or advertising
> SDK. The app defaults to `https://` when the user types no scheme, only tries
> `http://` when `https://` does not answer at all, never downgrades an address
> the user typed `https://` on, and tells the user when the connection is in the
> clear — with a warning when the address is not on a private network.

[ADR-0014](adr/0014-plain-http-on-private-networks.md) records what was measured
and which narrower options were ruled out, which is the material to draw on if a
reviewer comes back with a follow-up.

Android needs no note. `usesCleartextTraffic` is set through
`expo-build-properties` and Play does not ask about it.

## The icons

`design/icon.svg` is the source. Everything the app ships — the iOS and Android
icons, the adaptive foreground, the splash image and the favicon — is rasterised
from it:

```sh
npm run icons          # rewrite them
npm run icons:check    # fail if any of them is stale (CI runs this)
```

Changing the artwork means editing the SVG and running `npm run icons`, never
editing a PNG. The renderer is deterministic, which is what makes the check
meaningful.

## The Play listing's images

A listing asks for two images the app itself never ships. They live in
`design/store/`, and the same two commands produce and check them — `npm run
icons` runs `scripts/generate-store-assets.mjs` after the app's icons, and
`npm run icons:check` is what CI runs against both.

| File                               | Size       | Where it goes                                 |
| ---------------------------------- | ---------- | --------------------------------------------- |
| `design/store/feature-graphic.png` | 1024 x 500 | The banner across the top of the Play listing |
| `design/store/play-icon-512.png`   | 512 x 512  | The listing's app icon                        |

Both are written with **no alpha channel** — PNG colour type 2, three bytes per
pixel — and with no metadata chunk of any kind. Play refuses a feature graphic
that carries transparency, and the pair come to about 16 kB and 9 kB against a
limit of 1 MB, so neither is anywhere near being too large.

The 512 icon is `design/icon.svg` again, at the one size Play takes, with the
**corners left square**: Play rounds and masks the icon itself, exactly as iOS
and Android do, so a radius baked in here would show as a second one inside the
store's.

The feature graphic's source is `design/store/feature-graphic.svg`, hand-drawn
at 1024 x 500 and rasterised 1:1. It is the mark from `design/icon.svg` at half
scale beside the wordmark, on the icon's own gradient. Two things about that file
are worth knowing before editing it, and its own header comment says both at
length: the renderer **has no font engine**, so "Hermie" is drawn as geometry —
circles, stems and two radial cuts on one set of metrics — rather than set in a
typeface; and a counter is a shape filled with the _same_ gradient painted over
the letter, which lands on exactly the colour underneath because gradients are
evaluated in user space.

It carries the lockup and nothing else. A tagline is the obvious addition and is
deliberately absent: Play crops this image at several aspect ratios, and a line
of copy in it would have to be re-drawn by hand — there is no font engine — for
every language the listing is ever offered in.

The listing also wants screenshots. Those are not generated: `docs/screenshots/`
is what exists, and CONTRIBUTING's "Screenshots" section is the rule for them.
