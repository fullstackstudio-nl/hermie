# 0018. A row the gateway injected is a notice, recognised by its shape

- Status: Accepted
- Date: 2026-09-21
- Builds on: [0009](0009-bot-to-bot-detection.md), [0013](0013-cron-deliveries-in-the-transcript.md)

## Context

Hermes starts a turn by writing a `role: "user"` row and running the agent on it. Most of those rows
are the owner typing. Some are not. A `delegate_task` fan-out that finishes, a background process
that exits, a kanban event, a compaction handoff — each is injected as a real inbound turn, on the
same role, with the same shape.

Most of them carry a `display_kind` when they are persisted, and `rows-to-items.ts` has always read
it. Two things break that:

- **The live path never sees it.** A foreign `message.start` carries no author, so the reducer stands
  up a blank placeholder and waits. What fills it is `session.resume`'s `inflight.user` — a string,
  with no metadata beside it. So a fan-out's report reached the screen as the owner's own bubble,
  opening `[ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada]`, signed by somebody who typed none of
  it. Seen on a live 0.21.3 gateway and confirmed against its `state.db`.
- **Not every writer sets one.** The kanban and notification pollers hand `_notif_submit` their
  formatter's output with no `display_kind` at all, older gateways never wrote the column, and the
  REST transcript route does not ship it.

Enumerating the headers is not enough on its own: the pollers dispatch formatter output this client
has never seen, and upstream adds shapes faster than a list can follow.

## Decision

A gateway-injected row is a notice, and it is recognised from its SHAPE in one module —
`packages/transcript/src/injected.ts` — used by the history path, the live path and reconciliation,
exactly as [0013](0013-cron-deliveries-in-the-transcript.md) does for cron.

The shape, deliberately the narrowest one that still catches every writer we read:

- anchored at the start of the row, only whitespace allowed in front;
- the first character is `[`, and the token behind it **shouts**: two or more upper-case letters or
  digits, beginning with a letter, not running on into lower-case. That single test is what keeps
  prose out — `[ok] done` and `[1] first item` are somebody typing, `[PRIOR CONTEXT …]` is not;
- the bracket has to CLOSE, in one of the two ways these writers close it: the header is a line of
  its own with the payload underneath, or it opens a block that ends with `]` further down.
  `[IMPORTANT: Background process …` does the second, so "closes on the first line" alone would have
  missed it;
- something has to follow the header. A bracketed shout with nothing under it is a label somebody
  typed;
- `[OUT-OF-BAND USER MESSAGE …]` is excluded by name. It is the one bracketed shout that IS the user
  speaking — the wrapper a mid-turn steer is delivered in — so the wrapper comes off and the words
  stay a bubble.

The kanban poller writes no bracketed header at all (`<glyph> [<board>] @<who> Kanban <id> …`), so it
gets a second, equally narrow rule anchored on the glyph set and the literal word `Kanban`.

A notice pairs on its BODY, not on its title. The gateway titles a persisted row from its own
`display_metadata.display_text`, and a projection reading `inflight.user` cannot know that title, so
the two descriptions of one row are allowed to disagree about what it is called and never about what
it says.

## Consequences

- The shape is load-bearing in the way the strings in [0009](0009-bot-to-bot-detection.md) and
  [0013](0013-cron-deliveries-in-the-transcript.md) are, but it degrades better: an upstream header
  that changes its wording still shouts and still closes, so it is still a card. Only a header that
  stops shouting, or stops closing its bracket, falls back to being a bubble — the old bug, not a new
  one, which is the failure mode we want.
- **What it gets wrong.** A message whose first line is an all-caps bracketed label with text
  underneath — `[TODO]`, then the task — is drawn as a notice. It is the price of not needing a list,
  and it is the direction we would rather be wrong in: a machine's report drawn as speech is a
  transcript telling a lie about who spoke, while a person's note drawn as a card is only ugly.
- **One case is deliberately not covered.** An `[IMPORTANT: …]` completion carrying a bot-DM delivery
  block is left alone live. The persisted projection folds such a block into the `message_agent`
  dispatch it came from and keeps only what is left over, and nothing in the text says whether that
  dispatch is on screen — so a guessed body would not pair, and the row would be drawn twice. Closing
  it means doing the DM attribution on the live path, which needs a process id history does not
  carry.
- **Not covered either:** upstream's non-shouting scaffolding prefixes (`[System:`,
  `[Your active task list`, `[Planning state preserved`, `Cronjob Response:`). They fail the
  upper-case test by design; if they reach a transcript they are still bubbles. — _Superseded the
  same day; they did reach one. See the addendum below._
- Matching a notice on its body rather than on `title + body` applies to every notice kind, not only
  these. Two notices with identical bodies and different titles now share a pairing key. That key is
  a last resort — a row id or a tool id wins first — and each candidate pairs once, so the cost is
  bounded to an unlikely mis-pairing inside one reconcile.
- At `quiet`, a fan-out report and a process completion stay on screen, folded. See the amendment to
  [0013](0013-cron-deliveries-in-the-transcript.md) of the same date for why the exemption is about
  who asked rather than about cron.

## Addendum, 2026-09-21: the scaffolding that does not shout, and where it is allowed to appear

The chat list showed a row for "Abuse agent" whose preview was
`[System: The active model for th…`. Two separate holes, one screenshot.

**The rest of upstream's list is now covered.** The consequence above ends "if they reach a
transcript they are still bubbles", and they did. Each of the four non-shouting prefixes gets its own
narrow rule in `injected.ts` rather than a widened shape, because widening the shape until a lower-case
`[System:` matched would take ordinary prose with it:

- `[System: …]` — the marker opens the row and its bracket is the LAST thing on the row. Every writer
  of this prefix (a model switch, a personality change, the continuation prompts in
  `agent/conversation_loop.py`, `verification_stop`, `surface_switch`, `kanban_stop`) builds one
  bracketed sentence and appends nothing after it.
- `[Your active task list …]` and `[Planning state preserved …]` — fixed opening words, bracket
  closing on the same line.
- `Cronjob Response:` — the only shape here with no bracket anywhere, so all three of its lines are
  matched (name, `(job_id: …)`, the rule of dashes). It lands as an `internal_notification` rather
  than a cron card: the card's contract is [0013](0013-cron-deliveries-in-the-transcript.md)'s two
  headers, and this is a third shape with its own name/body split.

**A `[System: …]` note is UNWRAPPED for display**, and that is the one place this ADR is lossy on
purpose. Everything else keeps the row whole because a card may need to show exactly what the gateway
wrote; a system note has nothing under the header, so the wrapper would be all a reader gained from
it — and it is the thing they were never meant to see. The unwrap happens in one place on each path
(`parseInjectedRow` live, the `notice()` helper in `rows-to-items` for history), so the two
descriptions of one row still agree on what it SAYS and still pair.

**What it gets wrong, restated for this shape.** A person typing `[System: my own note]` is
indistinguishable from the convention and is drawn as a system line. Upstream has the same hole and
documents it (`agent/title_generator.py`). The closing-bracket test is what narrows it:
`[System: my own note] how do I …` — far likelier to be typed — stays a bubble.

**`system_note` is deliberately not an `isInjectedNotice` kind.** Some of its writers DO open a turn;
the model-switch and personality markers are spliced in MID-turn. The text cannot tell them apart,
and the two errors are not symmetrical: an unrecognised turn-opener costs a blank placeholder the
selectors already draw as nothing, while a mid-turn marker mistaken for the opener would make every
resume compare the real prompt against a marker, miss, and paint the prompt twice.

**Presentation: a system line, not a card.** `model_switch`, `personality_switch`, `auto_continue`
and `system_note` render as one centred line of muted secondary text — no bubble, no glyph well, no
hairline, no fold. A disclosure promises a payload, and a payload is exactly what this family has not
got; the sentence is the whole content, so it is shown in full and allowed to wrap. The bigger kinds
(delegation, process, prior context) keep the folded card. `quiet` is unchanged: the selector drops
this family before the renderer sees it, so `normal` and `verbose` draw the same line.

**And it is not a chat-list preview.** A row's preview now comes from the transcript's last REAL
message when this client holds one — a bubble the owner typed, a reply, a teammate's DM, a cron
report — and only otherwise from the gateway's `preview` string, run through the same recogniser and
shown without its wrapper in a second, quieter style. The transcript wins even when the string is
newer: the string is only ever the LAST row, so a chat whose last row is a marker has no message in
it to offer, and a preview stale by one row that says what somebody said beats a fresh one that says
what nobody did.
