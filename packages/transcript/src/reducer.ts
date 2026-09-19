/**
 * The live reducer: gateway events → `ChatState`.
 *
 * Every update is immutable; the touched maps are copied structurally so a UI
 * can compare by reference. Nothing here filters — see `selectors.ts`.
 */
import {
  normalizeAgentTarget,
  parseMessageAgentResult,
  parseProcessCompleteText,
  replyFromDeliveryOutput
} from './bot-dm'
import { parseCronDelivery } from './cron-delivery'
import { normalizedItemText, normalizeMatchText, stripUserText } from './rows-to-items'
import { subagentIdOf, TERMINAL_SUBAGENT_STATUS, toSubagent } from './subagent-progress'
import type { ErrorSurface, SessionLiveInfo, Usage } from '@hermes/shared/gateway-events'
import {
  type ApprovalItem,
  type AssistantItem,
  type BotDmOutItem,
  type ChatState,
  type ClarifyItem,
  type ClarifyQuestionItem,
  type CronDeliveryItem,
  type ItemOrigin,
  type ItemReaction,
  type NoticeItem,
  type NoticeKind,
  SEQ_STEP,
  type StatusItem,
  type SubagentGroupItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from './types'

/** One `event` notification's params, as thin as the reducer needs it. */
export interface TranscriptEvent {
  type: string
  session_id?: string
  seq?: number
  payload?: unknown
}

/** `prompt.submit`'s reply, narrowed to what the optimistic turn needs. */
export interface SubmitResult {
  status?: string | null
  [key: string]: unknown
}

export interface ServerRequest {
  id: string
  method: string
  params?: Record<string, unknown>
  /** Re-delivered from a resume snapshot; must not re-notify. */
  replayed?: boolean
}

const DEFAULT_APPROVAL_CHOICES = ['once', 'session', 'always', 'deny']

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The gateway's own shapes; they stay open, so a narrowing cast is the honest read. */
const asUsage = (value: unknown): Usage => rec(value) as Usage
const asErrorSurface = (value: unknown): ErrorSurface => rec(value) as ErrorSurface
const asSessionInfo = (value: unknown): SessionLiveInfo => rec(value) as SessionLiveInfo

const asReactions = (value: unknown): ItemReaction[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is ItemReaction => typeof rec(entry).emoji === 'string')
        .map(entry => rec(entry) as ItemReaction)
    : []

/** Copy every container the reducer may touch; item bodies stay shared until patched. */
function editable(state: ChatState): ChatState {
  return {
    ...state,
    items: { ...state.items },
    order: [...state.order],
    byToolId: { ...state.byToolId },
    byRowId: { ...state.byRowId },
    byRequestId: { ...state.byRequestId },
    byApprovalId: { ...state.byApprovalId },
    byProcessId: { ...state.byProcessId },
    byDelegationId: { ...state.byDelegationId },
    subagents: { ...state.subagents },
    turn: { ...state.turn }
  }
}

function indexItem(next: ChatState, item: TranscriptItem): void {
  if (item.rowId !== undefined) {
    next.byRowId[String(item.rowId)] = item.id
  }

  if (item.kind === 'tool' || item.kind === 'bot_dm_out') {
    next.byToolId[item.toolId] = item.id
  }

  if (item.kind === 'bot_dm_out' && item.dispatch.processId) {
    next.byProcessId[item.dispatch.processId] = item.id
  }

  if (item.kind === 'subagent_group') {
    if (item.toolId) {
      next.byToolId[item.toolId] = item.id
    }

    if (item.delegationId) {
      next.byDelegationId[item.delegationId] = item.id
    }
  }

  if (item.kind === 'approval' || item.kind === 'clarify') {
    next.byRequestId[item.requestId] = item.id
  }

  if (item.kind === 'approval' && item.approvalId) {
    // Last one in wins: a card that replaces an earlier duplicate is the one a
    // cancel has to reach.
    next.byApprovalId[item.approvalId] = item.id
  }
}

type NewItem<T extends TranscriptItem> = Omit<T, 'seq' | 'version' | 'origin'> & { origin?: ItemOrigin }

function addItem<T extends TranscriptItem>(next: ChatState, draft: NewItem<T>, origin: ItemOrigin = 'live'): T {
  const seq = next.turn.nextSeq
  const item = { ...draft, seq, version: 0, origin: draft.origin ?? origin } as T

  next.turn.nextSeq = seq + SEQ_STEP
  next.items[item.id] = item
  next.order.push(item.id)
  indexItem(next, item)

  return item
}

function patchItem<T extends TranscriptItem>(next: ChatState, id: string, apply: (item: T) => T | void): T | undefined {
  const current = next.items[id] as T | undefined

  if (!current) {
    return undefined
  }

  const clone = { ...current }
  const applied = (apply(clone) ?? clone) as T
  const updated = { ...applied, version: current.version + 1 } as T

  next.items[id] = updated
  indexItem(next, updated)

  return updated
}

function dropItem(next: ChatState, id: string): void {
  delete next.items[id]
  const at = next.order.indexOf(id)

  if (at >= 0) {
    next.order.splice(at, 1)
  }
}

/**
 * The oldest prompt of ours the gateway has parked, if any.
 *
 * Oldest first, because the gateway drains its queue in order. `pending` is set
 * by `beginLocalTurn` and cleared by `confirmSubmit` for anything the gateway
 * took straight away, so what is left marked is exactly the parked queue.
 */
function firstParkedPromptId(next: ChatState): string | undefined {
  for (const id of next.order) {
    const item = next.items[id]

    if (item?.kind === 'user' && item.origin === 'optimistic' && item.pending === true) {
      return item.id
    }
  }

  return undefined
}

function lastAssistantId(next: ChatState): string | undefined {
  for (let index = next.order.length - 1; index >= 0; index -= 1) {
    const id = next.order[index]

    if (id && next.items[id]?.kind === 'assistant') {
      return id
    }
  }

  return undefined
}

function lastItem(next: ChatState): TranscriptItem | undefined {
  const id = next.order.at(-1)

  return id ? next.items[id] : undefined
}

/** The assistant bubble currently receiving deltas, created on first need. */
function currentAssistantId(next: ChatState, now: number): string {
  const existing = next.turn.assistantId ? next.items[next.turn.assistantId] : undefined

  if (existing?.kind === 'assistant' && !existing.interim) {
    return existing.id
  }

  const item = addItem<AssistantItem>(next, {
    id: `a:${next.turn.nextSeq}`,
    kind: 'assistant',
    text: '',
    streaming: true,
    interim: false,
    ts: now / 1000
  })

  next.turn.assistantId = item.id

  return item.id
}

/**
 * The bubble a mid-turn seal left behind, when this completion is plainly that
 * same reply finishing rather than a new one.
 *
 * A tool call seals the streaming bubble as interim (`sealAssistantForTool`),
 * so `message.complete` arrives with no live bubble to settle onto. Painting
 * the final text as a NEW bubble then shows the reply twice — once partially
 * streamed, once clean — while the gateway stored a single row. Upstream hit
 * exactly this (`hermes-agent` #63679, and #74560 for the chained-turn variant)
 * and settles the final onto the interim instead.
 *
 * The test is continuity, not equality: streaming can drop characters and the
 * final can add a trailing delta, so either text being a prefix of the other
 * means the same message. Two different replies cannot satisfy that, which is
 * why this needs no boundary flag to be safe.
 */
function interimContinuedBy(next: ChatState, finalText: string): string | undefined {
  const id = lastAssistantId(next)
  const item = id ? next.items[id] : undefined

  if (item?.kind !== 'assistant' || !item.interim || item.error) {
    return undefined
  }

  const sealed = item.text.trim()
  const final = finalText.trim()

  if (!sealed || !final) {
    return undefined
  }

  return final === sealed || final.startsWith(sealed) || sealed.startsWith(final) ? id : undefined
}

/**
 * A tool call interrupts the reply: seal what the bubble already said as
 * mid-turn commentary so the tool card lands after it, and drop an empty one
 * rather than strand a blank bubble.
 */
function sealAssistantForTool(next: ChatState): void {
  const id = next.turn.assistantId

  if (!id) {
    return
  }

  const item = next.items[id]

  next.turn.assistantId = undefined

  if (item?.kind !== 'assistant') {
    return
  }

  if (!item.text.trim() && !item.reasoning?.trim()) {
    dropItem(next, id)

    return
  }

  patchItem<AssistantItem>(next, id, draft => {
    draft.streaming = false
    draft.interim = true
  })
}

function cancelOpenRequests(next: ChatState, reason: string): void {
  for (const id of next.order) {
    const item = next.items[id]

    if ((item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'open') {
      patchItem(next, id, draft => {
        ;(draft as ApprovalItem | ClarifyItem).state = 'cancelled'
        ;(draft as ApprovalItem | ClarifyItem).cancelReason = reason
      })
    }
  }
}

function clearTurn(next: ChatState): void {
  next.turn.active = false
  // A prompt WE queued starts the next turn, and that turn is still ours. Going
  // non-local here is what used to make our own message arrive as a foreign
  // placeholder the moment the turn ahead of it finished.
  next.turn.local = next.queued?.local === true
  next.turn.assistantId = undefined
  next.turn.startedAt = undefined
  next.turn.draftingTool = undefined
  next.turn.interrupted = false
  next.queued = undefined
  next.compacting = false
}

function pushNotice(next: ChatState, noticeKind: NoticeKind, title: string, body: string, now: number): NoticeItem {
  return addItem<NoticeItem>(next, {
    id: `n:${next.turn.nextSeq}`,
    kind: 'notice',
    noticeKind,
    title,
    ...(body ? { body } : {}),
    ts: now / 1000
  })
}

// ── subagent grouping ────────────────────────────────────────────────────────

function groupForSubagent(next: ChatState, delegationId: string | undefined, goal: string, now: number): string {
  if (delegationId && next.byDelegationId[delegationId]) {
    return next.byDelegationId[delegationId]!
  }

  for (let index = next.order.length - 1; index >= 0; index -= 1) {
    const id = next.order[index]
    const item = id ? next.items[id] : undefined

    if (item?.kind !== 'subagent_group') {
      continue
    }

    if (item.status === 'done' || item.status === 'failed') {
      break
    }

    if (item.delegationId && delegationId && item.delegationId !== delegationId) {
      continue
    }

    return item.id
  }

  const created = addItem<SubagentGroupItem>(next, {
    id: `g:${next.turn.nextSeq}`,
    kind: 'subagent_group',
    ...(delegationId ? { delegationId } : {}),
    goals: goal ? [goal] : [],
    rootIds: [],
    status: 'dispatched',
    ts: now / 1000
  })

  return created.id
}

function refreshGroup(next: ChatState, groupId: string): void {
  patchItem<SubagentGroupItem>(next, groupId, draft => {
    const members = draft.rootIds.map(id => next.subagents[id]).filter(Boolean)

    if (!members.length) {
      return
    }

    const active = members.some(child => child!.status === 'running' || child!.status === 'queued')
    const broken = members.some(child => child!.status === 'failed' || child!.status === 'interrupted')

    draft.status = active ? 'running' : broken ? 'failed' : 'done'
  })
}

// ── the reducer ──────────────────────────────────────────────────────────────

/**
 * Apply one gateway event. Events at or below `lastSeq` are replays and are
 * ignored; `now` is injectable so tests are deterministic.
 */
export function applyEvent(state: ChatState, event: TranscriptEvent, now: number = Date.now()): ChatState {
  if (typeof event.seq === 'number' && event.seq <= state.lastSeq) {
    return state
  }

  const payload = rec(event.payload)
  const next = editable(state)

  if (typeof event.seq === 'number') {
    next.lastSeq = event.seq
  }

  switch (event.type) {
    case 'message.start': {
      next.compacting = false

      if (!next.turn.local) {
        // A prompt of ours the gateway parked starts its turn right here, and
        // nothing in the frame says so: `prompt.submit` answered `queued`
        // minutes ago and `message.start` carries no author. `ChatState.queued`
        // only ever remembered the most recent one, so the SECOND prompt of a
        // parked burst used to start as a foreign turn and put an empty
        // placeholder in front of the user's own message. A bubble still marked
        // `pending` is a prompt of ours waiting for exactly this frame.
        const parked = firstParkedPromptId(next)

        if (parked) {
          patchItem<UserItem>(next, parked, draft => {
            draft.pending = false
          })
          next.turn.local = true
        } else {
          // Nobody local submitted, so this turn belongs to a teammate bot or
          // another surface. Stand a placeholder in for the author until a tail
          // reconcile tells us who spoke.
          addItem<UserItem>(
            next,
            {
              id: `f:${next.turn.nextSeq}`,
              kind: 'user',
              text: '',
              unknownAuthor: true,
              ts: now / 1000
            },
            'foreign'
          )
          next.turn.foreignReconcilePending = true
        }
      }

      next.turn.active = true
      next.turn.startedAt = now
      next.turn.assistantId = undefined
      next.turn.interrupted = false
      next.turn.draftingTool = undefined

      return next
    }

    case 'message.delta': {
      const text = str(payload.text)

      if (!text) {
        return next
      }

      const id = currentAssistantId(next, now)

      patchItem<AssistantItem>(next, id, draft => {
        draft.text += text
        draft.streaming = true
      })

      return next
    }

    case 'reasoning.delta':
    case 'thinking.delta':
    case 'reasoning.available': {
      const text = str(payload.text)

      if (!text) {
        return next
      }

      const id = currentAssistantId(next, now)
      const replace = event.type === 'reasoning.available'

      patchItem<AssistantItem>(next, id, draft => {
        draft.reasoning = replace ? text : (draft.reasoning ?? '') + text

        if (payload.verbose === true) {
          draft.reasoningVerbose = true
        }
      })

      return next
    }

    case 'message.interim': {
      const text = str(payload.text)
      const id = next.turn.assistantId

      if (id && next.items[id]?.kind === 'assistant') {
        patchItem<AssistantItem>(next, id, draft => {
          if (text) {
            draft.text = text
          }

          draft.streaming = false
          draft.interim = true
        })
        next.turn.assistantId = undefined

        return next
      }

      if (text) {
        addItem<AssistantItem>(next, {
          id: `a:${next.turn.nextSeq}`,
          kind: 'assistant',
          text,
          streaming: false,
          interim: true,
          ts: now / 1000
        })
      }

      return next
    }

    case 'tool.generating': {
      next.turn.draftingTool = str(payload.name)

      return next
    }

    case 'tool.start': {
      sealAssistantForTool(next)
      next.turn.draftingTool = undefined

      const toolId = str(payload.tool_id) || `gen-${next.turn.nextSeq}`
      const name = str(payload.name) || 'tool'
      const args = rec(payload.args)
      const ts = now / 1000

      if (name === 'message_agent') {
        const target = str(args.target)

        addItem<BotDmOutItem>(next, {
          id: `t:${toolId}`,
          kind: 'bot_dm_out',
          toolId,
          target,
          targetHandle: normalizeAgentTarget(target),
          message: str(args.message),
          dispatch: { status: 'sending' },
          ts
        })

        return next
      }

      if (name === 'delegate_task') {
        addItem<SubagentGroupItem>(next, {
          id: `t:${toolId}`,
          kind: 'subagent_group',
          toolId,
          goals: goalsFromArgs(args),
          rootIds: [],
          status: 'dispatched',
          ts
        })

        return next
      }

      const context = str(payload.context)
      const argsText = str(payload.args_text)

      addItem<ToolItem>(next, {
        id: `t:${toolId}`,
        kind: 'tool',
        toolId,
        name,
        ...(context ? { context, summary: context } : {}),
        ...(Object.keys(args).length ? { args } : {}),
        ...(argsText ? { argsText } : {}),
        status: 'running',
        resultKnown: false,
        ts
      })

      return next
    }

    case 'tool.complete': {
      const toolId = str(payload.tool_id)
      const name = str(payload.name) || 'tool'
      let id = toolId ? next.byToolId[toolId] : undefined

      if (!id) {
        // A tool whose start we missed (late attach, replay gap): materialise it
        // now so the result is never dropped.
        id = addItem<ToolItem>(next, {
          id: `t:${toolId || `late-${next.turn.nextSeq}`}`,
          kind: 'tool',
          toolId: toolId || `late-${next.turn.nextSeq}`,
          name,
          status: 'running',
          resultKnown: false,
          ts: now / 1000
        }).id
      }

      const item = next.items[id]
      const durationS = num(payload.duration_s)
      const summary = str(payload.summary)
      const resultText = str(payload.result_text)
      const inlineDiff = str(payload.inline_diff)
      const failed = Boolean(payload.error)

      if (item?.kind === 'bot_dm_out') {
        const dispatch = parseMessageAgentResult(payload.result ?? resultText)

        patchItem<BotDmOutItem>(next, id, draft => {
          draft.dispatch = dispatch
        })

        if (dispatch.processId) {
          next.byProcessId[dispatch.processId] = id
        }
      } else if (item?.kind === 'subagent_group') {
        patchItem<SubagentGroupItem>(next, id, draft => {
          const active = draft.rootIds.some(child => {
            const status = next.subagents[child]?.status

            return status === 'running' || status === 'queued'
          })

          draft.status = failed ? 'failed' : active ? 'running' : 'done'

          if (summary || resultText) {
            draft.completion = summary || resultText
          }
        })
      } else {
        patchItem<ToolItem>(next, id, draft => {
          draft.status = failed ? 'error' : 'complete'
          draft.resultKnown = true
          draft.result = payload.result
          draft.isError = failed

          if (resultText) {
            draft.resultText = resultText
          }

          if (summary) {
            draft.summary = summary
          }

          if (inlineDiff.trim()) {
            draft.inlineDiff = inlineDiff
          }

          if (durationS !== undefined) {
            draft.durationS = durationS
          }
        })
      }

      if (Array.isArray(payload.todos)) {
        next.todo = { todos: payload.todos, revision: num(payload.revision) ?? 0 }
      }

      return next
    }

    case 'todo.updated': {
      if (Array.isArray(payload.todos)) {
        next.todo = { todos: payload.todos, revision: num(payload.revision) ?? 0 }
      }

      return next
    }

    case 'tool.output_risk': {
      const id = next.byToolId[str(payload.tool_id)]

      if (id) {
        patchItem<ToolItem>(next, id, draft => {
          draft.outputRisk = {
            risk: str(payload.risk),
            findings: Array.isArray(payload.findings) ? payload.findings.filter(f => typeof f === 'string') : [],
            redacted: payload.redacted === true
          }
        })
      }

      return next
    }

    case 'subagent.spawn_requested':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.thinking':
    case 'subagent.tool':
    case 'subagent.complete': {
      const childId = subagentIdOf(payload)
      const prev = next.subagents[childId]
      const createIfMissing = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'

      if ((!prev && !createIfMissing) || (prev && TERMINAL_SUBAGENT_STATUS.has(prev.status))) {
        return next
      }

      const child = toSubagent(payload, prev, event.type, now)

      next.subagents[childId] = child

      const groupId = groupForSubagent(next, child.delegationId, child.goal, now)

      patchItem<SubagentGroupItem>(next, groupId, draft => {
        if (!draft.rootIds.includes(childId)) {
          draft.rootIds = [...draft.rootIds, childId]
        }

        if (child.goal && !draft.goals.includes(child.goal)) {
          draft.goals = [...draft.goals, child.goal]
        }

        if (child.delegationId && !draft.delegationId) {
          draft.delegationId = child.delegationId
        }
      })
      refreshGroup(next, groupId)

      return next
    }

    case 'status.update': {
      const kind = str(payload.kind)
      const text = str(payload.text)

      if (kind === 'compacting') {
        next.compacting = true
      } else if (kind === 'compacted') {
        next.compacting = false
      }

      if (!text) {
        return next
      }

      const tail = lastItem(next)

      if (tail?.kind === 'status') {
        patchItem<StatusItem>(next, tail.id, draft => {
          draft.statusKind = kind
          draft.text = text
          draft.ts = now / 1000
        })

        return next
      }

      addItem<StatusItem>(next, {
        id: `s:${next.turn.nextSeq}`,
        kind: 'status',
        statusKind: kind,
        text,
        ts: now / 1000
      })

      return next
    }

    case 'message.complete': {
      const finalText = str(payload.text) || str(payload.rendered)
      const wasInterrupted = next.turn.interrupted === true
      const rawStatus = str(payload.status)
      const status: AssistantItem['status'] =
        rawStatus === 'error' ? 'error' : rawStatus === 'interrupted' || wasInterrupted ? 'interrupted' : 'complete'
      const durationS = next.turn.startedAt ? (now - next.turn.startedAt) / 1000 : undefined
      const failure =
        rawStatus === 'error'
          ? {
              message: str(payload.error).trim() || finalText || 'The gateway reported an error',
              partial: payload.partial === true,
              ...(payload.recoverable === true ? { recoverable: true } : {}),
              ...(payload.error_surface ? { surface: asErrorSurface(payload.error_surface) } : {})
            }
          : undefined

      // `response_previewed` means the reply already landed as a sealed interim
      // bubble; promote that one instead of painting the same text twice.
      const previewed = payload.response_previewed === true ? lastAssistantId(next) : undefined
      // Without that flag, a tool call in the middle of the turn has the same
      // effect: it sealed the bubble, so this completion has nowhere to land.
      const continued = next.turn.assistantId ? undefined : interimContinuedBy(next, finalText)
      const id =
        next.turn.assistantId ??
        previewed ??
        continued ??
        (finalText || failure ? currentAssistantId(next, now) : undefined)

      if (id) {
        patchItem<AssistantItem>(next, id, draft => {
          if (finalText && payload.response_previewed !== true) {
            draft.text = finalText
          }

          draft.streaming = false
          draft.interim = false
          draft.status = status

          if (failure) {
            draft.error = failure
          }

          if (payload.usage) {
            draft.usage = asUsage(payload.usage)
          }

          if (durationS !== undefined) {
            draft.durationS = durationS
          }
        })
      }

      if (payload.usage) {
        next.usage = asUsage(payload.usage)
      }

      cancelOpenRequests(next, 'turn_ended')
      clearTurn(next)

      return next
    }

    case 'session.info': {
      next.info = asSessionInfo(payload)

      const stored = str(payload.stored_session_id)

      if (stored) {
        next.storedSessionId = stored
      }

      if (payload.running === false) {
        next.turn.active = false
      }

      return next
    }

    case 'session.usage': {
      if (payload.usage) {
        next.usage = asUsage(payload.usage)
      }

      return next
    }

    case 'session.title': {
      const title = str(payload.title)

      // A canonical Bot Chat is titled exactly `Bot Chat`; anything else means
      // this session drifted out of the canonical set and must be re-resolved.
      if (title && title !== 'Bot Chat') {
        next.hydration = 'stale'
      }

      return next
    }

    case 'error': {
      const message = str(payload.message) || 'The gateway reported an error'
      const id = next.turn.assistantId ?? currentAssistantId(next, now)

      patchItem<AssistantItem>(next, id, draft => {
        draft.streaming = false
        draft.interim = false
        draft.status = 'error'
        draft.error = { message, partial: Boolean(draft.text) }
      })
      cancelOpenRequests(next, 'turn_failed')
      clearTurn(next)

      return next
    }

    case 'notice': {
      const message = str(payload.message)

      if (message) {
        pushNotice(next, 'notice', message, '', now)
      }

      return next
    }

    case 'request.cancel': {
      // The gateway withdraws a question under whichever id it knows it by: the
      // transport's request id for a live one, the approval queue's own id for
      // one the client only ever saw as a snapshot entry.
      const cancelId = str(payload.id)
      const id = next.byRequestId[cancelId] ?? next.byApprovalId[cancelId]

      if (id) {
        patchItem(next, id, draft => {
          ;(draft as ApprovalItem | ClarifyItem).state = 'cancelled'
          ;(draft as ApprovalItem | ClarifyItem).cancelReason = str(payload.reason)
        })
      }

      return next
    }

    case 'message.reaction': {
      const rowId = num(payload.row_id)
      const id = rowId === undefined ? undefined : next.byRowId[String(rowId)]

      if (id && Array.isArray(payload.reactions)) {
        const reactions = asReactions(payload.reactions)

        patchItem(next, id, draft => {
          draft.reactions = reactions
        })
      }

      return next
    }

    case 'session.reclaimed': {
      next.runtimeSessionId = undefined
      next.turn.active = false
      pushNotice(next, 'reclaimed', 'Session reclaimed by the gateway', str(payload.reason), now)

      return next
    }

    case 'btw.complete':
    case 'background.complete': {
      const text = str(payload.text).trim()

      if (text) {
        const question = str(payload.question).trim()

        pushNotice(next, 'notice', question ? `Side question: ${question}` : 'Background task finished', text, now)
      }

      return next
    }

    default:
      return next
  }
}

function goalsFromArgs(args: Record<string, unknown>): string[] {
  if (typeof args.goal === 'string' && args.goal.trim()) {
    return [args.goal.trim()]
  }

  if (!Array.isArray(args.tasks)) {
    return []
  }

  return args.tasks
    .map(task => rec(task).goal)
    .filter((goal): goal is string => typeof goal === 'string' && Boolean(goal.trim()))
    .map(goal => goal.trim())
}

// ── server→client requests ───────────────────────────────────────────────────

/**
 * The id of the still-open approval card carrying this queue entry, if there is
 * one. An answered or cancelled card does not block a fresh question that the
 * queue happened to give the same id.
 */
function openApprovalIdOf(state: ChatState, approvalId: string): string | undefined {
  if (!approvalId) {
    return undefined
  }

  const id = state.byApprovalId[approvalId]
  const item = id ? state.items[id] : undefined

  return item?.kind === 'approval' && item.state === 'open' ? id : undefined
}

/** Turn an `approval` / `clarify` server request into a transcript item. */
export function applyServerRequest(state: ChatState, request: ServerRequest, now: number = Date.now()): ChatState {
  if (state.byRequestId[request.id]) {
    return state
  }

  const params = rec(request.params)

  if (request.method === 'approval' && openApprovalIdOf(state, str(params.request_id) || request.id)) {
    // The same queue entry under a second transport id. One question, one card.
    return state
  }

  const next = editable(state)

  if (request.method === 'approval') {
    const choices = Array.isArray(params.choices)
      ? params.choices.filter((choice): choice is string => typeof choice === 'string')
      : DEFAULT_APPROVAL_CHOICES

    addItem<ApprovalItem>(next, {
      id: `req:${request.id}`,
      kind: 'approval',
      requestId: request.id,
      approvalId: str(params.request_id) || request.id,
      command: str(params.command),
      ...(str(params.description) ? { description: str(params.description) } : {}),
      ...(str(params.tool_name) ? { toolName: str(params.tool_name) } : {}),
      choices: choices.length ? choices : DEFAULT_APPROVAL_CHOICES,
      ...(params.allow_permanent === false ? { allowPermanent: false } : { allowPermanent: true }),
      ...(params.allow_session === false ? { allowSession: false } : { allowSession: true }),
      ...(params.smart_denied === true ? { smartDenied: true } : {}),
      state: 'open',
      ts: now / 1000
    })

    return next
  }

  if (request.method === 'clarify') {
    const answers: Record<string, string> = {}

    for (const [qid, value] of Object.entries(rec(params.answers))) {
      if (typeof value === 'string') {
        answers[qid] = value
      }
    }

    const questions: ClarifyQuestionItem[] = Array.isArray(params.questions)
      ? params.questions.map((raw, index) => {
          const question = rec(raw)

          return {
            qid: str(question.qid) || `q${index + 1}`,
            question: str(question.question),
            ...(Array.isArray(question.choices)
              ? { choices: question.choices.filter((c): c is string => typeof c === 'string') }
              : {}),
            multiSelect: question.multi_select === true
          }
        })
      : [
          {
            qid: str(params.request_id) || 'q1',
            question: str(params.question),
            ...(Array.isArray(params.choices)
              ? { choices: params.choices.filter((c): c is string => typeof c === 'string') }
              : {}),
            multiSelect: params.multi_select === true
          }
        ]

    addItem<ClarifyItem>(next, {
      id: `req:${request.id}`,
      kind: 'clarify',
      requestId: request.id,
      questions,
      ...(Array.isArray(params.questions) ? { batch: true } : {}),
      answers,
      locked: Object.keys(answers),
      state: questions.every(question => answers[question.qid] !== undefined) && questions.length ? 'answered' : 'open',
      ts: now / 1000
    })

    return next
  }

  return state
}

/** Record the user's answer locally; the transport still owns the RPC reply. */
export function answerRequest(state: ChatState, requestId: string, answer: string | Record<string, string>): ChatState {
  const id = state.byRequestId[requestId]
  const item = id ? state.items[id] : undefined

  if (!id || !item || (item.kind !== 'approval' && item.kind !== 'clarify')) {
    return state
  }

  const next = editable(state)

  if (item.kind === 'approval') {
    patchItem<ApprovalItem>(next, id, draft => {
      draft.answer = typeof answer === 'string' ? answer : (Object.values(answer)[0] ?? '')
      draft.state = 'answered'
    })

    return next
  }

  patchItem<ClarifyItem>(next, id, draft => {
    const merged = { ...draft.answers }

    if (typeof answer === 'string') {
      const open = draft.questions.find(question => merged[question.qid] === undefined)

      if (open) {
        merged[open.qid] = answer
      }
    } else {
      Object.assign(merged, answer)
    }

    draft.answers = merged
    draft.locked = Object.keys(merged)
    draft.state = draft.questions.every(question => merged[question.qid] !== undefined) ? 'answered' : 'open'
  })

  return next
}

// ── resume + local turns ─────────────────────────────────────────────────────

export interface ResumeSnapshot {
  inflight?: Record<string, unknown> | null
  running?: boolean | null
  queued?: Record<string, unknown> | null
  pending_approval?: Record<string, unknown> | null
  todo_state?: Record<string, unknown> | null
  open_requests?: ServerRequest[] | null
  [key: string]: unknown
}

/**
 * The tail of the transcript as a resume has to read it: the newest turn's
 * prompt, and the persisted reply to it if there already is one.
 *
 * `authored` is the last user or inbound-DM item, whatever origin it has;
 * `settledReply` is the durable assistant row after it. Nothing else is needed,
 * because `session.resume`'s `inflight` describes exactly one turn — the newest.
 */
function shownTurn(state: ChatState): { authored?: string; settledReply?: string } {
  let settledReply: string | undefined

  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.items[state.order[index] ?? '']

    if (item?.kind === 'assistant' && item.rowId !== undefined && settledReply === undefined) {
      settledReply = normalizedItemText(item)

      continue
    }

    if (item?.kind !== 'user' && item?.kind !== 'bot_dm_in' && item?.kind !== 'cron_delivery') {
      continue
    }

    return { authored: normalizedItemText(item), ...(settledReply !== undefined ? { settledReply } : {}) }
  }

  return settledReply !== undefined ? { settledReply } : {}
}

/**
 * How much of a resume's `inflight` the transcript is already showing.
 *
 * A resume answers with two overlapping truths: the gateway's live view of a
 * turn, and the rows it has already written. The user's prompt is normally in
 * BOTH, because the gateway persists that row at submit time
 * (`_persist_submit_user_row`) rather than when the turn ends — so projecting it
 * on top of the bubble standing for it is how one sent message came back as two,
 * one stamped when it was typed and one when the chat was resumed.
 *
 * Matching the newest prompt is not enough on its own: the user may deliberately
 * send the same words again, and another client may have sent them while we were
 * away. What tells those apart is the reply between them. A durable reply after
 * the matching prompt means that turn is finished, so the `inflight` is a NEW
 * turn and gets its own bubble — unless the reply is the `inflight`'s own
 * assistant text, which is the gateway holding a finished turn replayable (a
 * retained failure) and describing what the transcript already shows.
 */
function resumeOverlap(
  state: ChatState,
  userText: string,
  assistantText: string
): { promptShown: boolean; replyPersisted: boolean } {
  const shown = shownTurn(state)
  // A scheduled job's prompt is shown as a card keyed on its name and body, not
  // on the raw text, so it has to be compared in that form or every resume
  // during a cron turn stands a second card beside the first.
  const cron = parseCronDelivery(userText)
  const promptKey = normalizeMatchText(cron ? `${cron.jobName}\n${cron.body}` : userText)
  const promptShown = Boolean(userText) && shown.authored !== undefined && shown.authored === promptKey

  if (!promptShown) {
    return { promptShown: false, replyPersisted: false }
  }

  if (shown.settledReply === undefined) {
    return { promptShown: true, replyPersisted: false }
  }

  return shown.settledReply === normalizeMatchText(assistantText)
    ? { promptShown: true, replyPersisted: true }
    : { promptShown: false, replyPersisted: false }
}

/** The un-persisted assistant bubble this turn is filling, if it has one. */
function liveAssistantOfCurrentTurn(state: ChatState): AssistantItem | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.items[state.order[index] ?? '']

    if (item?.kind !== 'assistant') {
      continue
    }

    return item.rowId === undefined ? item : undefined
  }

  return undefined
}

/**
 * Rebuild the in-flight tail from `session.resume`. Everything it adds carries
 * `origin: 'inflight'` so a later reconcile can replace it with the persisted
 * rows without leaving a duplicate behind.
 *
 * What it adds is only what the transcript does not already show. A resume lands
 * on a chat that has been streaming the very turn it describes — and on a cold
 * open whose history already carries that turn's prompt — so both halves of the
 * projection settle onto the items standing for them rather than beside them.
 */
export function applyResumeSnapshot(state: ChatState, snapshot: ResumeSnapshot, now: number = Date.now()): ChatState {
  let next = editable(state)
  const inflight = rec(snapshot.inflight)
  const userText = str(inflight.user).trim()
  const assistantText = str(inflight.assistant)
  const overlap = resumeOverlap(next, userText, assistantText)

  if (userText && !overlap.promptShown) {
    // The turn a resume finds running may be a scheduled job's, not the owner's.
    // Projecting it here rather than only in `rows-to-items` is what keeps the
    // invariant: a cron delivery renders as the same card whether the chat was
    // open when it landed or loaded from history afterwards.
    const cron = parseCronDelivery(userText)

    if (cron) {
      addItem<CronDeliveryItem>(
        next,
        {
          id: `i:${next.turn.nextSeq}`,
          kind: 'cron_delivery',
          jobName: cron.jobName,
          ...(cron.nameRedacted ? { nameRedacted: true } : {}),
          body: cron.body,
          shape: cron.shape,
          ts: now / 1000
        },
        'inflight'
      )
    } else {
      addItem<UserItem>(
        next,
        { id: `i:${next.turn.nextSeq}`, kind: 'user', text: userText, ts: now / 1000 },
        'inflight'
      )
    }
  }

  const inflightStatus = str(inflight.status)
  const inflightError = str(inflight.error).trim()
  const failure = inflightError
    ? {
        message: inflightError,
        partial: Boolean(assistantText),
        ...(inflight.recoverable === true ? { recoverable: true } : {})
      }
    : undefined

  // A durable row already carrying this reply needs nothing added to it; the
  // `live` branch below covers the bubble a stream is still filling.
  if ((assistantText || failure) && !overlap.replyPersisted) {
    const live = liveAssistantOfCurrentTurn(next)

    if (!live) {
      const item = addItem<AssistantItem>(
        next,
        {
          id: `i:${next.turn.nextSeq}`,
          kind: 'assistant',
          text: assistantText,
          streaming: inflight.streaming === true,
          interim: false,
          ...(failure
            ? { status: 'error' as const, error: failure }
            : inflightStatus === 'interrupted'
              ? { status: 'interrupted' as const }
              : {}),
          ts: now / 1000
        },
        'inflight'
      )

      if (inflight.streaming === true) {
        next.turn.assistantId = item.id
      }
    } else {
      // `inflight.assistant` is this turn's reply flattened to one string, and
      // the bubble on screen is that same reply — so it settles onto it. A
      // bubble a tool call already SEALED holds one segment of that flat
      // string, never the whole of it, so its text is left alone and only the
      // verdict lands: repainting it would show the segment twice.
      const sealed = live.interim

      patchItem<AssistantItem>(next, live.id, draft => {
        if (!sealed) {
          if (assistantText.length > draft.text.length) {
            draft.text = assistantText
          }

          draft.streaming = inflight.streaming === true
        }

        if (failure) {
          draft.status = 'error'
          draft.error = failure
        } else if (inflightStatus === 'interrupted' && !sealed) {
          draft.status = 'interrupted'
        }
      })

      if (inflight.streaming === true && !sealed) {
        next.turn.assistantId = live.id
      }
    }
  }

  if (snapshot.running === true) {
    next.turn.active = true
    next.turn.startedAt = next.turn.startedAt ?? now
  }

  const queued = str(rec(snapshot.queued).user).trim()

  if (queued) {
    next.queued = { text: queued }
  }

  const todoState = rec(snapshot.todo_state)

  if (Array.isArray(todoState.todos)) {
    next.todo = { todos: todoState.todos, revision: num(todoState.revision) ?? 0 }
  }

  const pending = rec(snapshot.pending_approval)

  if (str(pending.request_id) || str(pending.command)) {
    // `pending_approval` is a queue entry, not a live server request: synthesize
    // a request id from it so the sheet can be rebuilt and later cancelled.
    const requestId = `pending:${str(pending.request_id) || 'approval'}`

    next = applyServerRequest(next, { id: requestId, method: 'approval', params: pending, replayed: true }, now)
    next = editable(next)
  }

  for (const request of snapshot.open_requests ?? []) {
    next = applyServerRequest(next, { ...request, replayed: true }, now)
    next = editable(next)
  }

  next.hydration = 'live'

  return next
}

/**
 * Paint the user's own message before the gateway has echoed it.
 *
 * `text` is the body as submitted, and the body is not what the row will look
 * like: the gateway stores the prompt verbatim — `@file:` and `@image:`
 * directives included — and `stripUserText` lifts those directives out of the
 * text into `attachments` on the way back. Painting the raw body left the bubble
 * holding a different string from its own row, and since text is the only thing
 * that pairs the two, every send carrying a file came back as a second bubble.
 * So the optimistic item goes through the SAME projection a persisted row does.
 */
export function beginLocalTurn(
  state: ChatState,
  text: string,
  attachments?: string[],
  now: number = Date.now()
): ChatState {
  const next = editable(state)
  const projected = stripUserText(text)
  // The caller's names are the friendlier chip ("notes.txt", not a gateway
  // path); the projected refs are the fallback for a ref the user typed.
  const refs = attachments?.length ? attachments : projected.attachments

  addItem<UserItem>(
    next,
    {
      id: `o:${next.turn.nextSeq}`,
      kind: 'user',
      text: projected.text,
      ...(refs?.length ? { attachments: refs } : {}),
      pending: true,
      ts: now / 1000
    },
    'optimistic'
  )

  next.turn.local = true
  next.turn.active = true
  next.turn.startedAt = now
  next.turn.interrupted = false
  next.draft = ''

  return next
}

function lastOptimisticUserId(state: ChatState): string | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]
    const item = id ? state.items[id] : undefined

    if (item?.kind === 'user' && item.origin === 'optimistic') {
      return item.id
    }
  }

  return undefined
}

/** Settle the optimistic turn against `prompt.submit`'s answer. */
export function confirmSubmit(state: ChatState, result: SubmitResult, now: number = Date.now()): ChatState {
  const id = lastOptimisticUserId(state)

  if (!id) {
    return state
  }

  const next = editable(state)
  const status = str(result.status)

  patchItem<UserItem>(next, id, draft => {
    draft.pending = status === 'queued'

    if (status === 'steered') {
      draft.displayKind = 'steer'
    }
  })

  if (status === 'queued') {
    const item = next.items[id]

    next.queued = { text: item?.kind === 'user' ? item.text : '', local: true }
    // A queued prompt does not start a turn of its own; the running one owns it.
    next.turn.active = state.turn.active
  } else if (status === 'steered' || status === 'redirected') {
    // Steer / redirect fold into the turn already running.
    next.turn.startedAt = next.turn.startedAt ?? now
  }

  return next
}

/** The user pressed Stop: keep the partial reply, stop claiming the turn runs. */
export function markInterrupted(state: ChatState, now: number = Date.now()): ChatState {
  const next = editable(state)
  const id = next.turn.assistantId

  if (id && next.items[id]?.kind === 'assistant') {
    patchItem<AssistantItem>(next, id, draft => {
      draft.streaming = false
      draft.status = 'interrupted'

      if (next.turn.startedAt) {
        draft.durationS = (now - next.turn.startedAt) / 1000
      }
    })
  }

  // Stop bumps the gateway's queue generation, and a submit that threw never
  // reached the queue at all — so nothing of ours is parked any more. A bubble
  // left marked `pending` would make the next turn a teammate starts read as
  // that prompt's, and the reader would never be told who really spoke.
  for (const id of next.order) {
    const item = next.items[id]

    if (item?.kind === 'user' && item.pending === true) {
      patchItem<UserItem>(next, id, draft => {
        draft.pending = false
      })
    }
  }

  next.queued = undefined
  next.turn.local = false
  next.turn.active = false
  next.turn.interrupted = true
  next.turn.assistantId = undefined
  next.turn.draftingTool = undefined

  return next
}

/** Join a `process_complete` payload onto the dispatch that spawned it. */
export function applyProcessCompletion(state: ChatState, text: string, now: number = Date.now()): ChatState {
  const blocks = parseProcessCompleteText(text)

  if (!blocks.length) {
    return state
  }

  const next = editable(state)

  for (const block of blocks) {
    const id = next.byProcessId[block.sid]

    if (!id) {
      continue
    }

    const outcome = replyFromDeliveryOutput(block.output)

    patchItem<BotDmOutItem>(next, id, draft => {
      draft.reply = {
        text: outcome.text ?? '',
        ts: now / 1000,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {})
      }

      if (outcome.error) {
        draft.dispatch = { ...draft.dispatch, status: 'failed', error: outcome.error }
      }
    })
  }

  return next
}

/** One `subagent.list` row, as thin as the reconcile needs it. */
export interface SubagentSnapshotRow {
  subagent_id: string
  parent_id?: string | null
  depth?: number | null
  goal?: string | null
  delegation_id?: string | null
  model?: string | null
  started_at?: number | null
  status?: string | null
  tool_count?: number | null
  last_tool?: string | null
  accepting_steer?: boolean | null
  child_session_id?: string | null
}

/**
 * Fold a `subagent.list` snapshot into the chat.
 *
 * The `subagent.*` events are a stream, and a chat opened halfway through a
 * delegation missed the beginning of it — there is no replay for children. The
 * snapshot is the roster the gateway can still describe, so it CREATES children
 * the events never announced and refreshes the ones they did.
 *
 * It deliberately does not remove anything: a child the gateway has forgotten
 * (it only lists live ones) has usually just finished, and dropping the row
 * would erase the summary the reader is looking at.
 */
export function applySubagentSnapshot(
  state: ChatState,
  rows: readonly SubagentSnapshotRow[],
  now: number = Date.now()
): ChatState {
  if (!rows.length) {
    return state
  }

  const next = editable(state)
  let changed = false

  for (const row of rows) {
    const payload: Record<string, unknown> = {
      subagent_id: row.subagent_id,
      parent_id: row.parent_id ?? null,
      goal: row.goal ?? '',
      delegation_id: row.delegation_id ?? '',
      model: row.model ?? '',
      status: row.status ?? 'running',
      ...(row.depth !== null && row.depth !== undefined ? { depth: row.depth } : {}),
      ...(row.tool_count !== null && row.tool_count !== undefined ? { tool_count: row.tool_count } : {}),
      ...(row.last_tool ? { tool_name: row.last_tool } : {}),
      ...(row.child_session_id ? { child_session_id: row.child_session_id } : {})
    }

    const childId = subagentIdOf(payload)
    const prev = next.subagents[childId]

    if (prev && TERMINAL_SUBAGENT_STATUS.has(prev.status)) {
      // The stream already saw this child finish; the roster is behind.
      continue
    }

    // `subagent.list` is a roster, not a progress frame: it carries no stream
    // line to append, so it is applied as a plain `start`-shaped update.
    const child = toSubagent(payload, prev, 'subagent.start', prev?.startedAt ? prev.updatedAt : now)
    const startedAt = prev?.startedAt ?? millisecondsOf(row.started_at) ?? child.startedAt

    next.subagents[childId] = {
      ...child,
      startedAt,
      ...(row.accepting_steer !== null && row.accepting_steer !== undefined
        ? { acceptingSteer: row.accepting_steer }
        : {})
    }

    changed = true

    const groupId = groupForSubagent(next, child.delegationId, child.goal, now)

    patchItem<SubagentGroupItem>(next, groupId, draft => {
      if (!draft.rootIds.includes(childId)) {
        draft.rootIds = [...draft.rootIds, childId]
      }

      if (child.goal && !draft.goals.includes(child.goal)) {
        draft.goals = [...draft.goals, child.goal]
      }

      if (child.delegationId && !draft.delegationId) {
        draft.delegationId = child.delegationId
      }
    })
    refreshGroup(next, groupId)
  }

  return changed ? next : state
}

/**
 * `started_at` on a roster row is unix SECONDS, while `Subagent.startedAt` is
 * the millisecond clock the events are stamped with. A value already past the
 * year-5138 mark in seconds is milliseconds somebody forgot to divide.
 */
function millisecondsOf(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  return value > 1e11 ? value : value * 1000
}
