/**
 * Consecutive outgoing bot-to-bot lines, rolled up.
 *
 * §6.6: a collapsed outgoing DM is a LINE, not a bubble and not a pill, and more
 * than three in a row roll up into `5 messages to @writer · 4 replies`, which
 * expands in place.
 *
 * This is the whole rule as one pure function over the visible list, for two
 * reasons. A row cannot see its neighbours, so it cannot know it is the fourth of
 * a run. And "consecutive" is a question about what is VISIBLE: a hidden
 * placeholder between two dispatches does not break the run, but a tool row does
 * — the reader can see the tool row, so the dispatches are not adjacent on screen.
 */
import type { BotDmOutItem, TranscriptItem, VisibleItem } from './types'

/** More than this many in a row roll up. Three is the mockup's number. */
export const ROLLUP_THRESHOLD = 3

export interface DmRun {
  /** The id the roll-up's own disclosure state is keyed on: the first line's. */
  id: string
  items: BotDmOutItem[]
  /** The single target, or undefined when the run went to more than one. */
  handle?: string
  replies: number
}

/**
 * How one outgoing DM row is drawn: on its own, or swallowed by a roll-up.
 *
 * `rollupHead` carries the run so the row that renders it does not have to walk
 * the list a second time; `rollupMember` rows render nothing while the roll-up is
 * collapsed, and render their own line once it is expanded.
 */
export type DmRowRole = { role: 'line' } | { role: 'rollupHead'; run: DmRun } | { role: 'rollupMember'; runId: string }

export function isDmOut(item: TranscriptItem): item is BotDmOutItem {
  return item.kind === 'bot_dm_out'
}

/**
 * A reply that actually came back.
 *
 * `reply` with an `error` on it is a failure, not an answer — counting it would
 * make `5 messages · 5 replies` out of five failures.
 */
export function hasReply(item: BotDmOutItem): boolean {
  return Boolean(item.reply && !item.reply.error)
}

/** Index every outgoing DM row in the visible list by how it should be drawn. */
export function rollupDmRuns(entries: readonly VisibleItem[]): Record<string, DmRowRole> {
  const roles: Record<string, DmRowRole> = {}
  let run: BotDmOutItem[] = []

  const flush = () => {
    if (run.length === 0) {
      return
    }

    if (run.length <= ROLLUP_THRESHOLD) {
      for (const item of run) {
        roles[item.id] = { role: 'line' }
      }

      run = []

      return
    }

    const head = run[0]

    if (!head) {
      run = []

      return
    }

    const handles = new Set(run.map(item => item.targetHandle))

    roles[head.id] = {
      role: 'rollupHead',
      run: {
        id: head.id,
        items: [...run],
        ...(handles.size === 1 ? { handle: head.targetHandle } : {}),
        replies: run.filter(hasReply).length
      }
    }

    for (const item of run.slice(1)) {
      roles[item.id] = { role: 'rollupMember', runId: head.id }
    }

    run = []
  }

  for (const entry of entries) {
    if (entry.presentation === 'hidden-placeholder') {
      continue
    }

    if (isDmOut(entry.item)) {
      run.push(entry.item)

      continue
    }

    flush()
  }

  flush()

  return roles
}
