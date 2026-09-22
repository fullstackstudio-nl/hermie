/**
 * Gateway-injected `role: "user"` rows.
 *
 * Hermes starts a turn by writing a `role: "user"` row and running the agent on
 * it. Most of those rows are the owner typing. Some are not: a fan-out that
 * finished, a background process that exited, a kanban event, a compaction
 * handoff. They reach a client on the same role with the same shape, and on a
 * gateway that sets no `display_kind` — or over a transport that drops it —
 * there is nothing but the text to tell them apart. So they painted as the
 * owner's own bubble, which is the transcript claiming the owner said something
 * they never said.
 *
 * The convention that saves it is upstream's own
 * (`agent/context_compressor.py::_synthetic_user_row`, prefixes at
 * `_SYNTHETIC_USER_ROW_PREFIXES`, pinned commit `b9c2660`): a scaffolding row
 * announces itself with a bracketed header in front of its payload. The writers
 * this module was read against, and what each one writes:
 *
 *   `tools/process_registry_notifications.py`
 *     [ASYNC DELEGATION BATCH COMPLETE — <deleg_id>]      (line 204)
 *     [ASYNC DELEGATION COMPLETE — <deleg_id>]            (line 277)
 *     [ASYNC DELEGATION TASK FAILED — <deleg_id>, task <i>/<n>]  (line 166)
 *     [IMPORTANT: <n> background processes completed. …]  (line 30)
 *     [IMPORTANT: <message>]                              (line 408)
 *     [IMPORTANT: Background process <sid> matched watch pattern "…".
 *      Command: … Matched output: …]                      (line 419)
 *     [IMPORTANT: Background process <sid> <status> (exit code <n>).
 *      Command: … Output: …]                              (line 437)
 *   `agent/context_compressor.py`
 *     [PRIOR CONTEXT — for reference only; not a new message]
 *     … [END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]  (lines 428–429)
 *   `tui_gateway/session_notifications.py`
 *     the notification poller hands `_notif_submit` (line 160) whatever
 *     `format_process_notification` wrote, so those are the shapes above; the
 *     KANBAN poller does not use a bracketed header at all
 *     (`_format_kanban_event_text`, line 331):
 *       <glyph> [<board>] @<assignee> Kanban <task id> done — <title>
 *     with the glyph one of ✔ ⏸ ✖ ⏱ 🔄 and both middle parts optional. It has
 *     its own rule below, because no general shape covers it.
 *
 * Enumerating them is not enough. The pollers dispatch formatter output this
 * client has never seen, and upstream adds shapes faster than a list can follow.
 * So the detection is a SHAPE, and it is deliberately the narrowest one that
 * still catches every bracketed writer above:
 *
 * - anchored at the start of the row, with only whitespace allowed in front;
 * - the first character is `[`, and the token right behind it SHOUTS: two or
 *   more upper-case letters or digits, beginning with a letter, not running on
 *   into lower-case. That single test is what keeps prose out — `[ok] done` and
 *   `[1] first item` are somebody typing, `[PRIOR CONTEXT …]` is not;
 * - the bracket has to CLOSE, in one of the two ways these writers close it:
 *   the header is a line of its own (`]` last on the first line) with the
 *   payload underneath, or the header opens a block that ends with `]` further
 *   down. Either way something has to follow it — a bracketed shout with
 *   nothing under it is a label somebody typed, not a header;
 * - `[OUT-OF-BAND USER MESSAGE …]` is excluded by name. It is the one bracketed
 *   shout that IS the user speaking: the wrapper a mid-turn steer is delivered
 *   in (`agent/prompt_builder.py::STEER_MARKER_OPEN`, line 535).
 *   `stripSteerWrapper` takes it off and the words stay a bubble.
 *
 * Upstream's own list of scaffolding openers is longer than the shouting ones,
 * and the rest of it does NOT shout (`agent/context_compressor.py`,
 * `_SYNTHETIC_USER_ROW_PREFIXES`, lines 867–870). Those get named rules of their
 * own below, each anchored and each as narrow as its writer allows — a prefix
 * test on its own would catch a person typing `[System: my own note] …`, which
 * upstream's own title generator documents as the cost of this convention
 * (`agent/title_generator.py`, line 141). What writes them:
 *
 *   `tui_gateway/server.py::_append_model_switch_marker` (line 1695)
 *     [System: The active model for this chat has changed to <model>[ via
 *      provider <p>]. From this point forward, use this runtime metadata …]
 *   `tui_gateway/agent_callbacks.py` (line 270)
 *     [System: The user has changed the assistant's personality. …]
 *   `agent/conversation_loop.py` (lines 834–880), `agent/verification_stop.py`,
 *   `agent/surface_switch.py`, `agent/kanban_stop.py`
 *     [System: <one instruction addressed to the model>]
 *   `tools/todo_tool.py::TODO_INJECTION_HEADER` (line 21)
 *     [Your active task list was preserved across context compression]
 *     <the list>
 *   the planning counterpart of the same handoff
 *     [Planning state preserved …]
 *   `cron/scheduler_delivery.py` (line 1958), the platform-delivery wrapper
 *     Cronjob Response: <job name>
 *     (job_id: <id>)
 *     -------------
 *
 * Every `[System: …]` one is a single bracketed sentence: it opens the row and
 * the bracket closes it at the very end. That pair is the whole test, and it is
 * what lets `unwrapSystemNote` hand the sentence on without its wrapper —
 * `[System: The active model for th…` is what a chat-list row was showing.
 *
 * A cron delivery and a teammate's DM are recognised before this module runs and
 * keep their own item kinds; neither header shouts, so neither would reach here
 * in any case.
 *
 * What breaks it, in rough order of likelihood:
 *
 * - a user who types `[System: …]` and closes the bracket at the end of their
 *   message — indistinguishable from the convention, and drawn as a system line;
 * - a user whose message opens with an all-caps bracketed label on a line of its
 *   own and carries on underneath (`[TODO]` then the task) — drawn as a notice;
 * - an upstream header that stops shouting, or stops closing its bracket: the
 *   row is an ordinary bubble again, which is the old bug rather than a new one;
 * - a localised gateway, which no current build is.
 *
 * Nothing here is lossy but one thing, on purpose: a notice body is the whole
 * row text, header included, so a card can always show exactly what the gateway
 * wrote — EXCEPT a `[System: …]` note, whose body is the sentence without its
 * wrapper. That row has nothing under the header, so the wrapper would be all a
 * reader gained from keeping it, and it is the part they were never meant to
 * see.
 */
import { isBotDmDeliveryCommand, parseProcessCompleteText } from './bot-dm'
import type { NoticeKind, TranscriptItem } from './types'

/**
 * The notice families an injected row lands in. They are the same values
 * `rows-to-items` gives the rows a gateway DID label, so a row recognised here
 * and the same row recognised by its `display_kind` draw identically.
 */
export type InjectedNoticeKind =
  'async_delegation_complete' | 'process_complete' | 'internal_notification' | 'system_note'

export interface InjectedRow {
  noticeKind: InjectedNoticeKind
  /** The header's leading clause — the pill's title when nothing else names it. */
  title: string
  /** What the pill shows when opened. */
  body: string
}

/** Two or more shouted characters behind the opening bracket, letter first. */
const SHOUTING_HEADER_RE = /^\[[A-Z][A-Z0-9]+(?![a-z])/u

/** The steer wrapper, which is a real message and not scaffolding. */
const REAL_MESSAGE_WRAPPER_RE = /^\[\/?OUT-OF-BAND USER MESSAGE\b/u

const DELEGATION_HEADER_RE = /^ASYNC DELEGATION\b/u

const PROCESS_HEADER_RE = /^IMPORTANT:/u

/**
 * The kanban poller's line (`tui_gateway/session_notifications.py`, lines
 * 320–341): a status glyph, an optional board and assignee, then the literal
 * word `Kanban` and the task id. A batch joins several of these with newlines,
 * so the first one is the whole row's opener.
 *
 * The glyph set is upstream's `_KANBAN_EVENT_FORMATTERS`, and the word `Kanban`
 * behind it is what keeps this off a message that merely opens with a tick.
 */
const KANBAN_NOTIFICATION_RE = /^[✔⏸✖⏱🔄] (?:\[[^\]\r\n]+\] )?(?:@\S+ )?Kanban \S+/u

/**
 * A `[System: …]` note: the row opens with the marker and the bracket that
 * opened it is the LAST thing on the row.
 *
 * The closing bracket is doing real work. Every writer of this prefix builds one
 * bracketed sentence and appends nothing after it, so requiring the row to end
 * there is what keeps prose out — `why does [System: …] show up in my chat?`
 * does not open with the marker, and `[System: note] and here is the rest` does
 * not end with it. Upstream's own guard is the bare prefix and its tests
 * document that a person typing `[System: my own note] how do I …` is
 * indistinguishable; this one at least narrows that to a person who also closes
 * their bracket at the very end.
 *
 * The inner text is captured greedily, so the bracket that closes it is the LAST
 * one on the row and a sentence carrying a `]` of its own keeps everything after
 * it.
 */
const SYSTEM_NOTE_RE = /^\[System:\s*([\s\S]+)\]\s*$/u

/**
 * `tools/todo_tool.py::TODO_INJECTION_HEADER` and the planning handoff beside
 * it: a bracketed header on a line of its own, then the preserved state.
 *
 * Anchored on the literal opening words, and the bracket has to close on that
 * same line — these two are fixed strings upstream, so nothing wider is needed.
 */
const PRESERVED_STATE_RE = /^\[(?:Your active task list|Planning state preserved)[^\]\r\n]*\]/u

/**
 * `cron/scheduler_delivery.py`'s platform-delivery wrapper (line 1958): the
 * words `Cronjob Response:`, the job name, the job id in parentheses, and a rule
 * of dashes before the report.
 *
 * All three lines are matched, not just the opener. This is the one shape in
 * this module with no bracket anywhere, so a bare prefix test would catch any
 * message whose first line happens to start with those two words — the id line
 * and the rule are what make it unmistakably the wrapper.
 *
 * It is deliberately NOT routed to the cron card: that card's contract is
 * ADR-0013's two `[Cronjob …]` / `[Cron delivery: …]` headers, and this is a
 * third shape with its own name/id split. It lands as a notice, which is at
 * least not the owner's own bubble.
 */
const CRON_RESPONSE_RE = /^Cronjob Response: [^\r\n]+\r?\n\(job_id: [^\r\n]*\)\r?\n-{3,}\s*\r?\n/u

/**
 * The sentence inside a `[System: …]` note, or `null` when the text is not one.
 *
 * The wrapper is addressed to the model and none of it is the message: a chat
 * row previewed `[System: The active model for th…` and spent its whole width
 * on the marker. Used on both sides of the wire — by `parseInjectedRow` for a
 * row nothing labelled, and by the history projection for the rows the gateway
 * DID label `model_switch` / `personality_switch` / `auto_continue` — so the two
 * descriptions of one row still say the same thing and still pair.
 */
export function unwrapSystemNote(text: unknown): string | null {
  if (typeof text !== 'string' || !text) {
    return null
  }

  const inner = SYSTEM_NOTE_RE.exec(text.trim())?.[1]?.trim()

  return inner || null
}

/**
 * A steer as the gateway delivers it (`agent/prompt_builder.py`, lines 535–538):
 * the marker open on its own line, the user's words, the marker close last.
 *
 * The descriptive clause inside the opening marker is NOT matched word for word,
 * which is where this differs from the cron headers in `cron-delivery.ts`. It
 * does not need to be: the marker is a PAIR, and a row that both opens and
 * closes with the same bracketed tag is already unambiguous in a way a lone
 * header never is.
 */
const STEER_WRAPPER_RE =
  /^\s*\[OUT-OF-BAND USER MESSAGE(?: — [^\r\n]*)?\]\r?\n([\s\S]*)\r?\n\[\/OUT-OF-BAND USER MESSAGE\]\s*$/u

/**
 * The user's own words, taken out of the steer wrapper, or `null` when the text
 * is not a wrapped steer.
 *
 * The wrapper is addressed to the model — it tells it whose words these are and
 * that a replay is not a new delivery — and none of that is the message. A chat
 * loaded from history showed all three lines in the bubble.
 */
export function stripSteerWrapper(text: unknown): string | null {
  if (typeof text !== 'string' || !text) {
    return null
  }

  return STEER_WRAPPER_RE.exec(text)?.[1] ?? null
}

/**
 * Read a transcript row's text as a gateway-injected notice, or `null` when it
 * is an ordinary message.
 *
 * Pure and total: any value is a legal argument.
 */
export function parseInjectedRow(text: unknown): InjectedRow | null {
  if (typeof text !== 'string' || !text) {
    return null
  }

  const anchored = text.replace(/^\s+/u, '')

  if (KANBAN_NOTIFICATION_RE.test(anchored)) {
    return { noticeKind: 'internal_notification', title: firstLineOf(anchored), body: text }
  }

  // The non-shouting scaffolding, each on its own named rule. They are tested
  // before the shape test below rather than folded into it: none of them shouts,
  // and widening the shape until they did would take half of ordinary prose with
  // it.
  const systemNote = unwrapSystemNote(text)

  if (systemNote !== null) {
    // The BODY is the sentence without its wrapper, on purpose. Everything else
    // here keeps the row whole because a card may need to show exactly what the
    // gateway wrote; a system note has nothing under the header to show, so the
    // wrapper would be the only thing a reader gained — and it is the thing they
    // were never meant to see.
    return { noticeKind: 'system_note', title: titleOf(systemNote), body: systemNote }
  }

  const preserved = PRESERVED_STATE_RE.exec(anchored)?.[0]

  if (preserved) {
    return { noticeKind: 'internal_notification', title: preserved.slice(1, -1).trim(), body: text }
  }

  if (CRON_RESPONSE_RE.test(anchored)) {
    return { noticeKind: 'internal_notification', title: firstLineOf(anchored), body: text }
  }

  if (!SHOUTING_HEADER_RE.test(anchored) || REAL_MESSAGE_WRAPPER_RE.test(anchored)) {
    return null
  }

  const breakAt = anchored.search(/\r?\n/u)

  if (breakAt === -1) {
    return null
  }

  const firstLine = anchored.slice(0, breakAt)

  // Something has to be under the header. Without this a bracketed shout that
  // is the entire message — a label, a heading — would become a notice.
  if (!anchored.slice(breakAt).trim()) {
    return null
  }

  const header = firstLine.endsWith(']')
    ? firstLine.slice(1, -1)
    : anchored.trimEnd().endsWith(']')
      ? firstLine.slice(1)
      : null

  if (header === null || !header.trim()) {
    return null
  }

  if (DELEGATION_HEADER_RE.test(header)) {
    return { noticeKind: 'async_delegation_complete', title: titleOf(header), body: text }
  }

  if (PROCESS_HEADER_RE.test(header)) {
    const body = processCompletionBody(text)

    return body === null ? null : { noticeKind: 'process_complete', title: titleOf(header), body }
  }

  return { noticeKind: 'internal_notification', title: titleOf(header), body: text }
}

/** Is this row text a gateway-injected notice? The predicate, without the parts. */
export function isInjectedRow(text: unknown): boolean {
  return parseInjectedRow(text) !== null
}

const INJECTED_NOTICE_KINDS = new Set<NoticeKind>([
  'async_delegation_complete',
  'process_complete',
  'internal_notification'
])

/**
 * Does this item stand for a row the gateway injected to start a turn?
 *
 * Asked by everything that walks back for "what opened the newest turn": a
 * resume comparing its `inflight` against the screen, and the tail reconcile
 * deciding what a foreign `message.start` placeholder was waiting for. The other
 * notice kinds — a model switch, an auto-continue — ride along inside a turn and
 * never start one.
 *
 * `system_note` is deliberately not in the set, although a few of its writers DO
 * open a turn (`agent/conversation_loop.py`'s continuation prompts). The text
 * cannot tell those from the model-switch and personality markers the gateway
 * splices in MID-turn, and the two errors are not symmetrical: a continuation
 * prompt that is not recognised as the opener costs a blank placeholder the
 * selectors already draw as nothing, while a mid-turn marker mistaken for the
 * opener would make every resume compare the real prompt against a marker, miss,
 * and paint the prompt a second time — the bug `shownTurn` walks steers past to
 * avoid.
 */
export function isInjectedNotice(item: TranscriptItem): boolean {
  return item.kind === 'notice' && INJECTED_NOTICE_KINDS.has(item.noticeKind)
}

/** A notification with no header of its own is titled by its own first line. */
function firstLineOf(text: string): string {
  const breakAt = text.search(/\r?\n/u)

  return (breakAt === -1 ? text : text.slice(0, breakAt)).trim()
}

/** The header's leading clause: up to its first full stop, or before its first semicolon. */
function titleOf(header: string): string {
  const stop = header.search(/[.;]/u)

  if (stop === -1) {
    return header.trim()
  }

  return header.slice(0, header[stop] === '.' ? stop + 1 : stop).trim()
}

/**
 * The body `rows-to-items` gives a `process_complete` row, computed from the
 * text alone — or `null` when it cannot be, and the row is better left alone.
 *
 * The two have to agree exactly, because they are two descriptions of one row
 * and reconciliation pairs them on what they say. The persisted projection drops
 * the block of any completion it can hand to the `message_agent` dispatch that
 * spawned it, keeping only what is left over. Which blocks those are is a
 * question about the COMMAND, which is in the text — so the split is reproducible
 * here, with one exception: a delivery block whose dispatch is not on screen
 * falls back into the leftovers, and nothing in the text says whether it is. So a
 * text carrying any delivery block is refused rather than guessed at.
 */
function processCompletionBody(text: string): string | null {
  const blocks = parseProcessCompleteText(text)

  if (blocks.some(block => isBotDmDeliveryCommand(block.command))) {
    return null
  }

  const joined = blocks
    .map(block => block.output.trim())
    .filter(Boolean)
    .join('\n\n')

  // Every block attributed and nothing left over: the persisted row projects no
  // notice at all, so neither may this.
  if (blocks.length && !joined) {
    return null
  }

  return joined || text
}
