# @hermie/transcript

The chat engine behind Hermie: everything between the gateway wire and the
screen, with nothing on it that knows what a screen is.

Pure TypeScript — no DOM, no Node, no React. Its only dependency is
[`@hermes/shared`](../hermes-shared), and only for wire types.

## Why it exists

A Hermes bot chat arrives over two very different paths. Loading a chat gives
you persisted rows (`session.history`, or the REST transcript when the session is
long); watching one gives you a stream of events. If those two paths build
different objects, the chat visibly changes shape the moment you reconnect.

So both are projected onto one item model:

- `rows-to-items.ts` turns rows into items.
- `reducer.ts` turns events into the same items.
- `reconcile.ts` folds a fresh projection into the live one without renaming
  anything, so a UI keyed on `item.id` never remounts the whole thread.

## The item model

`ChatState` is normalised: an id-keyed `items` map, an `order` array, and
indices (`byToolId`, `byRowId`, `byRequestId`, `byProcessId`, `byDelegationId`).
Item kinds:

| kind                   | what it is                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `user`                 | a human turn, a `/skill` invocation or a mid-turn steer                               |
| `bot_dm_in`            | an inbound message from another bot — arrives on the `user` role but is not the human |
| `assistant`            | the bot's reply, including reasoning, interim commentary and failures                 |
| `tool`                 | one tool call, with whatever the gateway's verbosity level revealed                   |
| `bot_dm_out`           | one outbound `message_agent` dispatch, plus the reply when it lands                   |
| `subagent_group`       | one `delegate_task` fan-out; the children live in `ChatState.subagents`               |
| `status`               | a transient one-liner (`status.update`)                                               |
| `notice`               | a display-only timeline event (model switch, background process, …)                   |
| `approval` / `clarify` | a question the agent is waiting on                                                    |

Every item carries `origin` (`history` / `live` / `optimistic` / `inflight` /
`foreign`) and a `version` counter. `origin` decides what reconciliation may
drop; `version` makes memoization cheap.

Two rules the reducer never breaks:

1. **It never filters.** Verbosity and the bot-to-bot toggle are read-time
   decisions, so flipping one is instant and lossless.
2. **It never invents an author.** A turn that starts without a local submit is
   a _foreign_ turn — a teammate bot, or the same chat open on a desktop. The
   reducer stands a placeholder in and sets `turn.foreignReconcilePending`; a
   tail fetch fills it in.

## How a UI should use it

Read through `selectors.ts`, never through `state.items` directly:

```ts
const rows = visibleItems(chat, { level: 'normal', showBotToBot: true, showThinking: false })
```

Each entry is `{ item, presentation }` with `presentation` one of `full`,
`collapsed`, `chip` or `hidden-placeholder`. Roughly:

|                               | quiet                                         | normal      | verbose |
| ----------------------------- | --------------------------------------------- | ----------- | ------- |
| user / assistant / inbound DM | full                                          | full        | full    |
| tool                          | one `hidden-placeholder` for the running call | collapsed   | full    |
| outbound DM, subagent group   | chip                                          | collapsed   | full    |
| status                        | latest only, while busy                       | latest only | all     |
| notice                        | errors only                                   | collapsed   | full    |
| approval / clarify            | full                                          | full        | full    |

`showBotToBot: false` demotes DM traffic to a chip — it never removes it.
Hiding the message a teammate sent would leave the bot answering a question
nobody asked. `showThinking: false` strips `reasoning` from the items handed
back and hides a bubble that holds nothing else.

`visibleItems` does no caching on purpose. Memoize it on
`(itemsVersion(state), options)`.

Other selectors: `openRequests`, `runningSubagents`, `subagentTree`,
`latestStatus`, `isBusy`.

## Wire conventions

Hermes has no DM event type. Bot-to-bot traffic is recognised from transcript
conventions, so those strings are load-bearing. Each parser in `bot-dm.ts` cites
the upstream file that writes them.

**Inbound.** A delivered message arrives as a `role: user` row whose text starts
with `Message from 🤖 <name> (@<handle>): `. The emoji and the `(@handle)` are
both optional, and an older install writes `[Message from agent '<name>'] `
instead. The matching regex is copied verbatim from
`apps/desktop/src/components/assistant-ui/thread/user-message.tsx`; the prefix
itself is written by `tools/bot_mode_dm.py` (`content = f"Message from 🤖
{display_name} (@{handle}): " + body`).

**Outbound.** `message_agent` is fire-and-forget. The tool returns
`{"status": "queued", "delivery_id": …, "to": …, "process_id": …}` — a hand-off
to a background delivery process, _not_ a delivery receipt. Failures come back
as `{"error": …, "reason": …}` and an unconfirmable hand-off as
`{"status": "ambiguous", …}` (`tools/bot_mode_dm.py::_spawn_delivery`, `_err`).

**The reply.** It lands later as a `role: user` row with
`display_kind: 'process_complete'` whose text is one or more blocks written by
`tools/process_registry_notifications.py`:

```
[IMPORTANT: Background process <sid> completed (exit code 0).
Command: <command>
Output:
<output>]
```

A batch puts a `N background processes completed.` header first and separates
blocks with a blank line; a watch match says `matched watch pattern "…"` and
`Matched output:` instead. The join is `<sid> == process_id` from the dispatch
ack — exact, and the reason `byProcessId` exists. When that index is cold (a
transcript loaded from history carries no tool results), the fallback is the
nearest preceding unanswered dispatch to the same handle, recovered from the
command: both delivery forms run `hermes -p <profile> chat …` for the recipient.

A block is ours when its command matches `bot_mode_dm.py --run-delivery` (the
current runner) or the legacy `-p <profile> chat … -q "Message from` form that
`agent-delivery.tsx` still recognises. `<output>` is either the recipient's
reply as plain text — possibly echoing the `Message from …:` prefix back, which
is stripped — or the JSON record `{"status": "settled", "reply": …}` /
`{"error": …, "reason": …}` the live-owner branch prints.

**Attribution.** An assistant turn that directly follows an inbound DM is
answering _that bot_, not the human, and is marked `replyToBotHandle` — unless
this chat dispatched a `message_agent` to that sender earlier in the same
exchange, in which case the inbound row is the answer to our own dispatch
(`answersOurDispatch`) and the round trip is complete. Ported from `dispatchedTo`
in `agent-delivery.tsx`: the scan stops at the nearest earlier human turn or at
an earlier inbound row from the same sender, so one dispatch exempts only the
answer that follows it.

**Target aliases.** `@writer`, `Writer`, `scribe@laptop` and `peer/scribe` all
name one routing alias. `normalizeAgentTarget` reduces them the same way the
desktop does: strip a leading `@`, strip an `@<connection>` suffix, keep the last
`/` segment, lowercase.

## Layout

| file                   | what it owns                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `types.ts`             | the item model and `createChatState`                           |
| `bot-dm.ts`            | every bot-to-bot wire convention                               |
| `rows-to-items.ts`     | history rows → items, for both transports                      |
| `reducer.ts`           | gateway events, server requests, resume snapshots, local turns |
| `subagent-progress.ts` | `subagent.*` payload → `Subagent`                              |
| `reconcile.ts`         | stable-id merge and tail reconcile                             |
| `selectors.ts`         | verbosity, bot-to-bot, subagent views                          |
| `cache.ts`             | the offline snapshot shape                                     |

Tests sit next to the code as `*.test.ts`, with hand-written wire fixtures under
`src/__fixtures__/`.

## Licence

MIT © FullStack Studio. The upstream behaviour documented here belongs to
NousResearch/hermes-agent (MIT); see the repository's `THIRD_PARTY_NOTICES.md`.
