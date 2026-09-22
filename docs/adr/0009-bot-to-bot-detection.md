# 0009. Bot-to-bot traffic is detected from transcript conventions

- Status: Accepted, amended 2026-09-22 (bot-to-bot is an aside — both directions — and it never moves a count)
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
- Bot messages are rendered as first-class items, not as generic tool cards. _What that looks like was
  restated on 2026-09-22; see the amendment below._

## Amendment, 2026-09-22: it is an aside, and it never moves a count

This record decided WHAT bot-to-bot traffic is. It said almost nothing about how it should look, and
the two sentences it did say — "quoted → Writer blocks and tinted bubbles" — turned out to be the
wrong half of the decision. The owner, on seeing it: _bot-to-bot messages must not be seen as chat
bubbles. The message to another bot must simply sit on the left and be expandable — same design as
thoughts. The replies too. Bot-to-bot must also not bump the notification badge._

### Presentation

**Both directions are an aside**, which is the silhouette `ReasoningDisclosure` already had: left,
no bubble, no tail, no card, muted ink at the smaller size, a one-line header (`To @handle` /
`From @handle`) with the time and a chevron, and a body that is Markdown and selectable. One
component (`chat-ui/BotDmAside.tsx`) draws both, replacing the tinted `BotDmInBubble` and the
`BotDmOutLine` whose expanded body sat on a `GlassSurface`.

The reasoning is the one [0018](0018-injected-rows-are-notices.md) makes about the owner's bubble,
turned outward. That record's rule is that a transcript must not claim somebody said something they
did not say; this is the same rule about the CONVERSATION rather than about the speaker. A bubble
with a tail is the app saying "this is the exchange you are in". Two agents settling a delivery
between themselves is not that exchange — it is an aside about it, exactly as a thought is an aside
about the reply under it — and drawing it as speech makes the reader parse a conversation that is
not theirs before they can find the one that is.

**Closed at every level, including `verbose`.** `selectors.ts` therefore hands these rows `collapsed`
and never `full`; `full` is the presentation the bubble and the glass card were drawn from, so not
emitting it is what keeps the rule from being re-broken by a renderer. `verbose` is turned up to see
tool calls, and it used to open a teammate's whole message as a side effect. The reader opens one by
tapping it, and `useExpanded` holds that choice against the item's id, so virtualisation scrolling an
open aside out of the window and back does not close it.

**One case for both directions**, which the first pass at this did not have: `bot_dm_in` and
`bot_dm_out` had a branch each in `visibleItems` and the branches disagreed. `quiet` — the DEFAULT
level — demoted a dispatch to a chip reading `Message to @writer` while the answer to it stayed an
aside beside it, so the sending side was the one shape the shared design had never reached. A
DIRECTION IS NOT A VERBOSITY: the same traffic gets the same row whichever way it went, and the only
thing that folds either of them to a chip is the toggle below.

**The `showBotToBot: false` promise is unchanged**: the toggle demotes to a chip, it does not hide.
A DM the reader cannot see at all makes the bot's own reply unexplainable, which is the sentence at
the top of `selectors.ts` and still true.

**The roll-up keeps its shape and widens its run.** More than three consecutive asides still
collapse into `6 messages with @writer · 4 replies`, and opening it reveals the asides, each still
closed. The owner asked for the mechanism as it is, so only the membership changed: the run holds
BOTH DIRECTIONS. Gathering only dispatches was right while an inbound message was a bubble — a bubble
is not part of a run of lines — and wrong the moment both directions became the same aside: an
exchange of eight rows rolled up as two runs of four with an answer standing between them, and a
single answer in the middle of a long errand broke the run in half. The summary says `with` rather
than `to` for the same reason, and `replies` stays the count of DISPATCHES that were answered —
an inbound row is somebody else's message, not an answer to one of ours.

Spacing is keyed on the PAIR rather than on mere adjacency, so a dispatch and the answer to it sit
tight and an errand to a different teammate starts a new run. An inbound DM is no longer a
`speakerKey`, because it has no tail to withhold and no corner to tuck.

`subagent_group` keeps its card. It was never drawn as a bubble, so there was nothing to align.

### The badge rule

**A bot-to-bot row never moves a count.** `countsAsMessage` in `selectors.ts` is the one place this
is decided, so `bot_dm_in` leaving it covers the chat row's pill, the folder aggregate and the widget
snapshot at once; `bot_dm_out` and `subagent_group` never counted, and the three kinds are now one
written rule rather than one rule and two accidents of an `if`. The transcript's own "jump to latest"
pill kept a second copy of the list in `ChatScreen` and is brought into line with it.

A badge answers one question — is there something here for me — and a bot that dispatches to a
teammate every few seconds produced a chat list that was permanently shouting about work nobody had
to look at. `lastMessageAt` shares the predicate, which is what keeps "read" and "unread" from
disagreeing about what a message is.

**`hasOpenRequest` is untouched.** A question raised by a teammate's work still asks for the reader,
because somebody asked THEM. The rule is about mail, not about attention.

**Push needed no change, and now has a test saying so.** `hermie-web --push` still knows the `dm`
type and still classifies an inbound delivery as one, but a registration written by this app carries
no `dm` key at all — `pushTypesOf` in `gateway-client` drops it — and the daemon reads an absent type
as off. So the rule is kept by the registration rather than by the daemon, and `watcher.test.ts` pins
both halves: nothing goes out for a bot-to-bot delivery, and an ordinary reply on that same
registration still does.

**What this does NOT cover.** The plain dot beside a chat row's count comes from the roster's
`last_active`. The gateway says a chat moved and says nothing about what moved in it, so a chat whose
only new rows are bot-to-bot can still show a dot. Closing that needs something on the wire this
client does not have, and inventing it from the transcript would mean claiming a chat is caught up on
evidence the client may not hold — a worse error than a dot.

## Amendment, 2026-09-22 (second): the reply that leaked, and the one classifier

The rule above — bot-to-bot traffic is never speech — was enforced by each path that builds items,
and there were two of them: `rows-to-items` for a persisted row and `readInflightPrompt` for a
resume's `inflight.user`. They carried the same chain of parsers in the same order, written twice,
and they had drifted.

What fell through both was the DELIVERY REPORT: the teammate's answer as
`[IMPORTANT: Background process <sid> completed …]`, with the delivery command and the reply in its
output, on the `user` role. `parseInjectedRow` refuses that text rather than guessing at its body
(see [0018](0018-injected-rows-are-notices.md) and `processCompletionBody`, whose refusal is correct:
the persisted projection hands each delivery block to the dispatch that spawned it and only the
leftovers become a notice, and which blocks those are is a question the text cannot answer on its
own). Refusing, it handed the row to the last branch in the chain — the owner's own bubble. So on a
gateway that labels the row nothing, and on every resume during such a turn, the reader got the
command line and the teammate's words in their own colour. Reported as _"sometimes the reply bubbles
do come up"_, and "sometimes" was the two conditions.

**The chain is now one function**, `classifyUserRow` in `rows-to-items.ts`, with one new answer:
`bot_dm_reply`, the report itself. What that answer MEANS is left to the caller, because the reply
belongs on the dispatch that asked for it and only a caller holding the transcript can find it:

- `rows-to-items` runs the same block-attribution branch a labelled row takes, so a labelled and an
  unlabelled report project identical items. That identity is not cosmetic — reconciliation pairs two
  descriptions of one row on what they say, and before this the two descriptions were a notice and a
  bubble;
- `applyResumeSnapshot` projects NOTHING. It cannot make the join (the dispatch is a tool row the
  snapshot says nothing about, and it may be off screen), so it leaves the row to the tail fetch,
  which has the whole transcript to join against. The foreign `message.start` placeholder is dropped
  rather than filled, which the selectors already draw as nothing.

**The invariant is a table, not a promise.** `bot-to-bot.test.ts` runs every entry path — RPC
history, REST history, a labelled row, a REST tail onto an empty chat, a REST tail filling a
placeholder, a resume, a resume followed by its tail, a live dispatch followed by the tail that
answered it — against every wire shape this traffic has, and fails if any of them produces a `user`
or `assistant` item carrying a delivery signature, a process header or the runner's command line. A
new path has to add itself to that table; the suite also refuses a third module in the package that
builds a `user` item at all, which is the shape the leak had.

### The dispatch that appeared twice

Reported in the same breath as the leak: a message to another bot _"sometimes duplicates
itself and shifts between the messages"_.

A dispatch is a TOOL row, and reconciliation pairs a live item with the persisted one on
`rowId`, then `toolId`, then `itemMatchKey`. A `bot_dm_out` had no text key at all —
`normalizedItemText` returned the empty string for it, so `isMatchable` refused it — which
left the tool id as the only thing the two descriptions could share. That holds exactly as
long as the id the stream saw survives into the database. It does not always: a gateway may
re-key the call, and a history projection that ships no `tool_id` lands on this module's
`row-<index>` fallback. With no id in common, `reconcileTail` appends the persisted row
beside the live one and the reader has the errand twice.

The SHIFT is the same fact seen from the list. Only one of the two copies carries a `rowId`,
and `inRowOrder` sorts a row without one by the newest row id ABOVE it — which changes as
the turn writes more rows, so the copy moves between the messages while its twin stands
still.

A dispatch is now matchable by what it says: `normalizedItemText` returns its message, and
`itemMatchKey` puts the TARGET HANDLE in the slot the attachments occupy for a user turn, so
one message sent to two teammates stays two rows while two descriptions of one dispatch
collapse. The merge also keeps the live timestamp, because a tool row carries none and the
moment the message went out is known only to the stream that watched it leave.
