/**
 * Read-time views over `ChatState`.
 *
 * Verbosity and the bot-to-bot toggle live here and nowhere else: the reducer
 * always keeps the full truth, so flipping a toggle never loses history and
 * never needs a re-hydration.
 *
 * A demoted item is never removed. Hiding a DM would make the bot's own reply
 * unexplainable, so `showBotToBot: false` collapses DM traffic to a one-line
 * chip instead.
 */
import { type ChatState, type Subagent, type StatusItem, type TranscriptItem, type Verbosity } from './types'

export type Presentation = 'full' | 'collapsed' | 'chip' | 'hidden-placeholder'

export interface VisibleItem {
  item: TranscriptItem
  presentation: Presentation
}

export interface VisibilityOptions {
  level: Verbosity
  showBotToBot: boolean
  showThinking: boolean
}

/**
 * Cheap change key for memoization: every mutation bumps an item's `version`,
 * so a changed sum means a changed transcript. Callers are expected to memoize
 * `visibleItems` on `(itemsVersion(state), options)` — this module does not
 * cache, so it stays free of hidden state.
 */
export function itemsVersion(state: ChatState): number {
  let sum = state.order.length

  for (const id of state.order) {
    sum += state.items[id]?.version ?? 0
  }

  return sum
}

const isRunningTool = (item: TranscriptItem): boolean =>
  item.kind === 'tool' && (item.status === 'running' || item.status === 'generating')

export function visibleItems(state: ChatState, options: VisibilityOptions): VisibleItem[] {
  const { level, showBotToBot, showThinking } = options
  const out: VisibleItem[] = []

  let latestStatusId: string | undefined
  let lastRunningToolId: string | undefined

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    if (item.kind === 'status') {
      latestStatusId = id
    }

    if (isRunningTool(item)) {
      lastRunningToolId = id
    }
  }

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    switch (item.kind) {
      case 'approval':
      case 'clarify':
        // A question for the user is never filtered away.
        out.push({ item, presentation: 'full' })
        break

      case 'user':
        if (item.unknownAuthor && !item.text.trim()) {
          out.push({ item, presentation: 'hidden-placeholder' })
          break
        }

        out.push({ item, presentation: 'full' })
        break

      case 'bot_dm_in':
        out.push({ item, presentation: showBotToBot ? 'full' : 'chip' })
        break

      case 'bot_dm_out':
        out.push({
          item,
          presentation: !showBotToBot || level === 'quiet' ? 'chip' : level === 'verbose' ? 'full' : 'collapsed'
        })
        break

      case 'subagent_group':
        out.push({
          item,
          presentation: !showBotToBot || level === 'quiet' ? 'chip' : level === 'verbose' ? 'full' : 'collapsed'
        })
        break

      case 'assistant': {
        const shown = showThinking ? item : { ...item, reasoning: undefined, reasoningVerbose: undefined }
        const empty = !item.text.trim() && !item.error

        if (empty && (!showThinking || !item.reasoning?.trim() || level === 'quiet')) {
          break
        }

        if (item.error) {
          // An error card is always visible, at every level.
          out.push({ item: shown, presentation: 'full' })
          break
        }

        out.push({ item: shown, presentation: empty ? 'collapsed' : 'full' })
        break
      }

      case 'tool':
        if (level === 'quiet') {
          if (id === lastRunningToolId) {
            // One "working" row stands in for the whole tool stream.
            out.push({ item, presentation: 'hidden-placeholder' })
          }

          break
        }

        out.push({ item, presentation: level === 'verbose' ? 'full' : 'collapsed' })
        break

      case 'status':
        if (level === 'verbose') {
          out.push({ item, presentation: 'full' })
          break
        }

        if (id !== latestStatusId) {
          break
        }

        if (level === 'quiet' && !state.turn.active) {
          break
        }

        out.push({ item, presentation: 'chip' })
        break

      case 'notice':
        if (item.noticeKind === 'error') {
          out.push({ item, presentation: 'full' })
          break
        }

        if (level === 'quiet') {
          if (item.noticeKind === 'reclaimed') {
            out.push({ item, presentation: 'chip' })
          }

          break
        }

        out.push({ item, presentation: level === 'verbose' ? 'full' : 'collapsed' })
        break
    }
  }

  return out
}

/** Every unanswered question, oldest first — the bottom sheets read this. */
export function openRequests(state: ChatState): TranscriptItem[] {
  return state.order
    .map(id => state.items[id])
    .filter(
      (item): item is TranscriptItem =>
        Boolean(item) && (item!.kind === 'approval' || item!.kind === 'clarify') && item!.state === 'open'
    )
}

export function runningSubagents(state: ChatState): Subagent[] {
  return Object.values(state.subagents).filter(child => child.status === 'running' || child.status === 'queued')
}

export interface SubagentNode extends Subagent {
  children: SubagentNode[]
}

/** Parent/child tree of this chat's subagents, ported from `buildSubagentTree`. */
export function subagentTree(state: ChatState): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>()

  for (const child of Object.values(state.subagents)) {
    nodes.set(child.id, { ...child, children: [] })
  }

  const roots: SubagentNode[] = []

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined

    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sort = (a: SubagentNode, b: SubagentNode) =>
    a.startedAt - b.startedAt || a.taskIndex - b.taskIndex || a.goal.localeCompare(b.goal)

  const walk = (node: SubagentNode) => {
    node.children.sort(sort)
    node.children.forEach(walk)
  }

  roots.sort(sort)
  roots.forEach(walk)

  return roots
}

export function latestStatus(state: ChatState): StatusItem | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]
    const item = id ? state.items[id] : undefined

    if (item?.kind === 'status') {
      return item
    }
  }

  return undefined
}

/** Is anything still running for this chat — the turn, a tool, or a child? */
export function isBusy(state: ChatState): boolean {
  if (state.turn.active || state.compacting) {
    return true
  }

  if (runningSubagents(state).length) {
    return true
  }

  return state.order.some(id => {
    const item = state.items[id]

    return Boolean(item && isRunningTool(item))
  })
}
