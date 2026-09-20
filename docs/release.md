# Releasing Hermie

Two halves. The half a machine can do on its own — build an Android APK and
publish it against a tag with the right CHANGELOG section — is
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
because nothing generated them. Both are gone. The build number belongs to EAS —
the `production` profile has `autoIncrement` set, so it rises per build — which is
the right rhythm anyway: App Store Connect and Play both refuse a second upload
with a number they have already seen.

`eas.json` sets `cli.appVersionSource` to **`local`**: the version EAS builds is
the one in `app.config.ts`, in the commit being built. The alternative,
`remote`, keeps it on EAS's servers, which is convenient for a team that
releases from a dashboard and wrong for a repository where the tag is the record:
with `remote`, the number EAS builds and the number in the commit drift apart with
nothing to catch it. Local keeps the tag, the CHANGELOG and every platform on the
same number.

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
5. The tag triggers two workflows. `ci.yml` runs the checks and both native
   builds; `release.yml` builds the Android APK and publishes a GitHub release
   with it attached and the CHANGELOG section as its notes.
6. Then the store halves, below.

A release can also be rehearsed without a tag: run **Release** from the Actions
tab. It builds and uploads the artefact and skips the publish step.

## What the automated release produces

| Artefact                   | What it is                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `Hermie-android-debug.apk` | A debug-signed APK, installable on any device with unknown sources allowed. |

It is a **debug** build on purpose: a release APK needs an upload key this
workflow does not have, and an unsigned one cannot be installed at all. The Play
artefact comes from EAS instead.

There is no iOS or Mac artefact here, and there cannot be a useful one: an iOS app
that anybody can install has to be signed by a real Apple Developer team, which is
what TestFlight and the App Store are for.

## Secrets

All of these are repository secrets in GitHub → Settings → Secrets and variables
→ Actions. Every one of them is optional: with none set, the release workflow
still produces working unsigned artefacts, which is what a fork gets.

| Secret       | Used for                                                  |
| ------------ | --------------------------------------------------------- |
| `EXPO_TOKEN` | An EAS access token, if EAS builds are ever moved into CI |

That is the whole list now. The Developer ID certificate, its password, the notary
service Apple ID and its app-specific password were all for the macOS `.app`, and
that artefact no longer exists — a Mac user installs from TestFlight or the App
Store, where EAS holds the credentials.

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

**This is also the Mac release.** Check App Store Connect → Pricing and
Availability and leave "Make this app available on Mac" on; a TestFlight tester on
an Apple Silicon Mac then installs the same build. Nothing else is needed, and
nothing here is Mac-specific.

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
- **The Mac build has not been exercised at runtime.** The keychain, Return-to-send
  and the missing status-bar strip are all reasoned from source and unverified in a
  window. `docs/platform-notes.md` lists them; verify them before the listing says
  the app runs on a Mac.
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
