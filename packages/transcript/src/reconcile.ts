/**
 * Reconciliation: fold a freshly hydrated transcript into the live state
 * without losing the tail and without renaming items.
 *
 * Stable ids are the point. A UI keyed on `item.id` must not remount every row
 * when a re-hydration lands, so a fresh item adopts the id of the current item
 * it matches: durable `rowId` first, then `tool_id`, then normalised text.
 *
 * Ported from `apps/desktop/src/lib/chat-messages/reconciliation.ts`.
 */
import { normalizedItemText } from './rows-to-items'
import {
  type AssistantItem,
  type BotDmOutItem,
  type ChatState,
  type NoticeItem,
  SEQ_STEP,
  type SubagentGroupItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from './types'
import { replyFromDeliveryOutput } from './bot-dm'

const toolKeyOf = (item: TranscriptItem): string | undefined =>
  item.kind === 'tool' || item.kind === 'bot_dm_out'
    ? item.toolId
    : item.kind === 'subagent_group'
      ? item.toolId
      : undefined

const textKeyOf = (item: TranscriptItem): string => `${item.kind}\n${normalizedItemText(item)}`

/** Items the backend never persists, so a re-hydration can never re-supply them. */
const isEphemeral = (item: TranscriptItem): boolean => item.kind === 'approval' || item.kind === 'clarify'

/**
 * A row that opens a turn, and therefore names the author a foreign
 * `message.start` placeholder is standing in for.
 *
 * A cron delivery counts: the scheduler's report runs on the `user` role and
 * starts a turn nobody local submitted, so it is exactly what such a placeholder
 * is waiting for. `mergeWithLive` needs no cron case of its own — the stream
 * learns nothing about a delivery that the persisted row does not also carry, so
 * the default "fresh wins, id is kept" merge is already correct.
 */
const isAuthoredRow = (item: TranscriptItem): boolean =>
  item.kind === 'user' || item.kind === 'bot_dm_in' || item.kind === 'cron_delivery'

/** Merge live knowledge onto a hydrated row: history is thinner than the stream. */
function mergeWithLive(fresh: TranscriptItem, current: TranscriptItem): TranscriptItem {
  const merged = { ...fresh, id: current.id, version: current.version + 1 } as TranscriptItem

  if (fresh.kind !== current.kind) {
    return merged
  }

  if (merged.kind === 'tool' && current.kind === 'tool') {
    // A history tool row has a name and a preview but never a result.
    if (!merged.resultKnown && current.resultKnown) {
      const carried = merged as ToolItem

      carried.resultKnown = true
      carried.result = current.result
      carried.status = current.status
      carried.isError = current.isError
      carried.resultText = current.resultText ?? carried.resultText
      carried.summary = carried.summary ?? current.summary
      carried.inlineDiff = current.inlineDiff ?? carried.inlineDiff
      carried.durationS = current.durationS ?? carried.durationS
      carried.argsText = current.argsText ?? carried.argsText
      carried.outputRisk = current.outputRisk ?? carried.outputRisk
    }

    return merged
  }

  if (merged.kind === 'bot_dm_out' && current.kind === 'bot_dm_out') {
    const carried = merged as BotDmOutItem

    if (carried.dispatch.status === 'unknown') {
      carried.dispatch = current.dispatch
    }

    carried.reply = carried.reply ?? current.reply

    return merged
  }

  if (merged.kind === 'subagent_group' && current.kind === 'subagent_group') {
    const carried = merged as SubagentGroupItem

    carried.rootIds = current.rootIds.length ? current.rootIds : carried.rootIds
    carried.delegationId = carried.delegationId ?? current.delegationId
    carried.completion = carried.completion ?? current.completion

    if (carried.status === 'dispatched' && current.status !== 'dispatched') {
      carried.status = current.status
    }

    return merged
  }

  if (merged.kind === 'assistant' && current.kind === 'assistant') {
    const carried = merged as AssistantItem

    carried.reasoning = carried.reasoning ?? current.reasoning
    carried.reasoningVerbose = carried.reasoningVerbose ?? current.reasoningVerbose
    carried.durationS = carried.durationS ?? current.durationS
    carried.usage = carried.usage ?? current.usage
    // A failed turn is not persisted as a failure; keep the local verdict.
    carried.error = carried.error ?? current.error
    carried.status = current.error ? (current.status ?? carried.status) : carried.status

    return merged
  }

  if (merged.kind === 'user' && current.kind === 'user') {
    const carried = merged as UserItem

    carried.attachments = carried.attachments ?? current.attachments
    carried.pending = false

    return merged
  }

  return merged
}

function rebuild(state: ChatState, list: readonly TranscriptItem[]): ChatState {
  const next: ChatState = {
    ...state,
    items: {},
    order: [],
    byToolId: {},
    byRowId: {},
    byRequestId: {},
    byApprovalId: {},
    byProcessId: {},
    byDelegationId: {},
    turn: { ...state.turn }
  }

  list.forEach((item, index) => {
    const placed = { ...item, seq: index * SEQ_STEP }

    next.items[placed.id] = placed
    next.order.push(placed.id)

    if (placed.rowId !== undefined) {
      next.byRowId[String(placed.rowId)] = placed.id
    }

    const toolKey = toolKeyOf(placed)

    if (toolKey) {
      next.byToolId[toolKey] = placed.id
    }

    if (placed.kind === 'bot_dm_out' && placed.dispatch.processId) {
      next.byProcessId[placed.dispatch.processId] = placed.id
    }

    if (placed.kind === 'subagent_group' && placed.delegationId) {
      next.byDelegationId[placed.delegationId] = placed.id
    }

    if (placed.kind === 'approval' || placed.kind === 'clarify') {
      next.byRequestId[placed.requestId] = placed.id
    }

    if (placed.kind === 'approval' && placed.approvalId) {
      next.byApprovalId[placed.approvalId] = placed.id
    }
  })

  next.turn.nextSeq = list.length * SEQ_STEP
  next.turn.assistantId = next.turn.assistantId && next.items[next.turn.assistantId] ? next.turn.assistantId : undefined

  return next
}

/**
 * Replace the transcript with `freshItems` (a full re-hydration), keeping ids
 * stable, keeping live knowledge history does not carry, and keeping the
 * not-yet-persisted tail plus any open request.
 */
export function reconcile(state: ChatState, freshItems: readonly TranscriptItem[]): ChatState {
  const byRowId = new Map<number, string>()
  const byToolKey = new Map<string, string>()
  const byText = new Map<string, string[]>()

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    if (item.rowId !== undefined && !byRowId.has(item.rowId)) {
      byRowId.set(item.rowId, id)
    }

    const toolKey = toolKeyOf(item)

    if (toolKey && !byToolKey.has(toolKey)) {
      byToolKey.set(toolKey, id)
    }

    const textKey = textKeyOf(item)

    if (normalizedItemText(item)) {
      byText.set(textKey, [...(byText.get(textKey) ?? []), id])
    }
  }

  const used = new Set<string>()
  const merged: TranscriptItem[] = []

  for (const fresh of freshItems) {
    let matchId = fresh.rowId !== undefined ? byRowId.get(fresh.rowId) : undefined

    if (!matchId || used.has(matchId)) {
      const toolKey = toolKeyOf(fresh)

      matchId = toolKey ? byToolKey.get(toolKey) : undefined
    }

    if (!matchId || used.has(matchId)) {
      matchId = byText.get(textKeyOf(fresh))?.find(id => !used.has(id))
    }

    const current = matchId && !used.has(matchId) ? state.items[matchId] : undefined

    if (current) {
      used.add(current.id)
      merged.push(mergeWithLive(fresh, current))

      continue
    }

    merged.push(fresh)
  }

  const lastUsedIndex = state.order.reduce((last, id, index) => (used.has(id) ? index : last), -1)
  const kept: TranscriptItem[] = []

  state.order.forEach((id, index) => {
    const item = state.items[id]

    if (!item || used.has(id)) {
      return
    }

    if (isEphemeral(item) || (item.origin !== 'history' && index > lastUsedIndex)) {
      kept.push(item)
    }
  })

  const next = rebuild(state, [...merged, ...kept])

  next.hydration = 'live'

  return next
}

/**
 * Fold a short tail fetch into the existing transcript: fill the placeholder a
 * foreign `message.start` left behind, join DM replies onto their dispatch, and
 * append rows we had not seen. Nothing live is ever dropped — a tail fetch that
 * races the turn it is describing must not delete the bubble being streamed.
 */
export function reconcileTail(state: ChatState, tailItems: readonly TranscriptItem[]): ChatState {
  const list = state.order.map(id => state.items[id]).filter((item): item is TranscriptItem => Boolean(item))
  const placeholders = list.filter(item => item.kind === 'user' && item.unknownAuthor).map(item => item.id)
  const knownRowIds = new Set(list.map(item => item.rowId).filter((rowId): rowId is number => rowId !== undefined))
  const byId = new Map(list.map(item => [item.id, item]))
  const appended: TranscriptItem[] = []
  let placeholderCursor = 0

  /**
   * The live tail, indexed by text.
   *
   * A turn we sent ourselves exists twice for a moment: as the optimistic
   * bubble and the streamed reply the reducer built (no `rowId`, because
   * nothing persisted them yet), and as the rows the gateway wrote. There is no
   * id in common — `prompt.submit` does not answer with one — so text is the
   * only thing that can pair them, exactly as `reconcile` already does for a
   * full re-hydration. Without it the next `sessions.changed` sweep appends the
   * persisted copies and every sent message shows up twice.
   */
  const liveByText = new Map<string, string[]>()

  for (const item of list) {
    if (item.rowId !== undefined || !normalizedItemText(item)) {
      continue
    }

    const key = textKeyOf(item)

    liveByText.set(key, [...(liveByText.get(key) ?? []), item.id])
  }

  const pairedLive = new Set<string>()
  /**
   * The tail carried an authored row that belonged to a bubble already on
   * screen — our own optimistic submit coming back persisted. It is the only
   * evidence that says a placeholder standing beside it was never anybody
   * else's turn, as opposed to a turn whose row the tail has not reached yet.
   */
  let pairedAuthoredRow = false

  for (const fresh of tailItems) {
    if (fresh.rowId !== undefined && knownRowIds.has(fresh.rowId)) {
      const existingId = state.byRowId[String(fresh.rowId)]
      const current = existingId ? byId.get(existingId) : undefined

      if (current) {
        byId.set(current.id, mergeWithLive(fresh, current))
      }

      continue
    }

    const toolKey = toolKeyOf(fresh)
    const toolMatchId = toolKey ? state.byToolId[toolKey] : undefined
    const toolMatch = toolMatchId ? byId.get(toolMatchId) : undefined

    if (toolMatch) {
      byId.set(toolMatch.id, mergeWithLive(fresh, toolMatch))

      continue
    }

    const liveId = liveByText.get(textKeyOf(fresh))?.find(id => !pairedLive.has(id))
    const liveMatch = liveId ? byId.get(liveId) : undefined

    if (liveMatch) {
      pairedLive.add(liveMatch.id)
      byId.set(liveMatch.id, mergeWithLive(fresh, liveMatch))

      if (isAuthoredRow(fresh)) {
        pairedAuthoredRow = true
      }

      continue
    }

    if (fresh.kind === 'notice' && fresh.noticeKind === 'process_complete' && fresh.completions?.length) {
      const leftover = joinDeliveries(state, byId, fresh)

      if (!leftover) {
        continue
      }

      appended.push(leftover)

      continue
    }

    if (isAuthoredRow(fresh) && placeholderCursor < placeholders.length) {
      const placeholderId = placeholders[placeholderCursor]

      placeholderCursor += 1

      if (placeholderId && byId.has(placeholderId)) {
        byId.set(placeholderId, { ...fresh, id: placeholderId, version: (byId.get(placeholderId)?.version ?? 0) + 1 })

        continue
      }
    }

    appended.push(fresh)
  }

  // Splice new rows in front of the live tail (the bubbles of a turn that is
  // still running) instead of behind it.
  const ordered = state.order.map(id => byId.get(id)).filter((item): item is TranscriptItem => Boolean(item))
  let insertAt = ordered.length

  while (insertAt > 0) {
    const candidate = ordered[insertAt - 1]

    if (!candidate || candidate.origin === 'history' || candidate.rowId !== undefined) {
      break
    }

    insertAt -= 1
  }

  let merged = [...ordered.slice(0, insertAt), ...appended, ...ordered.slice(insertAt)]
  let stillPending = placeholderCursor < placeholders.length

  if (pairedAuthoredRow && placeholderCursor === 0) {
    // The tail described this turn without needing a placeholder, which means
    // the turn was ours all along: the row paired with the optimistic bubble
    // above. An empty placeholder nobody will ever fill is an empty bubble the
    // reader has to explain to themselves, so it goes. A tail that simply has
    // not reached the foreign row yet pairs nothing and leaves it standing.
    const stale = new Set(
      placeholders.filter(id => {
        const item = byId.get(id)

        return item?.kind === 'user' && item.unknownAuthor && !item.text.trim()
      })
    )

    if (stale.size) {
      merged = merged.filter(item => !stale.has(item.id))
      stillPending = stillPending && stale.size < placeholders.length
    }
  }

  const next = rebuild(state, merged)

  next.turn = { ...next.turn, foreignReconcilePending: stillPending ? true : undefined }

  return next
}

/** Attach every delivery block on a notice to the dispatch that spawned it. */
function joinDeliveries(
  state: ChatState,
  byId: Map<string, TranscriptItem>,
  notice: NoticeItem
): NoticeItem | undefined {
  const leftovers = (notice.completions ?? []).filter(block => {
    const dispatchId = state.byProcessId[block.sid]
    const dispatch = dispatchId ? byId.get(dispatchId) : undefined

    if (dispatch?.kind !== 'bot_dm_out') {
      return true
    }

    const outcome = replyFromDeliveryOutput(block.output)

    byId.set(dispatch.id, {
      ...dispatch,
      version: dispatch.version + 1,
      reply: {
        text: outcome.text ?? '',
        ...(notice.ts !== undefined ? { ts: notice.ts } : {}),
        ...(notice.rowId !== undefined ? { rowId: notice.rowId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {})
      },
      dispatch: outcome.error ? { ...dispatch.dispatch, status: 'failed', error: outcome.error } : dispatch.dispatch
    })

    return false
  })

  if (!leftovers.length) {
    return undefined
  }

  return { ...notice, completions: leftovers }
}
