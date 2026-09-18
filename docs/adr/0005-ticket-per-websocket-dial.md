# 0005. A fresh ticket per WebSocket dial, offered as a subprotocol

- Status: Accepted
- Date: 2026-09-19

## Context

On a gated gateway the REST surface authenticates with `Authorization: Bearer`. The WebSocket does
not, and cannot: the browser WebSocket API has no way to set request headers on an upgrade, so the
gateway's SPA could never send a bearer token. Rather than maintain two authentication mechanisms,
the gateway made the browser's constraint the rule for every client.

`hermes_cli/web_server_chat.py::_ws_auth_reason` is explicit about it. In gated mode the legacy
`?token=` query credential is rejected outright — "a leaked `_SESSION_TOKEN` must not grant access" —
and what is accepted is a **ticket**: minted by an authenticated `POST /api/auth/ws-ticket`, single
use, with a 30 second time to live.

The ticket can travel two ways. As `?ticket=` in the query string it ends up in access logs and proxy
logs, because a URL is not a secret-carrying medium. The other way is the WebSocket subprotocol
header, which the gateway parses in `_gateway_ws_ticket_from_subprotocol`: the client offers
`hermes-gateway-v1` plus exactly one `hermes-gateway-ticket.<ticket>`, and on accept the server
selects only the stable public name back, with the comment that the ticket-bearing protocol "is a
credential and must never be reflected back to the browser or retained after admission".

React Native's `WebSocket` does accept custom headers, so Hermie could in principle send a bearer.
It would be rejected: the gateway does not look for one on the socket.

A rejected upgrade is not an HTTP status. The gateway accepts the upgrade and then closes with a code
— 4401 for authentication, 4403 for the host/origin guard, 4408 when another peer took the session
over, 4404 when chat is disabled. So the client learns the verdict from a close frame on a socket
that already opened.

## Decision

Every WebSocket dial **mints its own ticket** and offers it as the second subprotocol:

```
['hermes-gateway-v1', 'hermes-gateway-ticket.<ticket>']
```

This is modelled as a `DialPlan` — URL, subprotocols and extra headers — that the connection owner
mints immediately before connecting. The `DialPlanSocketFactory` is _armed_ with one plan, consumes
it when the socket is built, and throws if it is asked to dial without one or for a different URL.
A ticket that was minted but not used is discarded rather than kept for the next attempt.

Close codes are classified rather than treated as generic drops. 4401 asks the credential provider
for a fresh credential and permits exactly one immediate redial; a second 4401 in a row moves to
`needs_signin`. 4403, 4408 and 4404 stop the dial loop entirely and surface a configuration
explanation, because retrying will produce the same refusal.

The ungated case keeps `?token=`, which is what an ungated gateway accepts.

## Consequences

- A reconnect costs one extra HTTP round trip before the socket opens. With a 30 second TTL there is
  no meaningful alternative: a cached ticket would be expired more often than not.
- The ticket never appears in a URL, so it stays out of access logs and referrer headers.
- The factory's "armed for exactly one dial" rule turns ticket reuse from a subtle authentication bug
  into a thrown error at the call site, which is where it is cheap to notice.
- Minting is itself an authenticated call, so an expired access token surfaces as a mint failure
  before a socket is ever opened — a 401 there routes into the same refresh-and-retry path as a 4401
  close, and a 5xx routes into the ordinary reconnect ladder.
- The connection owner has to keep a `DialPlan` and a socket factory as separate objects, which is
  more machinery than calling `new WebSocket(url)`. That is the price of the vendored gateway client
  taking only a URL in its `socketFactory` hook.
