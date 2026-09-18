/**
 * Offline cache shape.
 *
 * Only settled transcript goes in: an optimistic submit, a foreign placeholder
 * and an unanswered request all describe a moment, not the chat, and restoring
 * them from disk would resurrect a question the gateway already forgot.
 */
import { type ChatState, createChatState, SEQ_STEP, type Subagent, type TranscriptItem } from './types'

export const CACHE_ITEM_LIMIT = 200
export const CACHE_FORMAT = 1

export interface CachedTranscript {
  format: number
  items: TranscriptItem[]
  subagents: Subagent[]
  lastRowId?: number
  lastSeq: number
  epoch?: string
  updatedAt: number
}

export interface SessionIds {
  storedSessionId: string
  resolvedSessionId: string
}

const isCacheable = (item: TranscriptItem): boolean => {
  if (item.origin === 'optimistic' || item.origin === 'foreign') {
    return false
  }

  return !((item.kind === 'approval' || item.kind === 'clarify') && item.state === 'open')
}

export function snapshotForCache(state: ChatState, now: number = Date.now()): CachedTranscript {
  const items = state.order
    .map(id => state.items[id])
    .filter((item): item is TranscriptItem => Boolean(item) && isCacheable(item!))
    .slice(-CACHE_ITEM_LIMIT)
    // A bubble that was mid-stream when the app went away is finished as far as
    // the cache is concerned; nothing will ever append to it again.
    .map(item => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))

  const lastRowId = items.reduce<number | undefined>(
    (last, item) => (item.rowId !== undefined ? item.rowId : last),
    undefined
  )

  return {
    format: CACHE_FORMAT,
    items,
    subagents: Object.values(state.subagents),
    ...(lastRowId !== undefined ? { lastRowId } : {}),
    lastSeq: state.lastSeq,
    ...(state.epoch ? { epoch: state.epoch } : {}),
    updatedAt: now
  }
}

/** Rebuild a paintable state from disk. Indices are derived, never stored. */
export function stateFromCache(botName: string, ids: SessionIds, snapshot: CachedTranscript): ChatState {
  const state = createChatState(botName, ids.storedSessionId, ids.resolvedSessionId)

  if (snapshot.format !== CACHE_FORMAT) {
    return state
  }

  snapshot.items.forEach((item, index) => {
    const placed = { ...item, seq: index * SEQ_STEP }

    state.items[placed.id] = placed
    state.order.push(placed.id)

    if (placed.rowId !== undefined) {
      state.byRowId[String(placed.rowId)] = placed.id
    }

    if (placed.kind === 'tool' || placed.kind === 'bot_dm_out') {
      state.byToolId[placed.toolId] = placed.id
    }

    if (placed.kind === 'bot_dm_out' && placed.dispatch.processId) {
      state.byProcessId[placed.dispatch.processId] = placed.id
    }

    if (placed.kind === 'subagent_group') {
      if (placed.toolId) {
        state.byToolId[placed.toolId] = placed.id
      }

      if (placed.delegationId) {
        state.byDelegationId[placed.delegationId] = placed.id
      }
    }

    if (placed.kind === 'approval' || placed.kind === 'clarify') {
      state.byRequestId[placed.requestId] = placed.id
    }
  })

  for (const child of snapshot.subagents) {
    state.subagents[child.id] = child
  }

  state.turn.nextSeq = snapshot.items.length * SEQ_STEP
  state.lastSeq = snapshot.lastSeq
  state.hydration = 'cached'

  if (snapshot.epoch) {
    state.epoch = snapshot.epoch
  }

  if (snapshot.lastRowId !== undefined) {
    state.lastSeenRowId = snapshot.lastRowId
  }

  return state
}
