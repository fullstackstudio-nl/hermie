# 0006. One gateway per install, no cross-gateway bot relay

- Status: Accepted, amended 2026-09-22 (a list of gateways; the relay decision stands)
- Date: 2026-09-19

## Context

Hermes Desktop can hold connections to several gateways at once and, while it is open, acts as a
router between them: it pushes each gateway a roster of the agents on the other connections and
drains queued bot-to-bot envelopes from one gateway to deliver them on another. That relay only
works while the client is running, and a single delivery can block for up to 25 minutes while the
receiving bot runs a full turn.

A phone app is backgrounded, suspended and killed constantly. A relay that depends on the app
staying in the foreground would deliver messages sometimes and drop them silently the rest of the
time, and the user would have no way to tell which case they were in.

## Decision

Hermie connects to **exactly one gateway**. Setup adds it; changing the gateway means running setup
again, which also clears the local cache. Hermie never runs the relay loops. Bots message each other
only within that gateway, where delivery is handled entirely server-side and therefore works while
the app is closed.

## Consequences

- Multi-gateway users keep using Hermes Desktop for cross-gateway traffic.
- Connection state, credentials and caches are keyed by a single configuration, which keeps the
  storage and the state machine simple.
- If a future Hermes release moves the relay into the gateway itself, Hermie can show that traffic
  without any client-side routing.

## Amendment, 2026-09-22: one CONNECTION, not one gateway

[ADR-0024](0024-a-list-of-gateways.md) supersedes one sentence of this record and leaves the rest
exactly as it is.

**What stands.** The Decision's first and last sentences are the relay argument and they are
unchanged: Hermie holds exactly one live connection, never runs the relay loops, and bots message
each other only inside the gateway they live on, where delivery is handled server-side and therefore
works while the app is closed. A phone cannot be a router between two gateways, and nothing about
keeping a list changes that.

**What is superseded** is the sentence in between:

> Setup adds it; changing the gateway means running setup again, which also clears the local cache.

That was never about the relay. It was true because there was one of everything on disk, so
replacing the gateway meant overwriting all of it. ADR-0024 keys every stored thing by a gateway id,
which makes a second gateway a second set of keys rather than a second connection. Setup still adds
one; changing between two now costs a teardown and a dial, and neither one's cache is cleared.

**And the Consequence this leaves standing differently.** "Multi-gateway users keep using Hermes
Desktop for cross-gateway traffic" is still true and still the reason: cross-gateway TRAFFIC — a bot
on one gateway messaging a bot on another — needs a router, and Hermie is not one. What multi-gateway
users no longer need Desktop for is simply _reading two gateways from one device_.
