# 0008. Verbosity is a client-side selector

- Status: Accepted
- Date: 2026-09-19

## Context

The gateway has one setting that controls how much tool activity it sends: `display.tool_progress`
(`off`, `new`, `all`, `verbose`). Only `verbose` includes the full tool arguments and results.
Changing it through the `config.set` RPC writes the **global** configuration file, so a change made
from a phone also changes what Hermes Desktop, the TUI and messaging platforms show. There is no
per-session scope for it.

Users want to switch a single chat between "just the answers" and "show me everything" instantly,
without touching what other clients see.

## Decision

Hermie keeps everything the gateway sends and decides **at render time** what to show. Verbosity
(Quiet, Normal, Verbose), thinking visibility and bot-to-bot visibility are selectors over the
stored transcript, never conditions in the event reducer. Switching a level re-renders without a
refetch. Settings are stored per chat with a global default.

Hermie never changes `display.tool_progress` on its own. It reads the current value and, when it is
`off` or `all`, offers an explicit action in Settings that names the side effect before sending
`config.set`.

## Consequences

- More data over the wire in Quiet mode than strictly necessary; acceptable on mobile because tool
  payloads are small compared to the transcript itself.
- The app must render sensibly in every gateway mode, including `off`, where only UI-required tool
  events still arrive.
- Hiding bot-to-bot messages demotes them to a one-line chip rather than removing them, because the
  bot's next answer would otherwise be unexplained.
