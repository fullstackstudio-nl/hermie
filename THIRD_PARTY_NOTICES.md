# Third-party notices

Hermie is distributed under the MIT licence (see [LICENSE](LICENSE)). It includes and depends on
third-party software that carries its own terms. This file lists the code that is **copied into**
this repository. Software that is merely installed from npm keeps its own licence inside
`node_modules` and is not repeated here.

## Hermes Agent — protocol sources

- **Project:** [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)
- **Copyright:** Nous Research
- **Licence:** MIT
- **Pinned commit:** `b9c2660ca479d9a2cf000d1d45ac9aadd1b7e3bd`
- **Vendored path:** `packages/hermes-shared/src/`
- **Upstream path:** `apps/shared/src/`

A subset of the pure-TypeScript sources that define the gateway protocol — the generated contract,
the event types, the JSON-RPC channel and gateway client, WebSocket URL handling, reconnect backoff,
slash-command parsing and a few small helpers — together with their tests. The exact file list is in
`packages/hermes-shared/upstream.json`.

The copy is produced by `scripts/sync-hermes-shared.mjs`, which pulls the files at the pinned commit
and applies a small set of mechanical rewrites so they run under React Native. Each vendored file
carries an attribution banner naming the project, the commit and the licence. The full upstream
licence text is kept at `packages/hermes-shared/LICENSE`.

The decision and its rationale are recorded in
[docs/adr/0003-vendor-hermes-shared.md](docs/adr/0003-vendor-hermes-shared.md), and the rewrites are
documented in [packages/hermes-shared/README.md](packages/hermes-shared/README.md).

## React Native macOS — project template

- **Project:** [microsoft/react-native-macos](https://github.com/microsoft/react-native-macos)
- **Copyright:** Microsoft Corporation and Meta Platforms, Inc. and affiliates
- **Licence:** MIT
- **Vendored path:** `apps/hermie/macos/`

The macOS Xcode project, Podfile and application delegate started as the react-native-macos 0.81
template and have been adapted for this app. `docs/platform-notes.md` lists the changes.
