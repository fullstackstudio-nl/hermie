# 0017. Push notifications come from Hermie Web, and a device registers itself in `ui_meta`

- Status: Accepted
- Date: 2026-09-21
- Builds on: [0015](0015-web-variant-on-its-own-port.md), [0016](0016-ui-meta-sync.md)

## Context

Hermie is a messenger whose correspondents work while nobody is looking. A bot answers a question
twenty minutes after it was asked, a cron job delivers a report at 07:00, a teammate's bot sends a
DM, and an agent stops mid-task to ask whether it may run `rm -rf ./build`. Today every one of those
is invisible until the app is opened, which is the one property a messenger cannot have.

### What the phone can and cannot do

An app that is not running has no socket. iOS suspends it within seconds of backgrounding and
Android's Doze does the equivalent; `attachLifecycle` already tears the gateway connection down
because holding it would be a lie. This is not a limitation to be engineered around — it is the
platform contract, and the whole reason the push transports exist.

So something that is always running has to be watching, and it has to be something the owner already
runs.

### What the gateway does not have

`hermes serve` has no push machinery of its own and no notion of a device. It also has no way to say
who is watching a session:

- **There is no client-presence list.** `session.active_list` returns one row per LIVE session in the
  gateway PROCESS, with a `current` flag that means "this is the CALLING connection's session" and
  nothing about anybody else's. Two clients resumed on the same session are one row.
- **Two clients on one session do not fight.** `session.reclaimed` is broadcast only for
  `idle_timeout`, `lru_evict` and `ws_orphan_reap` — the backend taking a session back — and never
  because a second client resumed it. Upstream's reaper comments describe a session's transport as a
  fan-out of peers, dead "exactly when no peer of its own is alive". A watcher and an app can hold
  the same Bot Chat at once.
- **A watched session is a pinned session.** `_session_is_lru_evictable` refuses to evict a session
  whose transport is alive, and the TTL reaper applies the same exemption. A process that resumes
  every Bot Chat and stays connected therefore keeps every Bot Chat resident for as long as it runs.
  That is a real cost and it is paid knowingly; see Consequences.

### The pieces that already exist

[ADR-0015](0015-web-variant-on-its-own-port.md) put a small Node server next to the gateway:
`packages/hermie-web`, zero runtime dependencies, inside the perimeter rather than on it, already
holding a proxied connection to exactly one gateway and already shipped as a release artefact with a
Docker image and a systemd unit. It is the only always-on thing this project owns.

[ADR-0016](0016-ui-meta-sync.md) established that a profile's `ui_meta` is a per-key
compare-and-swap that Hermie may write under keys it owns, that the app-wide key `hermie-app` lives
on the default profile, and — proved against `hermes serve` 0.21.3 — that a write leaves neighbouring
keys alone and a `null` removes a key. That is a small, ordered, authenticated key-value store that
both a device and a daemon can reach through the connection each already has.

### Options considered

1. **A hosted push service of ours.** Every device's token and every bot's name on somebody else's
   server, an account system, and a permanent operational obligation for a self-hosted product whose
   whole pitch is that the conversation stays with the owner's gateway. Rejected.
2. **Upstream grows push.** Hermie's release cadence becomes upstream's problem and Hermie's device
   tokens become upstream's liability, for a feature only this client wants.
   [ADR-0006](0006-single-gateway-no-relay.md)'s spirit is that Hermie does not ask upstream for
   anything it can do itself. Rejected.
3. **A background task in the app.** iOS background fetch has no schedule anybody can rely on and
   Android's equivalent is killed by every aggressive OEM battery manager. It would work on a test
   device and fail silently on the owner's. Rejected.
4. **A watcher inside Hermie Web.** It is already next to the gateway, already a released artefact,
   already the thing a self-hoster installs. Chosen.

## Decision

**Hermie Web gains a `--push` mode: one service connection to the gateway, watching every Bot Chat,
sending notifications to devices that registered themselves in `ui_meta`.**

### The daemon

`hermie-web --push` holds **one** WebSocket to its single configured gateway and resumes every bot's
canonical Bot Chat, exactly as the app resolves one ([ADR-0007](0007-canonical-bot-chats-only.md)).
It is a reader: it never submits a prompt, answers a question, or changes a setting.

It notifies on four things, and on nothing else:

- a **new bot message** in a chat no client is attached to;
- an **approval or clarify request** opening;
- a **bot-to-bot DM** arriving;
- a **cron delivery or cron error**.

Its credential is whatever the gateway takes. On an ungated gateway that is the session token it
already holds. On an OIDC-gated one it is a refresh token obtained once through the same native PKCE
flow the app uses, via a `hermie-web login` subcommand that prints the authorisation URL and listens
on the RFC 8252 loopback redirect ([ADR-0004](0004-native-pkce-via-webview.md)) — and if the
gateway's provider issues no refresh token, push is **not available** and the command says so rather
than storing an hour-long credential. That is the same condition the app now warns about at sign-in.

### Registration lives in `ui_meta`

A device that wants notifications writes its registration into its own per-user section on the
gateway. **The app never talks to the daemon.** There is no second address to configure, no second
thing to expose, and no endpoint for anything on the network to post to.

Under the `hermie-app` key on the default profile ([ADR-0016](0016-ui-meta-sync.md)), a new
`push.registrations` section, keyed by an installation id the device mints once:

```json
{
  "v": 1,
  "push": {
    "registrations": {
      "<installation-id>": {
        "v": 1,
        "transport": "expo" | "webpush",
        "token": "ExponentPushToken[…]",
        "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" },
        "platform": "ios" | "android" | "web",
        "types": { "message": true, "request": true, "dm": true, "cron": true },
        "preview": false,
        "updatedAt": 1789957143
      }
    },
    "seen": { "<installation-id>": 1789957143 }
  }
}
```

`token` is present for `expo`, `endpoint` + `keys` for `webpush`; never both. The section is rewritten
whole under the compare-and-swap ADR-0016 describes, and a sign-out or a change of gateway removes
this installation's entry — a registration is only meaningful for the gateway it was made on.

The daemon reads the registrations through its own gateway connection, sends Expo pushes through the
public Expo Push API (`https://exp.host/--/api/v2/push/send` — no secret, the token is the address)
and Web Push through VAPID keys it generates per installation on first run, signed with Node's own
`crypto`. Expo receipts are read back and a `DeviceNotRegistered` removes that registration.

### The payload says who, not what

**Bot name and event type only.** No message content, no snippet, no request text, unless the owner
turns `preview` on per device. A notification is delivered by Apple, Google and a browser vendor and
is rendered on a lock screen; the default is therefore the least a notification can say and still be
worth tapping.

### "Nobody is attached" is a heartbeat, not a protocol fact

The gateway cannot be asked who is watching. So the app writes `push.seen[<installation-id>]` while a
chat is on screen, and the daemon suppresses a message notification when any registration's `seen`
stamp is within the window. A short delay before sending absorbs the case where the app is opening.

This is a heuristic and it is written down as one: the failure mode is a redundant notification for a
chat somebody is already reading, which is the right direction to fail in. Requests, DMs and cron
deliveries are **not** suppressed — a question with a countdown on it is worth a buzz even if the
chat is open on a tablet in another room.

### An action is validated before it is answered

An approval notification carries Allow and Deny actions. Tapping one does **not** answer anything by
itself: the app opens, connects to the gateway, re-reads the open requests, and responds only if that
request is still open and still says what the notification said it did. A notification is a hint that
something happened, never an instruction — see the threat model.

### The daemon says it exists, and nothing more

`hermie-app.push.endpoint` in the app-wide `ui_meta` is **informational**: the daemon writes its own
version and a liveness stamp so Settings can say whether push is available and, when it is not, say
what is missing. The app never dials it.

## Threat model

**What is covered.**

- _Nothing on the network can make a device buzz._ There is no inbound endpoint. The only way into
  the path is a write to `ui_meta` on the gateway, which is authenticated by the gateway.
- _A stolen Expo token cannot read anything._ It is a send address. The worst it buys is noise, and
  the payload it can carry says nothing the holder did not already have to know to obtain it.
- _A spoofed push cannot act._ Every action is re-validated against the gateway's own open requests
  before a response is sent, so a forged "Allow `rm -rf /`" is a notification that opens an app which
  finds no such request and says so.
- _Content stays on the gateway by default._ With `preview` off, the push transports carry a bot
  name and a type. Turning it on is a decision the owner makes per device.

**What is not covered, and is accepted.**

- _The daemon's credential is a gateway credential._ It can read every transcript on that gateway,
  because that is what watching them requires. Anyone who can read the daemon's state file has that
  access. It is the same trust level as the gateway's own host, which is where the daemon runs.
- _Traffic analysis._ Apple, Google and any browser push service learn that a device received a
  notification, when, and from which server. They cannot learn what it said; they can learn that
  something happened.
- _A compromised gateway._ It can already do everything. Push adds the ability to make a device buzz
  and to read the registrations, which is strictly less than it already has.
- _`ui_meta` is per profile, not per user._ Two people on one gateway share the `hermie-app` key, so
  each can see the other's registrations — the same regression ADR-0016 accepted knowingly, for the
  same reason: the gateway has no per-user scope. A registration holds a push token, a platform and a
  set of toggles; it holds no message content and no credential for anything but being sent to.
- _Push is only as reliable as the thing running it._ A daemon that is not running sends nothing, and
  nothing on the device will say so beyond the liveness stamp Settings reads. Notifications are best
  effort and the app never treats their absence as information.

## Consequences

**What this buys.** A messenger that behaves like one, on iOS, Android and the browser, with no
account, no hosted service, no inbound port, and one extra flag on a process the self-hoster already
installs.

**One more thing to run, and it holds sessions open.** A watcher that resumes every Bot Chat keeps
every Bot Chat on the gateway's live-session list, and upstream never evicts a session whose
transport is alive. On a gateway with `max_live_sessions` set, the daemon's resumed chats count
against that cap. That is the price of hearing about a message the moment it is written, and the
alternative — polling the REST transcript — trades it for latency and load. The daemon resumes
lazily and drops a chat it has not heard from in a long while, so the resident set follows the bots
that are actually in use.

**Two transports, two failure modes, one code path.** Expo handles APNs and FCM and gives receipts;
Web Push is VAPID and gives an HTTP status. Both reduce to "send, then decide whether this
registration is still real", which is the only part the watcher knows about.

**The app must cope with a notification for a chat that has moved on.** A tap can land on an answered
question, a deleted cron, a bot that no longer exists. Every entry point resolves against the gateway
before it shows anything, which is the same rule the widgets and the deep link already follow.

**Push and the browser build need the same origin.** A service worker and a `PushSubscription` need
https and a registered scope, so Web Push works only where Hermie Web is served over TLS — the same
condition ADR-0015 already puts on exposing it at all. Over plain http the browser build simply does
not offer it.

**An OIDC gateway whose provider issues no refresh token cannot run push.** The daemon would need an
interactive sign-in every hour. `hermie-web login` says so plainly and points at the same
`offline_access` scope the app's own sign-in warning names.
