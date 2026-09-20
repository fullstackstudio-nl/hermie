<p align="center">
  <img src="apps/hermie/assets/icon.png" alt="" width="104" height="104">
</p>

<h1 align="center">Hermie</h1>

<p align="center">
  A client for <a href="https://github.com/NousResearch/Hermes-Agent">Hermes Agent</a>.<br>
  Your bots, as chats, on your phone, your tablet and your Mac.<br>
  <a href="https://hermie.dev">hermie.dev</a>
</p>

---

Hermes Agent runs agents on a machine you control. Hermie is the client for it:
it points at one gateway, signs in, and turns every bot on that gateway into a
conversation you can open and talk to. Tool calls stream in as they run.
Questions the agent needs answered — a command it wants to run, a detail it is
missing — arrive as a sheet you tap. And when your bots talk to each other, you
see both sides of it, because a reply you cannot trace back to a question is
just a machine talking to itself.

It is one Expo and React Native codebase running on iPhone, iPad, Android and
the Mac, and it talks to nothing but your gateway.

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/chats.png" alt="The chat list, showing the bots Researcher and Writer with their last messages and an unread badge"></td>
    <td width="33%"><img src="docs/screenshots/conversation.png" alt="A conversation with the Researcher bot: a delivered message to @writer with the reply folded into it, and an incoming message from the Writer bot"></td>
    <td width="33%"><img src="docs/screenshots/approval.png" alt="The approval sheet asking whether to allow the command rm -rf ./build, with the choices Allow once, Allow for this session, Always allow and Deny"></td>
  </tr>
  <tr>
    <td>The chat list</td>
    <td>A conversation, with bot-to-bot traffic in it</td>
    <td>An approval, asked and answered</td>
  </tr>
</table>

<!--
  These three images predate the Liquid Glass pass and the gateway card's
  removal: they show the previous surfaces, not the ones the app draws today.
  Two things in them are named differently or not there at all now, and the alt
  text above is written around both: the green "Connected" line under the title
  is gone — the connection speaks in one line under the header instead — and the
  tab reading "Routines" is called Crons everywhere.
  Regenerating them is its own job — docs/screenshots/ is published material
  (CONTRIBUTING.md), so it wants fixture data and stripped metadata, not a
  hurried retake.
-->

## What it does

- **One chat per bot.** Every bot on the gateway gets its canonical conversation,
  with its history, and it stays attached while the app is open so nothing
  arrives late.
- **Tool calls you can read.** Each one is a card: what ran, how long it took,
  and — if you ask for it — the arguments and the result. Three verbosity levels
  decide how much of that is on screen, and it is a view setting, so switching it
  never changes what the gateway does.
- **Bot-to-bot, visible.** A message one bot sends another shows up in both
  conversations, the reply is folded into the message that caused it, and
  **Activity** is one timeline of all of it across every bot.
- **Questions as sheets.** Approvals and clarifications come up as a bottom
  sheet, answered only by an explicit tap, and a question that was answered
  somewhere else says so instead of going stale.
- **Crons.** The gateway's scheduled jobs, under the name the gateway and its
  dashboard use: what they run, when they run next, pause, resume, run now, and
  the transcript of any past run. A delivery lands in the chat it was addressed
  to as its own card, with the cron itself one tap away.
- **Files and images.** Anything the picker will give you goes up to the gateway
  and into the conversation — a photo, a PDF, a spreadsheet — as its own chip,
  which says while it is uploading and says so on the chip if it is refused.
- **Who is busy, at a glance.** Every chat carries a bead: offline, needs input,
  working, online, in that order of urgency. It is the only thing in the app that
  animates, and only for the one state that is waiting on a person.
- **Your list, arranged your way.** Rows reorder, named dividers group them,
  chats archive, and each one can carry its own colour. None of it is sent to the
  gateway: the arrangement is yours and it is per gateway, because a different
  machine's bots are a different list.
- **Offline-tolerant.** The last stretch of every conversation is cached, so a
  chat paints before the gateway answers and is still readable on a plane.

## What you need

Hermie is a client, not a server. It needs a Hermes gateway you can reach:

- **A running gateway.** `hermes serve`, on the machine that hosts your agent.
  The default port is 9119. Hermie speaks to `/api/ws` and the REST endpoints on
  the same origin.
- **Gateway protocol version 7 or newer.** Hermie checks `desktop_contract` when
  it connects and refuses to run against anything older, rather than failing
  halfway through a conversation.
- **A way in.** A gateway with authentication enabled must offer the native
  sign-in flow — `native_pkce` in `GET /api/status`. Hermie signs in through
  that; it cannot use the browser-cookie flow. A gateway without authentication
  is reached with the session token `hermes serve` prints at startup. Either way,
  if the gateway sits behind an access proxy, extra request headers can be added
  during setup and are then sent with everything, including the sign-in page.

Two things about the gateway's own configuration are worth knowing before you
start:

- **Set `dashboard.public_url`** to the address you actually reach the gateway
  on. It is what makes the gateway build sign-in redirects that come back to
  itself rather than to `localhost`, and a gateway without it will hand Hermie a
  sign-in page that cannot complete.
- **Reach it over HTTPS** if it is not on the same machine. A reverse proxy in
  front of `hermes serve` has to pass WebSocket upgrades through; setup tests
  exactly that before it saves anything, so a proxy that does not will fail
  during setup rather than a week later.

[docs/test-gateway.md](docs/test-gateway.md) is a runbook for standing one up
from scratch.

### Keep the gateway off the public internet

A Hermes gateway runs agents that execute commands on the machine it lives on.
That is not something to leave reachable by anyone who finds the address, however
good the sign-in in front of it is. The recommended setup is a private network:
[Tailscale](https://tailscale.com), or [Headscale](https://headscale.net) if you
would rather host the control server yourself. Both use the same clients.

- Put the gateway machine and every device that runs Hermie on the same tailnet,
  and give Hermie the gateway's tailnet name as its address.
- Serve it over HTTPS there too. `tailscale serve` puts a certificate for the
  machine's tailnet name in front of `hermes serve` and passes WebSocket upgrades
  through; with Headscale, a reverse proxy with its own certificate does the same
  job.
- Set `dashboard.public_url` to that tailnet address, for the reason above.
- If the gateway signs you in through an identity provider, the provider's
  sign-in page has to be reachable from the device as well. A public provider
  already is; one that lives on the tailnet is reachable as long as the VPN is up.

Hermie needs nothing special for any of this. It talks to whatever address it is
given, so the VPN only has to be connected before the app is.

## Getting it

Hermie has not had a release yet. When it does:

- **iPhone and iPad** — TestFlight _(link to follow)_
- **Mac** — the same TestFlight build, or the same App Store listing: Apple
  offers an iPhone/iPad app on Apple Silicon Macs unless it is opted out
- **Android** — Play internal testing _(link to follow)_

Until then, and any time you would rather build it yourself:

```sh
git clone https://github.com/fullstackstudio-nl/hermie.git
cd hermie
nvm use                 # Node 22 or newer
npm ci
```

Then pick a platform:

```sh
npm run ios             # iOS simulator
npm run android         # Android emulator or device
HERMIE_APPLE_TEAM_ID=XXXXXXXXXX npm run mac    # this Mac
```

All three generate the native projects on first run; `ios/` and `android/` are
not committed. `npm run mac` builds the iOS app for the "Designed for iPad"
destination and wraps it so macOS will launch it — it needs an Apple Developer
team identifier, because a Mac build has to be signed. `--no-open` builds without
launching, `--debug` builds against Metro.

You do not need a real gateway to try it:

```sh
npm run fake-gateway -- --auth token --token demo
```

That stands a gateway up on port 9119 with two bots, each with history that
includes a tool call and a bot-to-bot exchange, and a streaming reply for
anything you send. A prompt containing "approve" raises an approval request; one
containing "delegate" fans out subagent activity.

## Setting up a gateway in the app

The first launch opens a wizard, and nothing is written to disk until the last
step — abandoning it halfway leaves no credential behind.

1. **Welcome.** What Hermie is and what it needs.
2. **Gateway address.** The address you would open in a browser to reach the
   gateway dashboard. Without a scheme, `https://` is assumed. Hermie probes it
   while you type and says what it found: the version, and whether it wants a
   sign-in or a session token. **Advanced** takes extra request headers.
3. **Sign in.** On a gated gateway, a "Sign in with …" button per identity
   provider, which opens the gateway's own sign-in page in a forgetful in-app web
   view and reads the result out of the redirect. On an ungated gateway, the
   session token instead.
4. **Test connection.** Required, and invalidated by any change to the fields
   above. It makes one authenticated REST call and then opens the WebSocket
   exactly as the app will during use.
5. **Done.** Now the credentials go to the system secret store and the rest to
   the app's preferences, and the connection starts.

Afterwards, Settings shows the gateway and the live connection status. **Sign
out** clears the credentials and keeps the address. **Change gateway** forgets
everything for that gateway and starts over. If a session expires while you are
using the app, a banner offers to sign in again where you are.

## How it works

One WebSocket, newline-delimited JSON-RPC, to `/api/ws` on your gateway — the
same protocol the official desktop app speaks, from the same sources, vendored
into `packages/hermes-shared` from a pinned upstream commit. Chat history and
long transcripts come over REST on the same origin. Authentication is the
gateway's own native PKCE flow, exchanged for a bearer token; the WebSocket is
dialled with a single-use ticket, minted fresh for every connection, because the
bearer token is not accepted there.

**Where your data goes: to your gateway, and nowhere else.** There is no Hermie
server, no account, no analytics and no third-party network call in the app.
Tokens live in the platform keystore. Transcripts are cached in the app's own
storage so a conversation can paint before the gateway answers. What your bots
say stays between you and the machine you run them on.

## Platforms

| Platform             | State                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| iOS 15.1+            | The primary target                                                              |
| iPadOS               | The same build, with a sidebar layout on wide windows                           |
| Android              | Builds and runs; exercised least of the three                                   |
| macOS, Apple Silicon | The same build again, as "Designed for iPad" — a window with the sidebar layout |

The Mac is not a separate port. It is the iOS app, which Apple runs on Apple
Silicon Macs unmodified, so it has the same keychain, the same modules and the
same code paths — and one seam, `isiOSAppOnMac`, for the few things a window
should do differently from a tablet. That is a deliberate reversal:
[ADR-0011](docs/adr/0011-mac-via-the-ipad-build.md) records what a native
react-native-macos target cost and why it was dropped, and
[docs/platform-notes.md](docs/platform-notes.md) records what has and has not
been verified on a Mac.

## Roadmap

| Milestone                                                    | State       |
| ------------------------------------------------------------ | ----------- |
| Skeleton: one codebase on four platforms                     | Done        |
| The protocol sources and the connection state machine        | Done        |
| Setup and sign-in                                            | Done        |
| Bot chats: streaming, tools, approvals, reconnection         | Done        |
| Bot-to-bot messages, subagents and the Activity timeline     | Done        |
| iPad and Mac layout, the transcript cache, image attachments | Done        |
| Crons                                                        | Done        |
| Release: icons, build profiles, signing, this README         | In progress |

After that: paging back through long history, notifications, and an Android pass
that deserves the name.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the toolchain, the checks that have to pass, and the conventions that are easy to
get wrong — the vendored protocol sources in particular. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies.

Security issues go privately to the address in [SECURITY.md](SECURITY.md), not
into an issue.

The repository is an npm workspace:

```
apps/hermie              the Expo app, and the local Expo module under modules/
packages/hermes-shared   protocol sources vendored from Hermes Agent
packages/gateway-client  connection state machine, credentials, PKCE — no React
packages/transcript      the chat engine: item model, reducer, reconciliation, selectors
packages/fake-gateway    a gateway stand-in for tests and offline development
design/                  the interface reference and the icon source
docs/                    architecture decisions, glossary, platform notes, runbooks
```

## Licence

MIT, copyright FullStack Studio. See [LICENSE](LICENSE). Third-party code carries
its own terms, and they are recorded in two files because they are two different
obligations:

- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — code **copied or ported into**
  this repository: the vendored Hermes protocol sources, the Desktop and gateway
  logic this client is a derivative work of, and the code of conduct. Maintained by
  hand, because a port leaves nothing a tool could find.
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) — every npm package that
  **ships inside the app**, with its version, its licence and the licence text it
  carries. Generated by `scripts/generate-third-party-licenses.mjs` from
  `package-lock.json`: `npm run licences` rewrites it and `npm run licences:check`,
  which CI runs, fails when it has drifted. The same data is bundled into the app,
  under Settings → Licences.
