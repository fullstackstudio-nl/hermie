/**
 * The routine model: one shape for a cron job, whichever surface it arrived on.
 *
 * The gateway has two of them and they do not agree. `cron.manage {action:
 * 'list'}` answers with `_format_job` rows, which key the job as `job_id` and
 * carry a `prompt_preview`; `GET /api/cron/jobs/{id}` answers with the stored
 * job, which keys it as `id` and carries the full `prompt`. Normalising both
 * here is what lets the list and the detail screen read the same fields, and
 * what keeps that difference from leaking into three components.
 */
import type { CronJobRow } from '@hermes/shared/gateway-contract'

import { cronStrings } from './strings'

export type CronStatus = 'ok' | 'failed' | 'paused' | 'pending'

export interface CronJob {
  id: string
  name: string
  schedule: string
  /** The full prompt, present only on a detail read. */
  prompt: string
  promptPreview: string
  deliver: string
  enabled: boolean
  state: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  pausedAt: string | null
  pausedReason: string | null
  repeat: number | null
  skills: string[]
  model: string | null
  /** Set when the job lives in a profile's cron store rather than the default one. */
  profile: string | null
}

export interface CronRun {
  id: string
  startedAt: number | null
  endedAt: number | null
  lastActive: number | null
  status: string | null
  messageCount: number
  preview: string
  title: string
}

export interface CronDeliveryTarget {
  id: string
  name: string
  homeTargetSet: boolean
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const nullableStr = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }

  return null
}

/** Normalise either surface's row. `job_id` wins when both keys are present. */
export function cronJobFromRow(row: CronJobRow | Record<string, unknown>): CronJob {
  const record = row as Record<string, unknown>
  const skills = Array.isArray(record.skills)
    ? record.skills.filter((skill): skill is string => typeof skill === 'string')
    : []

  return {
    id: str(record.job_id) || str(record.id),
    name: str(record.name),
    schedule: str(record.schedule),
    prompt: str(record.prompt),
    promptPreview: str(record.prompt_preview) || str(record.prompt),
    deliver: str(record.deliver) || 'local',
    // A row that says nothing about `enabled` is an enabled row; the scheduler
    // treats a missing flag as on, and showing it as paused would be a lie that
    // survives until the next detail read.
    enabled: record.enabled === undefined || record.enabled === null ? true : record.enabled !== false,
    state: str(record.state),
    nextRunAt: nullableStr(record.next_run_at),
    lastRunAt: nullableStr(record.last_run_at),
    lastStatus: nullableStr(record.last_status),
    lastError:
      nullableStr(record.last_error) ?? nullableStr(record.last_fire_error) ?? nullableStr(record.last_delivery_error),
    pausedAt: nullableStr(record.paused_at),
    pausedReason: nullableStr(record.paused_reason),
    repeat: num(record.repeat),
    skills,
    model: nullableStr(record.model),
    profile: nullableStr(record.profile)
  }
}

/** One `/runs` row. They are ordinary session rows, in `list_sessions_rich` shape. */
export function cronRunFromRow(row: Record<string, unknown>): CronRun {
  return {
    id: str(row.id),
    startedAt: num(row.started_at),
    endedAt: num(row.ended_at),
    lastActive: num(row.last_active),
    status: nullableStr(row.status),
    messageCount: num(row.message_count) ?? 0,
    preview: str(row.preview),
    title: str(row.title)
  }
}

export function deliveryTargetFromRow(row: Record<string, unknown>): CronDeliveryTarget {
  const id = str(row.id) || str(row.name)

  return { id, name: str(row.name) || id, homeTargetSet: row.home_target_set !== false }
}

const FAILED_STATUS = new Set(['error', 'failed', 'failure', 'fail'])
const OK_STATUS = new Set(['ok', 'success', 'succeeded', 'completed', 'done'])

/**
 * The dot next to a routine.
 *
 * Paused beats failed on purpose: a paused routine is not going to retry, so
 * the first thing to say about it is that it is off, not that its last attempt
 * went badly. The error itself is still on the row underneath.
 */
export function cronStatusOf(job: CronJob): CronStatus {
  if (!job.enabled || job.state === 'paused') {
    return 'paused'
  }

  const status = (job.lastStatus ?? '').toLowerCase()

  if (job.lastError || FAILED_STATUS.has(status)) {
    return 'failed'
  }

  if (OK_STATUS.has(status)) {
    return 'ok'
  }

  return 'pending'
}

export function cronStatusLabel(status: CronStatus): string {
  return cronStrings.status[status]
}

// The scheduler stores `last_error` as raw exception text, e.g.
// "RuntimeError: Cron job 'x' has no model configured (job.model=None, …)".
// A row needs the first plain sentence; the detail screen still shows the rest.
const ERROR_PREFIX_RE = /^(?:[A-Za-z_][\w.]*(?:Error|Exception)|Exception):\s*/
const ERROR_MARKER_RE = /^\[[a-z_]+(?::[a-z_]+)?\]\s*/
const ERROR_EMOJI_RE = /^(?:⚠️?|🛑|❌|\u{1F6AB})\s*/u
const ERROR_SUMMARY_MAX = 200

/** Port of the desktop's `lastErrorSummary`, so both clients say the same thing. */
export function lastErrorSummary(lastError: string | null | undefined): string {
  let text = (lastError ?? '').trim()

  // Wrappers nest (marker, then emoji, then exception class); peel until stable.
  for (let previous = ''; previous !== text;) {
    previous = text
    text = text.replace(ERROR_MARKER_RE, '').replace(ERROR_EMOJI_RE, '').replace(ERROR_PREFIX_RE, '').trimStart()
  }

  const sentenceEnd = text.search(/\. |\n/)
  const sentence = (sentenceEnd === -1 ? text : text.slice(0, sentenceEnd + 1)).trim()

  return sentence.length > ERROR_SUMMARY_MAX ? `${sentence.slice(0, ERROR_SUMMARY_MAX - 1).trimEnd()}…` : sentence
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * "in 2h", "5 min ago". Absolute times are avoided on a row: the gateway's
 * timezone is not the phone's, and an absolute time rendered in the phone's
 * zone is wrong in a way nobody notices until a routine fires an hour off.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) {
    return null
  }

  const at = Date.parse(iso)

  if (!Number.isFinite(at)) {
    return null
  }

  const delta = at - now
  const ahead = delta >= 0
  const magnitude = Math.abs(delta)
  const { relative } = cronStrings

  if (magnitude < 45_000) {
    return relative.now
  }

  if (magnitude < HOUR_MS) {
    const minutes = Math.round(magnitude / MINUTE_MS)

    return ahead ? relative.inMinutes(minutes) : relative.minutesAgo(minutes)
  }

  if (magnitude < DAY_MS) {
    const hours = Math.round(magnitude / HOUR_MS)

    return ahead ? relative.inHours(hours) : relative.hoursAgo(hours)
  }

  const days = Math.round(magnitude / DAY_MS)

  return ahead ? relative.inDays(days) : relative.daysAgo(days)
}

/** Epoch seconds or milliseconds from a session row, as one relative phrase. */
export function relativeEpoch(value: number | null, now: number = Date.now()): string | null {
  if (value === null) {
    return null
  }

  const ms = value > 1e12 ? value : value * 1000

  return relativeTime(new Date(ms).toISOString(), now)
}

const DURATION_WORD: Record<string, string> = {
  m: 'minutes',
  h: 'hours',
  d: 'days'
}

/**
 * The schedule, as a line a person reads.
 *
 * Only the forms the builder writes get prettified; anything else is shown
 * exactly as stored. A cron expression nobody can read is still better than a
 * friendly sentence that describes a different schedule.
 */
export function scheduleText(schedule: string): string {
  const raw = schedule.trim()

  if (!raw) {
    return cronStrings.detail.unknown
  }

  const interval = /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(raw)

  if (interval) {
    const unit = DURATION_WORD[interval[2]!.toLowerCase()[0]!] ?? interval[2]!

    return `Every ${interval[1]} ${unit}`
  }

  const once = /^in\s+(.+)$/i.exec(raw)

  if (once) {
    return `Once, in ${once[1]}`
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return `Once, at ${raw}`
  }

  if (/^every\s+/i.test(raw) || /^(weekday|weekend)/i.test(raw)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  }

  return raw
}
