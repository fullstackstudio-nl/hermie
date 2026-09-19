# Contributing to Hermie

Thanks for taking the time. This document covers the toolchain, the checks that have to pass, and
the conventions that are easy to get wrong.

## What you need installed

| Tool        | Version                                 | Needed for           |
| ----------- | --------------------------------------- | -------------------- |
| Node        | 22 or newer (`.nvmrc` pins the minimum) | everything           |
| npm         | 10 or newer                             | workspaces           |
| Xcode       | 16.1 or newer                           | iOS and macOS builds |
| CocoaPods   | 1.15 or newer                           | iOS and macOS pods   |
| JDK         | 17                                      | Android builds       |
| Android SDK | platform 35, build-tools 35             | Android builds       |

Set `ANDROID_HOME` to your SDK location (usually `~/Library/Android/sdk` on macOS) before building
for Android.

## Getting set up

```sh
nvm use
npm ci
```

`npm ci` installs the husky hooks through the `prepare` script. If you cloned without a git
repository the hook install is skipped, which is fine.

## The checks

Everything below runs in CI on every pull request, and you can run it locally in the same order:

```sh
npm run typecheck              # tsc -b across all workspace projects
npm run lint                   # eslint
npm run format                 # prettier --check
npm test                       # vitest: the workspace packages
npm run test:app               # jest-expo: the app
npm run sync:hermes-shared:check   # drift check on the vendored protocol sources
```

`npm run format:write` and `npm run lint:fix` apply the automatic fixes.

## Running the app

```sh
npm run ios
npm run android
npm run macos
```

The Metro bundler is shared: `npm run start --workspace @hermie/app` starts it once and serves iOS,
Android and macOS. macOS uses the `macos` platform, which is configured in
`apps/hermie/metro.config.js`.

## The fake gateway

`packages/fake-gateway` stands in for `hermes serve`. It speaks the public status endpoints, both
authentication flows, the native PKCE round trip, single-use WebSocket tickets and the JSON-RPC
surface the app calls, with two scripted bots.

```sh
npm run fake-gateway                       # port 9119, no authentication
npm run fake-gateway -- --auth token       # session-token gateway; prints the token
npm run fake-gateway -- --auth native      # gated: PKCE sign-in and WebSocket tickets
npm run fake-gateway -- --port 9200 --close-code 4403 --scenario ./replies.json
```

```sh
curl localhost:9119/api/status
```

In `--auth native` the authorize page renders an "Approve as tester" button; adding `?auto=1` to the
authorize URL redirects straight to the loopback callback, which is what the tests use. A scenario
file is `{ "replies": [{ "match": "...", "deltas": ["..."], "tool": { "name": "...", "result": "..." } }] }`.

The same server is importable, so tests drive it in-process:

```ts
import { startFakeGateway } from '@hermie/fake-gateway'

const gateway = await startFakeGateway({ auth: 'token' })
gateway.closeSockets(4403) // or dropSockets() for an abrupt 1006
```

From the app, Settings → **Connection test** is a developer screen that probes an address and opens
a real connection to it in session-token mode. On an Android emulator the host machine is
`http://10.0.2.2:9119`, never `localhost`.

To work against a real gateway, [docs/test-gateway.md](docs/test-gateway.md) sets one up from
scratch.

## Native projects

- `apps/hermie/ios` and `apps/hermie/android` are **generated**. They are not committed. Change
  `apps/hermie/app.config.ts` or a config plugin under `apps/hermie/plugins/`, never the generated
  files — `npx expo prebuild --clean` will throw your edits away.
- `apps/hermie/macos` is **committed and maintained by hand**. It came from the react-native-macos
  template and has been adapted; `docs/platform-notes.md` records what was changed and why. Keep
  changes there small and explain them in the commit message.

## Vendored protocol sources

`packages/hermes-shared` holds files copied from NousResearch/hermes-agent at a pinned commit. Do
not edit them directly — ESLint and Prettier skip the directory, and
`npm run sync:hermes-shared:check` fails on any difference.

The pin and the file list live in `packages/hermes-shared/upstream.json`; the rewrites live in
`scripts/sync-hermes-shared.mjs`. To take a newer upstream commit: bump `commit`, run
`npm run sync:hermes-shared`, read the diff, run `npm test`. Both sync modes fetch from
`raw.githubusercontent.com`, so they need network access.

A rewrite marked required that stops matching fails the sync loudly rather than producing a file
that silently no longer works. When that happens, read the upstream file before touching the
pattern. [packages/hermes-shared/README.md](packages/hermes-shared/README.md) documents each
rewrite and why it exists.

## Screenshots

`docs/screenshots/` is what the README shows, so treat it as published material.

- **Fixture data only.** The bots in those images are the fake gateway's Researcher and Writer, with
  its scripted commands and transcripts. No real gateway address, no real bot, no real conversation,
  and nothing that names a person.
- **Strip the metadata.** A screenshot carries EXIF and XMP that nobody looks at and everybody
  publishes. Remove it before committing.
- **Say what is in the picture.** Every image in the README has alt text that describes the screen,
  not the file.

## Releasing

[docs/release.md](docs/release.md) is the process: the version numbers and the script that sets all
four of them, what a `v*` tag sets off, the secrets the macOS signing and notarisation steps look
for, and the TestFlight and Play steps that are still done by hand.

The icons are generated, not drawn per size. `design/icon.svg` is the source; `npm run icons`
rewrites every PNG from it and `npm run icons:check` — which CI runs — fails if one of them has
drifted. Never edit a PNG in `apps/hermie/assets` or the macOS asset catalogue directly.

## Commits

Conventional commits, in the imperative, in English:

```
feat(chats): resume the canonical session on connect
fix(gateway-client): mint a fresh ticket for every dial
docs(adr): record why macOS goes through react-native-macos
chore(deps): move to Expo SDK 54.0.37
```

Common types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`.
`commitlint` enforces the format in a `commit-msg` hook.

Two rules beyond the format, enforced by `scripts/check-commit-message.mjs` in the same hook and
over the whole branch in CI:

- **No trailers.** `Co-Authored-By:` and `Signed-off-by:` are rejected. Authorship is the commit
  author field; if a change genuinely has two authors, say so in the body in prose.
- **No tooling boilerplate.** Phrases like "generated with" or "generated by" are rejected. A commit
  message explains the change, not how it was typed.

To check a branch before opening a pull request:

```sh
node scripts/check-no-trailers.mjs origin/main..HEAD
```

## Pull requests

Keep them scoped to one thing. Fill in the template: what changed, why, and how you verified it.
State plainly which platforms you actually built and ran — "not verified on Android" is useful
information and nobody will hold it against you.
