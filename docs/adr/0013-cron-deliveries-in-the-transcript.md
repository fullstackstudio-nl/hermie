# 0013. A cron delivery is its own item kind, detected from its header

- Status: Accepted
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
