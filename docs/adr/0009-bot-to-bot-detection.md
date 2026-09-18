# 0009. Bot-to-bot traffic is detected from transcript conventions

- Status: Accepted
- Date: 2026-09-19

## Context

Hermes has no structured "message from another bot" event. On the sending side, `message_agent` is
an ordinary tool call whose result only says the message was queued (`status`, `delivery_id`,
`process_id`). The target bot's reply arrives much later as a user-role transcript row with
`display_kind: 'process_complete'` whose text starts with `[IMPORTANT: Background process <sid>
completed` and contains the delivery command. On the receiving side the message is a user-role row
whose text starts with `Message from 🤖 <name> (@<handle>): `; the author metadata is not persisted.
Sub-agents, by contrast, do have a dedicated `subagent.*` event family with ids and a delegation id.

Hermes Desktop relies on the same conventions.

## Decision

Hermie detects bot-to-bot traffic from these conventions, implemented once in the transcript
engine (`packages/transcript`):

- an outgoing DM is a `message_agent` tool call; its reply is joined by matching the
  `process_id` from the tool result with the `<sid>` in the `process_complete` row, falling back to
  the nearest preceding DM to the same handle;
- an incoming DM is a user row matching the same regular expression Hermes Desktop uses;
- sub-agents are modelled from the `subagent.*` events, grouped by `delegation_id`.

These rules live in one module with fixture tests copied from real gateway output, so an upstream
change breaks a test rather than the UI.

## Consequences

- A gateway upgrade that changes the delivery text or the result shape needs a fixture update and
  possibly a new rule; the README of the package documents the exact strings.
- Bot messages are rendered as first-class items (quoted "→ Writer" blocks and tinted bubbles), not
  as generic tool cards.
