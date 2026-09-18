# Glossary

Hermes Agent reuses a handful of everyday words for very specific things, and two of them are called
"gateway". This page pins down the terms Hermie's code and documentation use, so that the same word
means the same thing everywhere.

## Gateway

The process started by `hermes serve`. It listens on port 9119 by default and exposes the WebSocket
endpoint `/api/ws` plus a REST surface on the same origin. This is what Hermie connects to, and when
this documentation says "the gateway" without qualification, this is what it means. Hermie talks to
exactly one at a time.

## Messaging gateway

A different thing with a confusingly similar name: the process started by `hermes gateway`. It runs
the scheduler that fires cron jobs and delivers messages to external channels. `hermes serve` does
not run it, which matters operationally — a machine that only runs `serve` will accept and list cron
jobs but never execute them. Hermie reads the `gateway_running` flag from the cron API and shows a
banner when it is false.

## Bot

A Hermes **profile**, seen from the user's side. A profile carries its own system prompt, model
settings, tools and memory, and Hermie presents each one as a contact you chat with. Profiles are
identified by name; the marker `ui_meta: {hermes-bots: {}}` in a profile's configuration is what
makes it show up as a bot rather than as a bare profile.

## Bot Chat

The one canonical conversation per bot. It is an ordinary Hermes session whose title is exactly
`Bot Chat`, usually hidden from the session list. Hermie never creates a second conversation with a
bot: one bot, one thread, the way a messaging app works. The session is found through
`profiles.list` (which returns it as `canonical_session`), falling back to a title search and finally
to creating it.

## Runtime session id, stored session id, resolved id

Three identifiers for what feels like one conversation, and mixing them up is the classic source of
"my messages went to the wrong chat".

- The **runtime `session_id`** is what the gateway uses for the live session right now. It changes
  when a session is reclaimed, restarted or forked. It is never persisted.
- The **stored session id** is the durable identifier of the conversation as it was created. This is
  what Hermie writes to its cache and what it resumes on.
- The **`resolved_id`** is the root of the lineage: the id the REST endpoints use to address the
  conversation's message rows, which may differ from the stored id after a fork or a rewind.

The rule: persist the durable id, resume on it, and address REST rows by `resolved_id`.

## Ticket

A single-use, short-lived credential for opening a WebSocket. A gated gateway does not accept a
bearer token on the socket, so the client first calls `POST /api/auth/ws-ticket` over HTTP and then
dials with the ticket in a subprotocol. Tickets live about thirty seconds and are consumed by the
dial: every reconnect mints a fresh one. Reusing a ticket is a bug, not an optimisation.

## Dial plan

Everything one WebSocket dial needs, minted immediately before it: the URL, the subprotocols and any
extra headers. It exists as its own thing because a ticket is single-use and short-lived, so the
credentials for a socket cannot be computed once and reused. The socket factory is _armed_ with a
plan, consumes it when the socket is built, and refuses to dial without one — which turns ticket
reuse into an error at the call site instead of a puzzling 4401.

## Session token

The credential for an **ungated** gateway — one with authentication disabled. It is a long-lived
shared secret sent as the `X-Hermes-Session-Token` header on REST calls and as a query parameter on
the WebSocket. It is unrelated to the PKCE tokens and does not expire on its own.

## Native PKCE

The sign-in flow Hermie uses on a gated gateway: the OAuth authorisation code flow with PKCE, with a
loopback redirect URI. The gateway exposes it at `/auth/native/authorize` and
`/auth/native/token`, and advertises it as `native_pkce` in `GET /api/status`. Hermie opens the
authorisation page in an in-app web view and intercepts the loopback redirect before it is loaded —
nothing actually listens on that port. Password-based providers run through the same flow and end at
the same redirect, so there is one code path rather than two.

## Loopback redirect

The address the native PKCE flow ends on: `http://127.0.0.1:38007/callback?code=…&state=…`. Nothing
listens on it. It is a value the sign-in web view reads out of a navigation it then refuses to
perform, not a request anything serves. The gateway only accepts loopback **IP literals** here —
`localhost` is rejected, because a public route that honoured an arbitrary host would be an open
redirect leaking a live authorisation code.

## Extra headers

Request headers the operator configures during setup, sent with every REST call, every WebSocket
dial and the sign-in page's initial request. They exist for an access proxy in front of the gateway,
Cloudflare Access most commonly. Names must be valid HTTP tokens, CR and LF are stripped from values
so a pasted secret cannot smuggle a second header in behind it, and the headers the transport owns
(`Authorization`, `Host`, `X-Hermes-Session-Token`, …) cannot be overridden. They are stored in the
secret store rather than with the rest of the gateway configuration, because they usually are one.

## Connection test

The step in setup that has to pass before anything is written to disk: one authenticated REST call,
then a full WebSocket dial through to `gateway.ready` and a `profiles.list`, then a disconnect. Its
result is tied to a **payload key** — a fingerprint of the address, the extra headers, the
authentication mode, the provider and the credential — so that changing any of them invalidates the
result instead of leaving a stale "it worked" on screen.

## Fake gateway

The stand-in for `hermes serve` in `packages/fake-gateway`, used by the tests and by anyone
developing without a real agent. It answers the public status endpoints, both authentication flows,
the native PKCE round trip and the JSON-RPC surface, and exposes hooks a real gateway has no business
having: forcing a close code, dropping a socket without a close frame, or refusing the next upgrade.
It is a test double, not a second implementation — where behaviour matters, it follows the upstream
source.

## Turn

One round of the conversation: everything from the moment a prompt is submitted until the assistant's
message completes. A turn carries the assistant's text, its reasoning, the tool calls it made and any
questions it asked. Hermie's transcript state tracks at most one active turn per chat.

## Interim message

A partial assistant message the gateway emits while the turn is still running — a draft that will be
replaced, not appended to. It has to be rendered as provisional and discarded when the real content
arrives, which is why it is a distinct event rather than another delta.

## Tool card

The transcript item representing one tool invocation: which tool, with what arguments, how long it
took, and what came back. It appears when the tool starts and is completed in place. How much of it
is shown — a one-line summary, the arguments, the full output and diff — is a display choice, not a
change to what was recorded.

## Subagent and delegation

A **subagent** is a child agent a bot spawns to do part of a task, running in its own session. A
**delegation** is the unit of work handed to it. Subagent activity arrives as its own event family
and is always delivered regardless of the verbosity the gateway is configured for, which is why
Hermie can show live delegation progress even on a quiet gateway.

## DM

A message one bot sends another with the `message_agent` tool. It is fire-and-forget: the call
returns a queued acknowledgement with a delivery identifier, and the reply arrives later as a
separate row that has to be joined back to the original by process identifier. In the receiving bot's
transcript the message appears as a user-role row prefixed with the sender's name.

## Verbosity level

Hermie's own display filter: **Quiet**, **Normal** or **Verbose**, chosen per chat. It decides what
of the recorded transcript is shown — Quiet hides tool activity behind a single working indicator,
Verbose expands everything including raw arguments and output. It is a client-side selector over
data that was already received.

## `display.tool_progress`

The gateway-side setting that decides what is _sent_ in the first place: `off`, `new`, `all` or
`verbose`. Only `verbose` includes raw tool arguments and results. It is global — shared with the
desktop app and the terminal interface — so Hermie never changes it silently; it shows what it is set
to and offers an explicit button that says what changing it will affect.

The distinction matters: Hermie's verbosity level cannot show what the gateway never sent.

## Foreign turn

A turn that starts in a chat without Hermie having submitted it — because the same bot was prompted
from the desktop app, from the terminal, by a cron job, or by another bot. Hermie has no local record
of the user message that caused it, so it inserts a placeholder and reconciles the tail of the
transcript against the server instead of guessing.

## Replay epoch

An identifier the gateway sends on connect, marking the generation of its event log. It lets a
reconnecting client ask for everything it missed since the last sequence number it saw. If the epoch
has changed, or the gateway reports the replay as truncated, missed events cannot be replayed and the
client re-hydrates the conversation from scratch.

## Desktop contract

The gateway's protocol version for rich clients, reported as `desktop_contract`. Hermie requires
version 7 or newer and refuses to connect below it. Failing at the door with a clear message is
better than discovering halfway through a conversation that an event shape has changed.
