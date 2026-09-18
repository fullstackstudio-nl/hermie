# 0006. One gateway per install, no cross-gateway bot relay

- Status: Accepted
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
