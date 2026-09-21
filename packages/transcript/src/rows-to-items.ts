/**
 * History projection: transcript rows → transcript items.
 *
 * The same function serves the RPC `session.history` shape and the REST
 * `GET /api/sessions/{id}/messages` shape, so a chat painted from cache, from
 * history and from live events is one item model with one renderer.
 *
 * Ported from `apps/desktop/src/lib/chat-messages/hydration.ts` and the
 * gateway's own projection in `tui_gateway/session_history.py`.
 */
import {
  deliveryTargetFromCommand,
  dispatchedTo,
  isBotDmDeliveryCommand,
  normalizeAgentTarget,
  parseIncomingBotMessage,
  parseProcessCompleteText,
  replyFromDeliveryOutput
} from './bot-dm'
import { parseCronDelivery } from './cron-delivery'
import { type InjectedRow, parseInjectedRow, stripSteerWrapper } from './injected'
import {
  type AssistantItem,
  type BotDmInItem,
  type BotDmOutItem,
  type CronDeliveryItem,
  type ItemOrigin,
  type NoticeItem,
  type NoticeKind,
  type ProcessCompletionBlock,
  SEQ_STEP,
  type SubagentGroupItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from './types'

/** A history row as either transport ships it. Unknown keys stay open. */
export interface TranscriptRow {
  role?: string | null
  text?: string | null
  content?: unknown
  display_content?: unknown
  display_kind?: string | null
  display_metadata?: unknown
  timestamp?: number | null
  row_id?: number | null
  id?: unknown
  name?: string | null
  context?: string | null
  args?: Record<string, unknown> | null
  tool_id?: string | null
  tool_call_id?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  reasoning_details?: unknown
  codex_message_items?: unknown
  [key: string]: unknown
}

export type RowShape = 'rpc' | 'rest'

export interface RowsToItemsOptions {
  origin?: ItemOrigin
}

const ATTACHED_CONTEXT_MARKER_RE = /(?:^|\n)--- Attached Context ---\s*\n/u
const CONTEXT_WARNINGS_MARKER_RE = /(?:^|\n)--- Context Warnings ---[\s\S]*$/u
const CONTEXT_REF_RE = /@(?:file|folder|url|image|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/gu
const ATTACHMENT_REF_RE = /@(?:file|image):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/gu
const ATTACHMENT_SCHEME_RE = /^@(file|image):/u

// Gateway routing note for Discord turns (`gateway/run_inbound.py`); current
// gateways persist the authored text, this heals rows written before that fix.
const DISCORD_TRIGGERING_NOTE_RE =
  /(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply\/react\/pin via the discord tools\.\]\n*/u

const asText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map(part => (part && typeof part === 'object' ? asText((part as { text?: unknown }).text) : asText(part)))
      .filter(Boolean)
      .join('\n')
  }

  return ''
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value))
    } catch {
      return null
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Reply text from a Responses-API `codex_message_items` sidecar, for rows whose
 * content persisted empty. `commentary` / `analysis` phases are mid-turn
 * narration routed to the reasoning channel, not the reply.
 */
function codexMessageItemText(value: unknown): string {
  let items: unknown = value

  if (typeof items === 'string') {
    try {
      items = JSON.parse(items)
    } catch {
      return ''
    }
  }

  if (!Array.isArray(items)) {
    return ''
  }

  const texts: string[] = []

  for (const item of items) {
    const record = asObject(item)

    if (!record || record.type !== 'message' || record.role !== 'assistant') {
      continue
    }

    if (record.phase === 'commentary' || record.phase === 'analysis') {
      continue
    }

    if (!Array.isArray(record.content)) {
      continue
    }

    for (const part of record.content) {
      const partRecord = asObject(part)
      const partType = partRecord?.type

      if (partType !== 'output_text' && partType !== 'text') {
        continue
      }

      const text = partRecord?.text

      if (typeof text === 'string' && text) {
        texts.push(text)
      }
    }
  }

  return texts.join('')
}

export interface StrippedUserText {
  text: string
  attachments?: string[]
}

/**
 * Drop the model-facing scaffolding from a persisted user turn: the attached
 * context block, the context-warnings tail, and the `@image:` / `@file:`
 * directive lines the gateway rewrites in at persist time.
 */
export function stripUserText(raw: string): StrippedUserText {
  const textContent = raw.replace(DISCORD_TRIGGERING_NOTE_RE, '$1')
  const marker = textContent.match(ATTACHED_CONTEXT_MARKER_RE)
  let visible: string

  if (!marker || marker.index === undefined) {
    visible = textContent.replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()
  } else {
    visible = textContent.slice(0, marker.index).replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()

    const attachedContext = textContent.slice(marker.index + (marker[0]?.length ?? 0))
    const refs = [...new Set(Array.from(attachedContext.matchAll(CONTEXT_REF_RE)).map(match => match[0]))]
    // The prose keeps the `@file:` token the user typed, so it already chips in
    // place. Only hoist a ref the prose is missing.
    const missing = refs.filter(ref => !visible.includes(ref))

    visible = [missing.join('\n'), visible].filter(Boolean).join('\n\n') || visible
  }

  const attachments = [...new Set(Array.from(visible.matchAll(ATTACHMENT_REF_RE)).map(match => match[0]))]

  if (!attachments.length) {
    return { text: visible }
  }

  const cleaned = visible
    .replace(ATTACHMENT_REF_RE, '')
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/gu, ' ').trim())
    // A directive line that held nothing but refs leaves a hole; collapse runs
    // of blank lines rather than opening a gap in the bubble.
    .filter((line, index, lines) => line || lines[index - 1]?.trim())
    .join('\n')
    .trim()

  return { text: cleaned, attachments }
}

const NOTICE_TITLES: Record<string, string> = {
  model_switch: 'Model changed',
  personality_switch: 'Personality changed',
  auto_continue: 'Resumed interrupted turn',
  process_complete: 'Background process finished',
  async_delegation_complete: 'Background agent work finished',
  internal_notification: 'Internal notification'
}

function displayText(metadata: unknown): string | undefined {
  const text = asObject(metadata)?.display_text

  return typeof text === 'string' && text.trim() ? text : undefined
}

function goalsFromArgs(args: Record<string, unknown> | null | undefined): string[] {
  if (!args) {
    return []
  }

  if (typeof args.goal === 'string' && args.goal.trim()) {
    return [args.goal.trim()]
  }

  if (!Array.isArray(args.tasks)) {
    return []
  }

  return args.tasks
    .map(task => asObject(task)?.goal)
    .filter((goal): goal is string => typeof goal === 'string' && Boolean(goal.trim()))
    .map(goal => goal.trim())
}

/**
 * Project rows onto items. `shape` only decides which alias of the same field
 * is preferred — both transports resolve to identical items and identical ids,
 * which is what keeps `reconcile` stable across a REST/RPC switch.
 */
export function rowsToItems(rows: readonly TranscriptRow[], shape: RowShape, opts: RowsToItemsOptions = {}) {
  const origin: ItemOrigin = opts.origin ?? 'history'
  const items: TranscriptItem[] = []
  let emitted = 0

  const push = <T extends TranscriptItem>(item: Omit<T, 'seq' | 'version' | 'origin'> & Partial<T>): T => {
    const built = { ...item, seq: emitted * SEQ_STEP, version: 0, origin } as T

    emitted += 1
    items.push(built)

    return built
  }

  const lastOpenGroup = (): SubagentGroupItem | undefined => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]

      if (item?.kind === 'subagent_group' && item.status !== 'done' && item.status !== 'failed') {
        return item
      }
    }

    return undefined
  }

  const lastDmOutTo = (handle: string): BotDmOutItem | undefined => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]

      if (item?.kind === 'bot_dm_out' && (!handle || item.targetHandle === handle) && !item.reply) {
        return item
      }
    }

    return undefined
  }

  rows.forEach((row, index) => {
    const role = typeof row.role === 'string' ? row.role : ''
    const displayKind = typeof row.display_kind === 'string' ? row.display_kind : ''

    if (displayKind === 'hidden') {
      return
    }

    const rawContent =
      shape === 'rest'
        ? (row.display_content ?? row.content ?? row.text)
        : (row.text ?? row.display_content ?? row.content)
    const content = asText(rawContent)
    const rowIdValue = shape === 'rest' ? (row.id ?? row.row_id) : (row.row_id ?? row.id)
    const rowId = asNumber(rowIdValue)
    const ts = asNumber(row.timestamp)
    const base = { ...(rowId !== undefined ? { rowId } : {}), ...(ts !== undefined ? { ts } : {}) }
    const fallbackId = rowId !== undefined ? `r:${rowId}` : `${role || 'x'}:${index}`

    if (role === 'tool') {
      const name = typeof row.name === 'string' ? row.name : 'tool'
      const toolId = (typeof row.tool_id === 'string' && row.tool_id) || `row-${index}`
      const args = row.args ?? undefined
      const context = typeof row.context === 'string' && row.context ? row.context : undefined

      if (name === 'message_agent') {
        const target = typeof args?.target === 'string' ? args.target : ''
        push<BotDmOutItem>({
          id: `t:${toolId}`,
          kind: 'bot_dm_out',
          toolId,
          target,
          targetHandle: normalizeAgentTarget(target),
          message: typeof args?.message === 'string' ? args.message : '',
          // History never carries the tool result, so the dispatch outcome is
          // unknown until a `process_complete` row joins the reply back in.
          dispatch: { status: 'unknown' },
          ...base
        })

        return
      }

      if (name === 'delegate_task') {
        push<SubagentGroupItem>({
          id: `t:${toolId}`,
          kind: 'subagent_group',
          toolId,
          goals: goalsFromArgs(args),
          rootIds: [],
          status: 'dispatched',
          ...base
        })

        return
      }

      push<ToolItem>({
        id: `t:${toolId}`,
        kind: 'tool',
        toolId,
        name,
        ...(context ? { context, summary: context } : {}),
        ...(args ? { args } : {}),
        status: 'complete',
        resultKnown: false,
        ...base
      })

      return
    }

    if (role === 'assistant') {
      const reasoning =
        (typeof row.reasoning === 'string' && row.reasoning) ||
        (typeof row.reasoning_content === 'string' && row.reasoning_content) ||
        (typeof row.reasoning_details === 'string' && row.reasoning_details) ||
        ''
      const text = content || codexMessageItemText(row.codex_message_items)

      if (!text && !reasoning) {
        return
      }

      push<AssistantItem>({
        id: fallbackId,
        kind: 'assistant',
        text,
        ...(reasoning ? { reasoning } : {}),
        streaming: false,
        interim: false,
        status: 'complete',
        ...base
      })

      return
    }

    if (role !== 'user' && role !== 'system') {
      return
    }

    const notice = (noticeKind: NoticeKind, title: string, body?: string) =>
      push<NoticeItem>({
        id: fallbackId,
        kind: 'notice',
        noticeKind,
        title,
        ...(body ? { body } : {}),
        ...base
      })

    if (displayKind === 'model_switch' || displayKind === 'personality_switch' || displayKind === 'auto_continue') {
      notice(displayKind, displayText(row.display_metadata) ?? NOTICE_TITLES[displayKind] ?? displayKind, content)

      return
    }

    if (displayKind === 'process_complete') {
      const blocks = parseProcessCompleteText(content)
      const leftovers: string[] = []
      const unattributed: ProcessCompletionBlock[] = []

      for (const block of blocks) {
        if (!isBotDmDeliveryCommand(block.command)) {
          leftovers.push(block.output.trim())
          unattributed.push(block)

          continue
        }

        const outcome = replyFromDeliveryOutput(block.output)
        // History carries no tool result, so there is no process id to join on:
        // fall back to the nearest still-unanswered dispatch to that handle.
        const target = lastDmOutTo(deliveryTargetFromCommand(block.command) ?? '')

        if (!target) {
          leftovers.push(outcome.text ?? outcome.error ?? block.output.trim())
          unattributed.push(block)

          continue
        }

        target.reply = {
          text: outcome.text ?? '',
          ...(ts !== undefined ? { ts } : {}),
          ...(rowId !== undefined ? { rowId } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {})
        }
        target.dispatch = {
          ...target.dispatch,
          status: outcome.error ? 'failed' : target.dispatch.status === 'unknown' ? 'queued' : target.dispatch.status
        }
        target.version += 1
      }

      const body = leftovers.filter(Boolean).join('\n\n')

      if (body || !blocks.length) {
        const emitted = notice(
          'process_complete',
          displayText(row.display_metadata) ?? NOTICE_TITLES.process_complete ?? 'Background process finished',
          body || content
        )

        if (unattributed.length) {
          emitted.completions = unattributed
        }
      }

      return
    }

    // A fan-out's report closes the group that dispatched it, wherever the row
    // was recognised: by its `display_kind` here, or by its header below.
    const closeOpenGroup = () => {
      const group = lastOpenGroup()

      if (group) {
        group.status = 'done'
        group.completion = content
        group.version += 1
      }
    }

    if (displayKind === 'async_delegation_complete') {
      const title =
        displayText(row.display_metadata) ?? NOTICE_TITLES.async_delegation_complete ?? 'Background agent work finished'

      closeOpenGroup()
      notice('async_delegation_complete', title, content)

      return
    }

    if (displayKind === 'internal_notification') {
      notice('internal_notification', displayText(row.display_metadata) ?? 'Internal notification', content)

      return
    }

    if (displayKind && displayKind !== 'skill_invocation' && displayKind !== 'steer') {
      notice('unknown_display_kind', displayKind, content)

      return
    }

    // Before the speech paths, and only on a row this file has NOT already
    // recognised by `display_kind`: a cron delivery is an ordinary `role: user`
    // row with no marker on it, so anything the gateway did label is a stronger
    // signal than our header heuristic and has already returned above.
    const cron = role === 'user' && !displayKind ? parseCronDelivery(content) : null

    if (cron) {
      push<CronDeliveryItem>({
        id: fallbackId,
        kind: 'cron_delivery',
        jobName: cron.jobName,
        ...(cron.nameRedacted ? { nameRedacted: true } : {}),
        body: cron.body,
        shape: cron.shape,
        ...base
      })

      return
    }

    const incoming = role === 'user' ? parseIncomingBotMessage(content) : null

    if (incoming) {
      push<BotDmInItem>({
        id: fallbackId,
        kind: 'bot_dm_in',
        senderName: incoming.senderName,
        ...(incoming.senderHandle ? { senderHandle: incoming.senderHandle } : {}),
        text: incoming.body,
        ...base
      })

      return
    }

    // The last thing standing between a machine's report and the owner's own
    // bubble. A row the gateway labelled has already returned above, so this only
    // sees the ones it left unmarked — an older gateway, a transport that drops
    // `display_kind`, or a shape upstream added since. Anything that is not a
    // real message must not be drawn as one.
    const injected: InjectedRow | null = role === 'user' && !displayKind ? parseInjectedRow(content) : null

    if (injected) {
      if (injected.noticeKind === 'async_delegation_complete') {
        closeOpenGroup()
      }

      notice(injected.noticeKind, injected.title, injected.body)

      return
    }

    // A steer IS the user speaking, so it keeps its bubble — but the wrapper the
    // gateway delivers it in is addressed to the model, not to the reader.
    const unwrapped = role === 'user' ? stripSteerWrapper(content) : null
    const stripped = stripUserText(unwrapped ?? content)

    if (!stripped.text && !stripped.attachments?.length) {
      return
    }

    const speechKind =
      displayKind === 'skill_invocation' || displayKind === 'steer' ? displayKind : unwrapped !== null ? 'steer' : ''

    push<UserItem>({
      id: fallbackId,
      kind: 'user',
      text: stripped.text,
      ...(stripped.attachments ? { attachments: stripped.attachments } : {}),
      ...(speechKind ? { displayKind: speechKind } : {}),
      ...base
    })
  })

  attributeBotReplies(items)

  return items
}

/**
 * Mark the assistant turns that answer a teammate rather than the human, and
 * the inbound rows that are themselves an answer to our own dispatch.
 */
export function attributeBotReplies(items: TranscriptItem[]): void {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]

    if (item?.kind !== 'bot_dm_in') {
      continue
    }

    const answers = dispatchedTo(items.slice(0, index), [item.senderName, item.senderHandle])

    if (answers) {
      item.answersOurDispatch = true
    }

    for (let probe = index + 1; probe < items.length; probe += 1) {
      const next = items[probe]

      if (!next || next.kind === 'tool' || next.kind === 'status' || next.kind === 'notice') {
        continue
      }

      if (next.kind === 'assistant') {
        if (!answers) {
          next.replyToBotHandle = item.senderHandle ?? normalizeAgentTarget(item.senderName)
        }
      }

      break
    }
  }
}

/**
 * The comparison form of a piece of message text.
 *
 * Reconciliation pairs a live item with the row that persisted it, and text is
 * the only thing the two have in common — `prompt.submit` answers with a status,
 * never a row id. So every difference that is not a difference in what the
 * message SAYS has to be normalised away here: the blank lines of a
 * multi-paragraph prompt, `\r\n` against `\n`, whatever the composer or the
 * gateway trimmed off the ends, and the Unicode form, because a keyboard that
 * writes `e` + U+0301 and one that writes U+00E9 wrote the same word.
 */
export function normalizeMatchText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().normalize('NFC')
}

/**
 * The name at the end of an attachment reference.
 *
 * `@file:"/srv/work/uploads/hermie/2026-09-20/8setj4h3-ui.xml"` → `8setj4h3-ui.xml`.
 *
 * The path is the half of a reference two descriptions of one send can disagree
 * about, and it is not always anybody's fault: an image goes over
 * `image.attach_bytes`, so the GATEWAY decides where it lands and writes
 * `@image:<its path>` into the row, while the client only ever knew the name it
 * handed over. The name is what both always have, so the name is what pairing
 * compares — and, in the chat kit, what the chip shows.
 */
export function attachmentRefName(reference: string): string {
  const raw = reference.replace(ATTACHMENT_SCHEME_RE, '').replace(/^[`"']|[`"']$/gu, '')

  return raw.split(/[/\\]/u).pop() || raw
}

/** `file` or `image`: a picture of a diagram is not the diagram's source. */
function attachmentRefKind(reference: string): string {
  return ATTACHMENT_SCHEME_RE.exec(reference)?.[1] ?? 'file'
}

/**
 * The comparison form of what a turn carries.
 *
 * Sorted, because the set is what identifies the send and the order the two
 * sides happen to list it in is not: a file's reference is in the prompt where
 * the composer put it, and an image's is appended by the gateway afterwards.
 * Empty for a turn that carries nothing, which is the signal that text alone
 * decides.
 */
export function attachmentsMatchKey(references: readonly string[] | undefined): string {
  if (!references?.length) {
    return ''
  }

  const keys = [...new Set(references.map(ref => `${attachmentRefKind(ref)}:${attachmentRefName(ref)}`))]

  // A unit separator rather than a comma: a file name may contain one.
  return keys.sort().join('\u001f')
}

/** A row matcher used by reconciliation: the text two transports agree on. */
export function normalizedItemText(item: TranscriptItem): string {
  const text =
    item.kind === 'user' || item.kind === 'assistant' || item.kind === 'bot_dm_in'
      ? item.text
      : item.kind === 'notice'
        ? // The BODY, and the title only when there is no body.
          //
          // A notice's title is whatever the surface decided to call it, and the
          // two descriptions of one row do not have to agree on that: the gateway
          // ships its own (`display_metadata.display_text`) on the persisted row,
          // and a live projection reading the same text off `inflight` cannot know
          // it. What they always agree on is what the notice SAYS, so that is the
          // key. A notice with no body keeps the title as its only identity.
          item.body?.trim()
          ? item.body
          : item.title
        : item.kind === 'status'
          ? item.text
          : // Both transports parse the same header into the same name and body,
            // so this is the key that pairs a live cron card with its persisted
            // row instead of letting the row land as a second card.
            item.kind === 'cron_delivery'
            ? `${item.jobName}\n${item.body}`
            : ''

  return normalizeMatchText(text)
}

/**
 * Everything about an item that two descriptions of it have to agree on: what it
 * says, and what it carries.
 *
 * Text alone was enough until a turn arrived with no text. A send whose whole
 * body is a `@file:` reference projects to the empty string — the directive is
 * plumbing, so the projection lifts it out — and then the attachments are the
 * only thing left that identifies it. They also have to be ABLE to disagree:
 * two file-only sends carrying different files are two turns, and a key made of
 * text alone would have called them one.
 */
export function itemMatchKey(item: TranscriptItem): string {
  const attachments = item.kind === 'user' ? attachmentsMatchKey(item.attachments) : ''

  return `${normalizedItemText(item)}\n${attachments}`
}

/** Whether an item says or carries enough to be paired on at all. */
export function isMatchable(item: TranscriptItem): boolean {
  return Boolean(normalizedItemText(item)) || (item.kind === 'user' && Boolean(attachmentsMatchKey(item.attachments)))
}
