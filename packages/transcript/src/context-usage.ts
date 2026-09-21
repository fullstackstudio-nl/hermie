/**
 * How full a session's context window is, from whatever the gateway said.
 *
 * The gateway reports usage in three places and they are the same numbers: the
 * `session.usage` tick while a turn runs, the `usage` on `message.complete` when
 * it ends, and the `usage` inside `SessionLiveInfo` that a resume answers with.
 * The reducer folds all three into `ChatState.usage`, so this reads one field and
 * the surfaces that draw it do not have to know which event last touched it.
 *
 * ## Two numbers, and no guessing at the second one
 *
 * A ring needs a numerator and a denominator. `context_used` is the first and
 * `context_max` is the second, and **without `context_max` there is no ring at
 * all** — not a default, not a table of model context sizes keyed off
 * `usage.model`. A table like that is a promise about somebody else's product:
 * it is right until a provider ships a longer window or a gateway is configured
 * to reserve part of one, and when it is wrong it is wrong in the direction that
 * tells a reader they have room they do not have. `null` is the honest answer,
 * and the caller hides the control.
 *
 * ## The percentage is computed, not read
 *
 * `Usage` also carries `context_percent`, and it is deliberately ignored. The
 * contract does not say whether it is a fraction or a hundredth, and the two are
 * indistinguishable for any session under one per cent — which is every session
 * for the first few turns, i.e. exactly when a wrong reading would be least
 * likely to be noticed. Dividing the two numbers we already trust cannot
 * disagree with the bar drawn beside it.
 */
import type { SessionLiveInfo, Usage } from '@hermes/shared/gateway-events'

export interface ContextUsage {
  /** Tokens in the window right now, as the gateway counted them. */
  used: number
  /** The window's size. Always positive; the whole thing is `null` without it. */
  limit: number
  /**
   * `used / limit`, clamped to `0…1`.
   *
   * Clamped because a session can genuinely be over: the gateway counts what it
   * sent, and a compaction that has not happened yet leaves the figure above the
   * window for a moment. A ring drawn past full is a drawing bug; `used` itself
   * is left truthful, so the numbers under the ring still say what happened.
   */
  fraction: number
  /** `fraction` as whole per cent, for the label beside the ring. */
  percent: number
  /** The gateway flagged the count as approximate rather than exact. */
  estimated: boolean
  /** How the gateway arrived at the window size, when it said. */
  source?: string
}

/** A finite, non-negative number, or `undefined`. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Read a usage record, or answer `null` when it cannot say how full the window
 * is.
 *
 * `null` means "there is nothing to draw" and never "draw a zero": a chat whose
 * gateway does not report context is a chat with no ring, and a ring sitting
 * empty would say the session is fresh.
 */
export function contextUsageOf(usage: Usage | null | undefined): ContextUsage | null {
  if (!usage) {
    return null
  }

  const limit = positive(usage.context_max)
  const used = positive(usage.context_used)

  if (!limit || used === undefined) {
    return null
  }

  const fraction = Math.min(1, used / limit)
  const source = typeof usage.context_source === 'string' ? usage.context_source.trim() : ''

  return {
    estimated: usage.context_estimated === true,
    fraction,
    limit,
    percent: Math.round(fraction * 100),
    used,
    ...(source ? { source } : {})
  }
}

/**
 * The same reading, from a live-info snapshot.
 *
 * A resume answers with `info.usage` before any `session.usage` tick has
 * arrived, so this is what fills the ring on a cold open of a chat that is not
 * running a turn.
 */
export function contextUsageOfInfo(info: SessionLiveInfo | null | undefined): ContextUsage | null {
  return contextUsageOf(info?.usage ?? null)
}

/**
 * One chat's reading, from the two places the reducer keeps one.
 *
 * `state.usage` is whatever the last `session.usage` tick or `message.complete`
 * carried, so it is by construction the most recent thing the gateway said — no
 * merging and no comparing is needed, and none is done. `info.usage` is only the
 * fallback for a chat that has resumed and not yet run a turn, which is the cold
 * open every reader sees first.
 *
 * Deliberately NOT a max of the two. Usage goes DOWN when the session compacts,
 * and a reading that only ever grew would show a window still full minutes after
 * the gateway emptied it.
 */
export function chatContextUsage(
  state: { usage?: Usage; info?: SessionLiveInfo } | null | undefined
): ContextUsage | null {
  return contextUsageOf(state?.usage) ?? contextUsageOfInfo(state?.info)
}
