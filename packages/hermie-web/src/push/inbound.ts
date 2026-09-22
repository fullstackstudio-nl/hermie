/**
 * Reading the row that started a turn, so a notification can say which of the
 * four things happened.
 *
 * Hermes has no event for "a cron reported in" and none for "another bot sent a
 * DM". Both arrive as an ordinary `role: "user"` row with a header spliced in
 * front of it, and the header is the whole signal — see
 * `docs/adr/0013-cron-deliveries-in-the-transcript.md`. `packages/transcript`
 * holds the canonical parsers (`cron-delivery.ts`, `bot-dm.ts`) and is the
 * source of truth for these strings; the narrow forms here exist because Hermie
 * Web ships a self-contained `dist/server` with no `node_modules` beside it and
 * therefore cannot import that package at runtime. If the two ever disagree,
 * that package is right.
 *
 * Only what a NOTIFICATION needs is parsed: which kind, and the one name that
 * goes in the title. Nothing here reconstructs a transcript.
 */

/** What started a turn. `message` is the owner typing — the ordinary case. */
export type InboundKind = 'message' | 'dm' | 'cron'

export interface InboundTurn {
  kind: InboundKind
  /** The cron job's name, or the sending bot's name. Empty for `message`. */
  name: string
  /** The report or the DM, header removed. Only ever used when `preview` is on. */
  body: string
}

/**
 * `cron/scheduler_delivery.py::_deliver_to_bot_chat`. The instruction sentence
 * is matched word for word rather than loosely on `[Cronjob`, because the
 * sentence is fixed text and the job name is the only variable in it.
 */
const CRON_BOT_CHAT_RE =
  /^\s*\[Cronjob "([^\r\n]*)" output — scheduled job, not the user\. Review it, act on anything that needs action, and summarize for the chat\.\](?:\r?\n\r?\n|\r?\n|$)/u

/** `cron/scheduler_delivery.py::_cron_mirror_message`: one line, one newline, then the text. */
const CRON_MIRROR_RE = /^\s*\[Cron delivery: ([^\r\n]*)\](?:\r?\n|$)/u

/**
 * The inbound bot-to-bot signature, copied from
 * `packages/transcript/src/bot-dm.ts` (itself copied from upstream's desktop
 * `user-message.tsx`). The row arrives on the `user` role because the
 * recipient's turn runs on it — it is not the human speaking.
 */
const AGENT_MESSAGE_RE =
  /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u

/** `_redact_cron_payload`'s fail-closed replacement, used for the name too. */
const REDACTION_FAILED = '[REDACTED - redaction failed]'

/**
 * Classify one inbound row.
 *
 * Anything that is not recognisably a cron header or a DM signature is the owner
 * typing, which is the right way round: a header this build has not heard of
 * produces an ordinary message notification rather than none at all.
 */
export function classifyInbound(text: unknown): InboundTurn {
  if (typeof text !== 'string' || !text) {
    return { kind: 'message', name: '', body: '' }
  }

  const botChat = CRON_BOT_CHAT_RE.exec(text)

  if (botChat) {
    return { kind: 'cron', name: cronName(botChat[1] ?? ''), body: text.slice(botChat[0].length).trim() }
  }

  const mirror = CRON_MIRROR_RE.exec(text)

  if (mirror) {
    return { kind: 'cron', name: cronName(mirror[1] ?? ''), body: text.slice(mirror[0].length).trim() }
  }

  const dm = AGENT_MESSAGE_RE.exec(text)
  const senderName = (dm?.[1] ?? dm?.[3] ?? '').trim()

  if (dm && senderName) {
    return { kind: 'dm', name: senderName, body: (dm[4] ?? '').trim() }
  }

  return { kind: 'message', name: '', body: text.trim() }
}

/** A name the gateway's redactor replaced wholesale names no job; say so rather than printing it. */
function cronName(raw: string): string {
  return raw === REDACTION_FAILED ? '' : raw
}

export interface TranscriptRowLike {
  role?: unknown
  text?: unknown
  content?: unknown
}

/**
 * The row that started the last turn: the newest `user` row in a transcript.
 *
 * Read from the END, because a chat is append-only and the row that matters is
 * always the last one — and because a transcript can be thousands of rows and
 * this runs once per completed turn.
 */
export function lastInboundRow(messages: readonly TranscriptRowLike[]): InboundTurn {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const row = messages[at]

    if (row?.role !== 'user') {
      continue
    }

    const text = typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : ''

    return classifyInbound(text)
  }

  return { kind: 'message', name: '', body: '' }
}
