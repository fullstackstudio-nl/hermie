# 0013. A cron delivery is its own item kind, detected from its header

- Status: Accepted, amended 2026-09-21 (the `quiet` exemption covers work the owner dispatched, and what
  the owner typed)
- Date: 2026-09-19

## Context

A scheduled job can deliver its output into a bot's chat. When it does, Hermes does not announce it:
there is no event for it, and the row it leaves behind carries **no reliable marker of any kind**.

`cron/scheduler_delivery.py::_deliver_to_bot_chat` (defined at line 771 of the pinned upstream commit
`b9c2660`, header built at lines 798–801) injects the report as a REAL INBOUND TURN into the target
profile's Bot Chat, so it persists as an ordinary `role: "user"` row. The only thing separating it
from the owner typing is the header spliced in front of the report:

```
[Cronjob "<job name>" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]

<content>
```

The same file writes a second, different header for platform mirrors
(`_cron_mirror_message`, line 197). That one reaches a chat too, with `role="user"`:

```
[Cron delivery: <job name>]
<text>
```

Neither path sets `display_kind`: `grep -rn display_kind cron/` over the upstream tree matches
nothing. The mirror does pass `source_label="cron"` to `mirror_to_session`, but that label never
reaches the transcript — `gateway/mirror.py::_append_to_sqlite` (line 139) calls
`db.append_message(session_id, role, content)` and drops `mirror` and `mirror_source` on the floor,
and the `messages` table (`hermes_state_common.py`, lines 401–428) has no column for either.
`mirror_to_session`'s own docstring says so: the mirror metadata is dropped at the SQLite boundary.
So by the time a client can read the row, `role`, `content` and `timestamp` are all it has.

The job name is passed through `_redact_cron_payload`, which is fail-closed: if the redactor raises,
the name comes back as the literal string `[REDACTED - redaction failed]` (line 186). A name can
therefore contain quotes, brackets, or be no name at all.

Hermes Desktop does not special-case either header. `apps/desktop/src/lib/chat-messages/hydration.ts`
branches on `display_kind` for `model_switch`, `personality_switch`, `auto_continue`,
`process_complete` and `async_delegation_complete`, and a cron row has none of those, so it falls
through to the ordinary user-message path and is drawn as the owner's own bubble. Grepping
`apps/desktop` and `ui-tui` for `Cronjob`, `Cron delivery` and `source_label` turns up only the
Cronjobs pane titles and an unrelated OAuth field. Hermie inherited the same bug: the owner appeared
to have pasted a machine's report to themselves, in raw markdown.

That is wrong twice over. It is not the owner speaking, and it is not speech at all — it is a
result, and a result wants a card.

## Decision

A cron delivery is its own transcript item kind, `cron_delivery`, recognised by its header in one
module (`packages/transcript/src/cron-delivery.ts`) and projected identically by the history path
(`rows-to-items.ts`), the live path (`reducer.ts`) and reconciliation (`reconcile.ts`).

The detection is a HEURISTIC, because the wire offers nothing better. It is the narrowest one that
still matches what the gateway writes:

- the header must be anchored at the START of the row text, with only whitespace before it — a bot
  quoting the header in prose, or fencing it in a code block, is not a delivery;
- the header must occupy its own single line, closing bracket last;
- the `_deliver_to_bot_chat` instruction sentence is matched word for word, not loosely on
  `[Cronjob`, because that sentence is fixed text and the job name is the only variable in it;
- the job name is read greedily up to the last closing fragment on the line, so a name holding `"`
  or `]` survives;
- a row the gateway DID label wins: the check does not run when `display_kind` is set, because a real
  marker outranks our guess.

It is notice-class, not speech, but it survives `quiet` — it is the result the owner scheduled, so
`quiet` folds the report rather than dropping it — and the bot-to-bot toggle does not touch it,
because the scheduler is not a peer bot.

## Consequences

- The header strings are load-bearing, exactly as the bot-to-bot conventions in
  [0009](0009-bot-to-bot-detection.md) are. They live in one module with fixture tests, so an
  upstream change breaks a test rather than the UI.
- What breaks the heuristic, in rough order of likelihood:
  - **an upstream wording change** to either header. The delivery is drawn as an ordinary user
    bubble again — the old bug, not a new one, which is the failure mode we want.
  - **a localised gateway.** No current build translates the header; one that did would be invisible
    to this rule. Detection would then need a real marker, which means an upstream change.
  - **a user who types the header themselves.** Indistinguishable from the real thing, and drawn as
    a cron card. Worse, a message they typed reaches the live path as a `user` item and the persisted
    row as a `cron_delivery` one, so the two do not reconcile and the turn shows twice until the next
    full hydration. We accept it: the alternative is refusing to detect deliveries at all.
  - **a job name containing the header's own closing fragment**, which would cut the name short.
- Two shapes mean two code paths to keep honest. The item records which one matched, so a card can
  say how the report got there and a future upstream that keeps only one shape is a deletion rather
  than a rewrite.
- `reconcile` needs no merge rule for the new kind: the stream learns nothing about a delivery the
  persisted row does not also carry, so the default merge is already correct. A test pins that.

## Amendment, 2026-09-21: the `quiet` exemption is about who asked, not about cron

This record gave a cron delivery one privilege the rest of the notice family does not have: it
survives `quiet`, folded rather than dropped. The reason written down was that it "is the result the
owner scheduled — the reason they opened the chat".

[0018](0018-injected-rows-are-notices.md) gave two more row kinds the same card treatment: a
`delegate_task` fan-out reporting back, and a background process that exited. Once they were cards,
`quiet` dropped them — and that made the stated reason inconsistent with itself, because those are
results the owner dispatched too. A fan-out that ran for fourteen minutes is exactly the row somebody
reopens the chat for, and it disappeared at the level people leave the app on.

So the exemption is restated as what it always meant: **`quiet` keeps a row the owner asked for, and
drops the machine narrating itself.** `cron_delivery`, `async_delegation_complete` and
`process_complete` stay, folded. `internal_notification` — which is where a kanban event, a
compaction handoff and a roster refresh land — plus `model_switch`, `personality_switch` and
`auto_continue` stay hidden, because nobody asked for those. The rule lives in `selectors.ts` with a
test per kind, and the cost is unchanged: a chat with a busy fan-out shows more at `quiet` than a
strict reading of "quiet" would suggest, which is the trade this record already made once.

## Amendment, 2026-09-21: a command's answer is the strongest case the rule has

The amendment above restates the exemption as **`quiet` keeps a row the owner asked for, and drops
the machine narrating itself**, and admits `cron_delivery`, `async_delegation_complete` and
`process_complete` on that basis. A slash command's answer belongs in the same family and is a
stronger case than any of them, because the asking and the answering are seconds apart: the owner
typed `/status`, and `/status` is the whole of what they are looking at the screen for.

It was not in the family. `slashOutput` emitted an ordinary `notice`, so `quiet` — the level the app
ships on, and the one nobody changes — dropped it. The owner's report: "command response altijd
zichtbaar; nu alleen zichtbaar als thinking aan staat". The answer existed only for a reader who had
already turned verbosity up for an unrelated reason.

So `command` is its own `NoticeKind`, and it goes one step further than the three kinds above. They
survive `quiet` FOLDED, because they report back minutes or hours later and a reader scrolling past
is entitled to skim them. A command's answer is `full` at every level and **opens itself**, like an
`error` and for a related reason: a disclosure the reader has to notice and tap is, from where they
are sitting, a command that did nothing. The fold stays — `useExpanded`'s `defaultOpen` is a starting
position and not a rule, and a reader who closes a five-kilobyte `/help` finds it closed again when
the list scrolls it back.

Two consequences worth writing down:

- **The kind is this client's, not the gateway's.** `reducer.ts` accepts `noticeKind` off a `notice`
  event for the single value `command` and maps everything else — including kinds it knows — onto a
  plain `notice`. The privilege is "the owner typed the thing this answers", and only the surface
  that saw them type it can assert that. A gateway that started sending the field could otherwise
  promote its own narration into the one family `quiet` cannot drop.
- **One shape, whatever the length.** Title is the command as typed, body is the whole answer, always.
  It used to depend on the length — one line went in the title with an empty body, which `NoticePill`
  then drew with no disclosure at all, while a longer one was titled `/help — 214 lines`. Two shapes
  meant a reader had to work out which one they had before they could read it, and the short one
  could not be folded away at all.
