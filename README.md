# Hermie

Hermie is a client for [Hermes Agent](https://github.com/NousResearch/Hermes-Agent). It connects to a
Hermes gateway over the same WebSocket protocol the official desktop app uses, and gives you the
bots on that gateway as chats: one canonical conversation per bot, with tool activity, reasoning,
approvals and scheduled routines.

It is built with Expo and React Native and runs on iPhone, iPad, Android and macOS from one
codebase.

Website: [hermie.dev](https://hermie.dev)

## Status

Early development. The project skeleton, the shells and the platform abstractions are in place, and
so is the transport: the vendored protocol sources, the connection state machine with both
authentication flows, and a gateway stand-in to develop against. Setup and authentication work end to
end — you can point the app at a gateway, sign in, and it stays connected. The chat engine is next.
See [CHANGELOG.md](CHANGELOG.md).

## What you need to run it

Hermie is a client, not a server. It needs a Hermes gateway you can reach:

- **A running gateway.** Start it with `hermes serve` on the machine that hosts your agent. The
  default port is 9119. Hermie speaks to `/api/ws` and the REST endpoints on the same origin.
- **Gateway protocol version 7 or newer.** Hermie checks `desktop_contract` on connect and refuses
  to run against older gateways rather than failing halfway through a conversation.
- **A way in.** A gateway with authentication enabled must offer the native sign-in flow
  (`native_pkce` in `GET /api/status`); Hermie signs in through it and cannot use the browser-cookie
  flow. A gateway without authentication is reached with its session token instead. If your gateway
  sits behind an access proxy, its extra headers can be configured during setup.

[docs/test-gateway.md](docs/test-gateway.md) is a runbook for setting up a gateway to develop
against.

## Setting up a gateway

The first launch opens a five-step wizard, and nothing is written to disk until the last step —
abandoning it halfway leaves no credential behind.

1. **Welcome.** What Hermie is and what it needs.
2. **Gateway address.** The address you would open in a browser to reach the gateway dashboard.
   Without a scheme, `https://` is assumed. Hermie probes it while you type and tells you what it
   found — the version, and whether it wants a sign-in or a session token. If the gateway is behind
   an access proxy, **Advanced** takes extra request headers that are then sent with everything,
   including the sign-in page.
3. **Sign in.** On a gated gateway this is a "Sign in with …" button per identity provider; it opens
   the gateway's own sign-in page in an in-app web view and reads the result out of the redirect. On
   an ungated gateway it asks for the session token `hermes serve` prints at startup instead.
4. **Test connection.** Required, and invalidated by any change to the fields above. It makes one
   authenticated REST call and then opens the WebSocket exactly as the app will during use, so a
   reverse proxy that does not pass upgrades through fails here rather than after setup.
5. **Done.** Now the credentials go into the system secret store and the rest into the app's
   preferences, and the connection starts.

Afterwards, Settings shows the gateway and the live connection status. **Sign out** clears the
credentials and keeps the address, returning you to the sign-in step. **Change gateway** forgets
everything for that gateway and starts over. If a session expires while you are using the app, a
banner offers to sign in again where you are.

## Platforms

| Platform  | State                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS 15.1+ | Builds and runs; the primary target                                                                                                                                 |
| iPadOS    | Same build, sidebar layout on wide windows                                                                                                                          |
| Android   | Builds and runs                                                                                                                                                     |
| macOS 14+ | Builds and runs through react-native-macos; several Expo modules have no macOS implementation and are shimmed. See [docs/platform-notes.md](docs/platform-notes.md) |

## Quick start for developers

```sh
nvm use                 # Node 22 or newer
npm ci
npm run typecheck
npm test
```

Then pick a platform:

```sh
npm run ios             # iOS simulator
npm run android         # Android emulator or device
npm run macos           # macOS
```

`npm run ios` and `npm run android` generate the native projects on first run; `ios/` and
`android/` are not committed. `macos/` is committed and maintained by hand — see
[CONTRIBUTING.md](CONTRIBUTING.md) before changing it.

You do not need a real gateway to start. `npm run fake-gateway` stands one up on port 9119, and
Settings → Connection test in the app points a connection at it and reports what happens.

The repository is an npm workspace:

```
apps/hermie              the Expo app, including the macOS project
packages/hermes-shared   protocol sources vendored from Hermes Agent
packages/gateway-client  connection state machine, credentials, PKCE — no React
packages/fake-gateway    a gateway stand-in for tests and offline development
docs/                    architecture decisions, glossary, platform notes, runbooks
```

## Licence

MIT, copyright FullStack Studio. Third-party code carries its own notices; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
