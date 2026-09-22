# 0026. The share sheet may deliver, once, with the app's own answers

- Status: Accepted
- Date: 2026-09-22

## Context

ADR-0023 decided that every system surface talks to the app through a versioned file in the App
Group container and never through a connection of its own. It listed "give the extension its own
connection" as the first option and rejected it, and its last consequence said what would have to
happen if that turned out to be wrong: _"If a future surface genuinely needs a live connection …
this record needs a successor rather than an edit."_ This is that successor.

**What the owner's test showed.** Sharing a link into Hermie from another application wrote the
entry, asked the system to open the app, and delivered on the next launch. The verdict was one
sentence: _"the agent only does something with it once the app is open."_ That is not a bug in the
implementation — it is exactly what ADR-0023 specified — and it is not acceptable behaviour for the
feature. A share sheet that promises to send something and then requires the reader to leave the
application they were reading, watch a chat client start, and wait for a socket, has moved the work
onto the person instead of doing it.

Three facts about the gateway shape everything below, and two of them were established while
building this.

1. **There is no REST route that submits a prompt.** `/api/files/upload-stream` is HTTP and
   `/api/auth/ws-ticket` is HTTP, but `prompt.submit` is JSON-RPC over the WebSocket at `/api/ws`.
   So "deliver over the HTTP API" is only half available: the uploads and the ticket can ride a
   background `URLSession` that outlives the extension, and the message itself cannot.
2. **Which session a bot's chat IS is not a fact an extension can work out.** `prompt.submit`
   addresses a session. Resolving one takes a `session.list` lookup against a title convention, the
   reader's own choice between a shared and a private chat, and — when neither exists — minting one.
   `bots-controller` FAILS CLOSED on a failed lookup precisely because a second forever-chat cannot
   be un-minted. An extension repeating that reasoning from a three-second process with a possibly
   stale roster would get it wrong occasionally and permanently.
3. **A credential is reachable without a second sign-in ladder.** The app already writes its
   credentials to the keychain, and a keychain item is readable by any binary that declares the
   access group it was written into. `app.config.ts` has pinned that group since 2026-09-20.

Together those turn the rejected option into a much smaller one. The extension does not need a
connection of its own in the sense ADR-0023 refused — a dial ladder, a PKCE flow, a refresh, a thing
that can be signed out. It needs to spell back an answer the app has already computed, over a socket
that lives for one second.

The options considered this time:

1. **Leave it.** Rejected by the owner's test.
2. **Let the extension resolve everything itself.** A `session.list` lookup and a mint in Swift. This
   is fact 2, and the failure is permanent rather than annoying.
3. **Give the app a background delivery path of its own.** Silent push, or a background fetch, to
   wake the app when a share lands. It needs the push plugin (ADR-0017), which not every gateway
   runs; it needs the gateway to know a share happened, which it does not; and iOS grants background
   time when it feels like it, so "sent" would mean "probably, eventually".
4. **Let the extension deliver, using targets and a credential the app wrote down.**

## Decision

**A system surface may make one network attempt of its own, with a credential and a destination the
app has already resolved and written down. It may not resolve anything, refresh anything or retry
anything, and the container entry remains the fallback for everything it could not do.**

Concretely, on iOS, after "Send" is tapped:

| Step | Where     | What                                                                               |
| ---- | --------- | ---------------------------------------------------------------------------------- |
| 1    | container | The outbox entry is written. FIRST, unconditionally, before any credential is read |
| 2    | keychain  | `hermie.share.delivery` — the active gateway's address, headers and credential     |
| 3    | container | `share-targets.json` — which session each bot is, and two translated sentences     |
| 4    | HTTP      | `POST /api/auth/ws-ticket`, for a gated gateway                                    |
| 5    | socket    | `session.resume` on the session id from step 3 → the runtime id and the `cwd`      |
| 6    | HTTP      | `POST /api/files/upload-stream` per file → an `@file:` token each                  |
| 7    | container | `claim.json` inside the entry, immediately before the submit                       |
| 8    | socket    | `prompt.submit`                                                                    |
| 9    | container | The entry is removed, claim and all                                                |

Steps 4 and 6 run on a background `URLSession` whose `sharedContainerIdentifier` is the App Group,
which is what lets a transfer finish after this process is gone — and what makes the session legal to
create inside an extension at all. Step 5 and step 8 cannot: `URLSessionWebSocketTask` does not exist
on a background configuration. So the sheet stays on screen for the second this takes and then says
which of two things happened, in the reader's own language.

Four rules hold it together.

- **The app decides, the extension spells.** Unchanged from ADR-0023's fourth rule, and it is what
  makes this safe rather than reckless. The session id, the address, the headers, the credential and
  the two sentences are all projections of state the app held while it was running. The extension
  contributes the network call and nothing else. A bot missing from `share-targets.json` is a share
  that queues — never a lookup this process attempts.
- **The entry is written before the attempt and removed after it.** Every failure therefore lands in
  exactly the state this feature had before this record: an entry on disk, a badge on the bot's row,
  and an app that delivers it at its next launch. Nothing here can lose a share.
- **A claim is a question, not a verdict.** ADR-0023 said a share is kept until it has gone, so the
  gap fails towards "sent twice, visibly" — which was right for the app, because the app has a
  screen, a badge and a next launch. An extension has none of those, so it buys the same safety a
  different way: it writes down that it is about to submit. An entry that still carries a claim is
  never delivered and never dropped by the app; it goes to the picker, which says it may already have
  been sent and offers "Send again" and a discard. That is the one place in this feature where a
  person is asked, and it is asked because both answers a program could pick are wrong some of the
  time.
- **No refresh, ever.** The record carries the credential in use and never a refresh token. On a
  provider with refresh-token rotation, an extension that refreshed would kill the app's stored
  token; on one with reuse detection, presenting the dead one revokes the session. So a share sheet
  could sign somebody out of their own gateway. An expired access token ends the attempt and the app,
  which can refresh, delivers the entry.

What ADR-0023 still says, unchanged: **a link names a thing and carries nothing.** `hermie://share/<id>`
is still only an id, it is still checked against an alphabet this app mints from, and it is now only
sent on the queued path — a share that has already arrived has no business pulling anybody out of the
application they were reading.

## Consequences

- **The feature's reach is an auth matrix, and it is narrower than it looks.** A session-token
  gateway can be delivered to from a share sheet indefinitely: the token is revoked or it is not, and
  there is nothing to count down. An OIDC gateway can be delivered to only while the access token the
  app last stored is still valid — typically an hour from the last time the app ran or refreshed.
  After that every share is queued, which is correct and silent. `docs/platform-notes.md` states it
  where somebody debugging will find it. The cookie flow cannot be delivered from an extension at
  all, and does not need to be: it exists only on the web build.
- **An image is still the app's to deliver.** A shared image travels as resized bytes over the socket
  (`image.attach_bytes`), because that is what puts it in the transcript; resizing a photograph is
  the work a share extension is killed for, and the HTTP road hands the agent a binary `@file:`
  cannot read. So a share carrying an image queues, with the same sentence as every other queue. The
  commonest share — a link — and a share of documents both send.
- **There is no Android half.** Android's chooser starts `MainActivity` with an `ACTION_SEND` intent,
  so the app is already opening by the time a share exists and the owner's complaint has no
  equivalent there; what Android has instead is that the app takes over the screen. Doing it the way
  iOS now does would mean a transparent share activity of our own taking the intent filters off
  `MainActivity`, a WorkManager job, and a WebSocket client in Kotlin — fact 1 means a worker cannot
  finish the job over HTTP. That is a decision about a second platform's UI and not a port of this
  one, and it is not implemented. `share-targets.json` is written on iOS only and the Android module
  answers `false` when asked, rather than pretending.
- **The keychain access group is now load-bearing, and it fails silently.** A mismatch between the
  group `app.config.ts` names and the one the extension's entitlements declare produces a lookup
  that finds nothing: every share queues, which looks exactly like a gateway that is down. The config
  plugin refuses to prebuild on a mismatch, the same way it already does for the App Group, and both
  strings are pinned by `__tests__/ios-share-plugin.test.ts`.
- **One keychain item now describes the active gateway, and it is not namespaced.** Every other
  credential in this app is keyed by gateway id (ADR-0024). This one cannot be: the reader's whole
  problem is that it cannot find out which gateway is active. So it is a projection with a guard —
  the record carries its gateway's key, `share-targets.json` carries the active gateway's key, and
  the extension sends nothing when the two disagree. A record left behind for an inactive gateway is
  inert rather than wrong.
- **Three writes now have to stay in step with the app's session state.** The registry write, a token
  rotation and a sign-out each republish or remove the record. The one that is easy to forget is the
  rotation: without it the feature would work for one hour after every launch and then queue for
  ever, which is the worst shape a feature can have — it works while you are testing it.
- **A share sheet is no longer instant.** It stays up for as long as the attempt takes, bounded at
  fifteen seconds for the socket to say it is ready and thirty for a call to answer, and in practice
  about a second. That is a real cost paid in the one place a person is least patient, and it is why
  every deadline in `HermieShareSender` cancels towards "queued" rather than waiting.
- **The extension now holds a bearer token in memory for a second.** It always could have — the
  keychain group was already on the app — but nothing did. What bounds it is that the item carries no
  refresh token, no provider configuration and no way to mint anything, so the worst an extension
  that misbehaved could do is send a message to a chat the reader already has open.
