/**
 * Bot-to-bot wire conventions.
 *
 * Hermes has no dedicated DM event: agent-to-agent traffic is recognised from
 * transcript conventions. Everything in this module is a parser for one of
 * them, and each one cites the upstream file that writes the string.
 */
import type { TranscriptItem } from './types'

/**
 * Inbound delivery signature, copied verbatim from
 * `apps/desktop/src/components/assistant-ui/thread/user-message.tsx`.
 *
 * Groups: 1 = sender display name, 2 = sender handle, 3 = legacy sender name,
 * 4 = the message body. The row arrives on the `user` role because the
 * recipient's turn runs on it — it is NOT the human speaking.
 */
export const AGENT_MESSAGE_RE =
  /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u

/**
 * Sender-side legacy delivery: `hermes -p <profile> chat … -q "Message from …"`
 * run through the terminal tool. Copied from
 * `apps/desktop/src/components/assistant-ui/thread/agent-delivery.tsx`.
 */
const DELIVERY_COMMAND_RE =
  /(?:^|[;&|]\s*|\bhermes\s+)-p\s+("?)([a-z0-9][a-z0-9_-]{0,63})\1\s+chat\b[\s\S]*?-q\s+["']Message from/iu

/** The current delivery runner (`tools/bot_mode_dm.py::_delivery_command`). */
const RUN_DELIVERY_RE = /bot_mode_dm\.py["']?\s+--run-delivery\b/u

/** The recipient-naming fragment both forms share. */
const DELIVERY_PROFILE_RE = /\bhermes(?:\.exe)?["']?\s+-p\s+("?)([a-z0-9][a-z0-9_-]{0,63})\1\s+chat\b/iu

export interface IncomingBotMessage {
  senderName: string
  senderHandle?: string
  body: string
}

/** Parse an inbound `Message from 🤖 <name> (@<handle>): <body>` row. */
export function parseIncomingBotMessage(text: string): IncomingBotMessage | null {
  const match = AGENT_MESSAGE_RE.exec(text)

  if (!match) {
    return null
  }

  const senderName = (match[1] ?? match[3] ?? '').trim()

  if (!senderName) {
    return null
  }

  const handle = match[2]?.trim()

  return {
    senderName,
    ...(handle ? { senderHandle: handle.toLowerCase() } : {}),
    body: match[4] ?? ''
  }
}

/**
 * `@Dr. Foo`, `scribe@laptop`, `peer/scribe` → `dr. foo` / `scribe`: the routing
 * alias a `message_agent` target and a "Message from" signature share. Ported
 * from `agentKey` in `agent-delivery.tsx`.
 */
export function normalizeAgentTarget(target: unknown): string {
  if (typeof target !== 'string') {
    return ''
  }

  const stripped = target
    .trim()
    .replace(/^@/, '')
    .replace(/@[^@]*$/, '')

  return (stripped.split('/').pop() ?? '').toLowerCase()
}

export type DmDispatchStatus = 'sending' | 'queued' | 'failed' | 'ambiguous' | 'unknown'

export interface ParsedDispatch {
  status: DmDispatchStatus
  deliveryId?: string
  processId?: string
  to?: string
  error?: string
  reason?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()

    if (!trimmed.startsWith('{')) {
      return null
    }

    try {
      return asRecord(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The `message_agent` tool result (`tools/bot_mode_dm.py`): a JSON ack
 * `{status:'queued', delivery_id, to, process_id}`, the live-owner variant
 * (`status` from the delivery record), `{status:'ambiguous', …}`, or the
 * `_err` shape `{error, reason}`. Fire-and-forget: a `queued` ack is a hand-off
 * to a background delivery process, never a delivery receipt.
 */
export function parseMessageAgentResult(result: unknown): ParsedDispatch {
  const outer = asRecord(result)
  const record = outer && typeof outer.output === 'string' ? (asRecord(outer.output) ?? outer) : outer

  if (!record) {
    const text = asText(result).trim()

    return text ? { status: 'unknown', error: text } : { status: 'unknown' }
  }

  const raw = asText(record.status)
  const error = asText(record.error).trim()
  const reason = asText(record.reason).trim()
  const deliveryId = asText(record.delivery_id).trim()
  const processId = asText(record.process_id).trim()
  const to = asText(record.to).trim()

  const status: DmDispatchStatus =
    raw === 'queued' || raw === 'claimed' || raw === 'settled'
      ? 'queued'
      : raw === 'ambiguous'
        ? 'ambiguous'
        : error
          ? 'failed'
          : 'unknown'

  return {
    status,
    ...(deliveryId ? { deliveryId } : {}),
    ...(processId ? { processId } : {}),
    ...(to ? { to } : {}),
    ...(error ? { error } : {}),
    ...(reason ? { reason } : {})
  }
}

export interface ProcessCompletion {
  sid: string
  command: string
  output: string
}

const PROCESS_BLOCK_RE =
  /^\[IMPORTANT:\s*Background process (\S+)\b[\s\S]*?\nCommand:\s*([^\n]*)\n(?:Matched output|Output):\n([\s\S]*?)\]\s*$/u

/**
 * Split a `process_complete` row into its `[IMPORTANT: Background process <sid>
 * …]` blocks. The writer is `tools/process_registry_notifications.py`; a batch
 * puts one block per process behind an "N background processes completed."
 * header, blocks separated by a blank line.
 */
export function parseProcessCompleteText(text: string): ProcessCompletion[] {
  const blocks = text.split(/\n\n(?=\[IMPORTANT: )/u)
  const out: ProcessCompletion[] = []

  for (const block of blocks) {
    const trimmed = block.trim()
    const match = PROCESS_BLOCK_RE.exec(trimmed)

    if (!match) {
      continue
    }

    out.push({ sid: match[1] ?? '', command: (match[2] ?? '').trim(), output: match[3] ?? '' })
  }

  return out
}

/**
 * Is this background command one of our own DM deliveries? Either the current
 * runner (`bot_mode_dm.py --run-delivery …`) or the legacy terminal form
 * (`hermes -p <profile> chat … -q "Message from …"`).
 */
export function isBotDmDeliveryCommand(command: string): boolean {
  return RUN_DELIVERY_RE.test(command) || DELIVERY_COMMAND_RE.test(command)
}

/**
 * Both delivery forms run `hermes -p <profile> chat …` for the recipient, so the
 * routing alias is recoverable from the command even when the legacy
 * `-q "Message from` marker is absent (the runner passes a query file instead).
 */
export function deliveryTargetFromCommand(command: string): string | null {
  const match = DELIVERY_COMMAND_RE.exec(command) ?? DELIVERY_PROFILE_RE.exec(command)

  return match?.[2] ? match[2].toLowerCase() : null
}

export interface DeliveryOutcome {
  text?: string
  error?: string
  reason?: string
}

/**
 * The delivery runner's stdout: the recipient's reply as plain text (possibly
 * echoing the `Message from …:` prefix back), or the JSON record the live-owner
 * branch prints (`{status:'settled', reply}` / `{error, reason}`) — see
 * `_wait_live_dm` and `_run_delivery` in `tools/bot_mode_dm.py`.
 */
export function replyFromDeliveryOutput(output: string): DeliveryOutcome {
  const raw = output.trim()

  if (!raw) {
    return {}
  }

  const record = asRecord(raw)

  if (record) {
    const error = asText(record.error).trim()
    const reason = asText(record.reason).trim()
    const reply = asText(record.reply).trim()

    return {
      ...(reply ? { text: stripDeliveryPrefix(reply) } : {}),
      ...(error ? { error } : {}),
      ...(reason ? { reason } : {})
    }
  }

  const text = stripDeliveryPrefix(
    raw
      .split('\n')
      .filter(line => !/^session_id:\s/u.test(line.trim()))
      .join('\n')
      .trim()
  )

  return text ? { text } : {}
}

function stripDeliveryPrefix(text: string): string {
  return (AGENT_MESSAGE_RE.exec(text)?.[4] ?? text).trim()
}

/**
 * Did THIS chat dispatch a `message_agent` to `sender` in the CURRENT exchange?
 * True means the inbound row that follows is the teammate's answer to our
 * dispatch, so the next assistant reply addresses the human again.
 *
 * Ported from `dispatchedTo` in `agent-delivery.tsx`: the scan stops at the
 * nearest earlier human turn or at an inbound row from the same sender, so one
 * dispatch exempts only the answer that follows it.
 */
export function dispatchedTo(earlier: readonly TranscriptItem[], sender: readonly (string | undefined)[]): boolean {
  const keys = new Set(sender.map(normalizeAgentTarget).filter(Boolean))

  if (!keys.size) {
    return false
  }

  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const item = earlier[index]

    if (!item) {
      continue
    }

    if (item.kind === 'user') {
      return false
    }

    if (item.kind === 'bot_dm_in') {
      if ([item.senderName, item.senderHandle].some(part => keys.has(normalizeAgentTarget(part)))) {
        return false
      }

      continue
    }

    if (item.kind === 'bot_dm_out' && keys.has(item.targetHandle)) {
      return true
    }
  }

  return false
}
