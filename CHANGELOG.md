# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project skeleton: npm workspaces, TypeScript project references, ESLint, Prettier, commit-message
  rules and a CI check job.
- `apps/hermie`, an Expo SDK 54 app targeting iOS, iPadOS, Android and macOS, with the compact and
  regular shells, design tokens, theming and the platform storage abstractions.
- A hand-maintained macOS project built on react-native-macos, with Expo modules linked through
  CocoaPods.
- `@hermes/shared`: the Hermes protocol sources, vendored from a pinned upstream commit by
  `scripts/sync-hermes-shared.mjs`. The rewrites are asserted, `--check` fails on drift, and the
  upstream tests are vendored with the sources and run unchanged.
- `@hermie/gateway-client`: a React-free client for a Hermes gateway — URL and header handling, the
  unauthenticated probe, native PKCE with a token coordinator that keeps refreshes single-flight,
  session-token and PKCE credential providers, an HTTP layer that retries once after a 401, a dial
  plan socket factory, and the connection state machine over one long-lived JSON-RPC client.
- `@hermie/fake-gateway`: a gateway stand-in for tests and offline development, with a CLI behind
  `npm run fake-gateway`.
- A hidden developer screen at Settings → Connection test that probes an address and opens a real
  connection to it, reachable through a Settings link in the compact shell's header.
- Architecture decision records 0001 to 0005, a glossary, platform notes and a gateway runbook.
- An onboarding wizard: Welcome, gateway address, sign in, test connection, done. The address step
  probes the gateway while you type — debounced, and with a sequence guard so a slow answer cannot
  overwrite a newer one — and turns every failure into one sentence with the server-side fix where
  one exists. An "Advanced" disclosure takes extra request headers for a gateway behind an access
  proxy.
- Native PKCE sign-in through `NativeSignInWebView`: a full-screen, forgetful web view that renders
  the gateway's own sign-in page and intercepts the loopback redirect before it is loaded, verifies
  the `state`, and exchanges the code. If the web view cannot be used, the same flow completes
  through the system browser and a pasted redirect, parsed by the same function.
- A mandatory connection test that exercises REST and the WebSocket, tied to a payload key so that
  editing any field invalidates the result rather than leaving a stale success on screen. Only once
  it passes are credentials written to the secret store and the gateway configuration to the app's
  preferences.
- `GatewayProvider`: one `GatewayConnection` for the app's lifetime, built from the stored
  configuration at startup, following the app lifecycle and connectivity, with connection state in a
  store any screen can subscribe to. An expired session raises a banner that signs in where you are
  and resumes the dial loop.
- A Settings screen with the gateway, the live connection status, sign-out, change-gateway, and the
  developer connection test.
- English UI strings collected in `src/i18n/strings.ts`, and design tokens updated to the Messenger
  direction from `design/tokens.md`.
- A connectivity seam (`src/platform/net-info.ts`) so that macOS, where NetInfo has no native module,
  no longer fails at startup.

[Unreleased]: https://github.com/fullstackstudio/hermie/compare/main...HEAD
