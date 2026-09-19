# 0012. The chat list's arrangement and colours are client-local

- Status: Accepted
- Date: 2026-09-19

## Context

The chat list is one row per bot profile, and the gateway decides which profiles exist. It does not
decide anything else about the list. Hermie now offers four things that change how that list reads:

- a manual order,
- named dividers between groups (`Work`, `Finance`, …),
- archiving a bot so it stops counting,
- a per-chat colour, chosen from eight swatches plus Default.

None of these has anywhere to live on the gateway. A profile row carries a name, a description, a
model and an avatar; there is no per-client scope on it and no free-form metadata a client may
claim. The nearest thing — writing through `config.set` — is the **global** configuration file, the
same one Hermes Desktop, the TUI and the messaging platforms read. That is the exact trap ADR-0008
documented for verbosity: a setting made on a phone silently changing what a colleague's desktop
shows.

There is also a question of whose arrangement it is. Two people can use the same gateway. One of
them grouping four bots under "Finance" is a statement about how they work, not about the bots.

## Decision

The arrangement and the colours are **local to the device**, stored in the app's key-value store,
and never sent to the gateway.

They are keyed by **gateway address**, which decides the two paths that matter without any
clean-up code:

- **Change gateway** lands on a key that has nothing stored under it, so the list starts in roster
  order. A different machine's bots are a different list.
- **Sign out** keeps the address, so the arrangement is still there when the same person signs back
  in.

The roster stays the source of truth for which rows can exist. The layout only ever says where a row
sits, so the two are folded together on every roster read (`reconcile`): a bot that appears lands at
the end of the unsectioned top group, and a bot that no longer exists is dropped without disturbing
anything around it. Archiving does not move an entry — it only hides it — so unarchiving puts the row
back exactly where it was.

## Consequences

- The arrangement does not follow a person to a second device, and is lost with the app's data. That
  is the price of not writing to a global file, and it is the same trade ADR-0008 made.
- An archived bot is excluded from the filter chips, from the unread totals and from Activity's
  background loading. Archiving is therefore a real "stop bothering me", not a visual fold — which is
  also why it has to be reversible from the list rather than only from Settings.
- Because the layout is a plain store with no gateway in it, all of the ordering logic is testable
  without a connection, which is where `__tests__/chat-layout-store.test.ts` lives.
- If the gateway ever grows a per-client metadata scope, this is the one module to change: nothing
  above it knows where the arrangement is stored.
