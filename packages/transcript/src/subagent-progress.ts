/**
 * `subagent.*` payload → `Subagent` projection.
 *
 * Ported from `toProgress` / `streamFromPayload` in
 * `apps/desktop/src/store/subagents.ts`. The gateway sends the same payload
 * shape for all six subagent events; the event name only decides which stream
 * lines are derived and whether an unknown status is fatal.
 */
import { type Subagent, type SubagentStatus, type SubagentStreamEntry, SUBAGENT_STREAM_CAP } from './types'

const PREVIEW_MAX = 220
const TOOL_PREVIEW_MAX = 96

export const TERMINAL_SUBAGENT_STATUS: ReadonlySet<SubagentStatus> = new Set(['completed', 'failed', 'interrupted'])

const isStr = (value: unknown): value is string => typeof value === 'string'
const str = (value: unknown): string => (isStr(value) ? value : '')
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isStr) : [])

/**
 * A `subagent.complete` frame is terminal by definition, so an unrecognised (or
 * still-active) status there must read as a failure rather than leave a dead row
 * spinning forever. Live events keep the lenient fallback.
 */
export function asSubagentStatus(value: unknown, terminalEvent = false): SubagentStatus {
  if (value === 'completed' || value === 'failed' || value === 'interrupted') {
    return value
  }

  if (value === 'timeout' || value === 'error') {
    return 'failed'
  }

  if (value === 'cancelled' || value === 'canceled') {
    return 'interrupted'
  }

  if (terminalEvent) {
    return 'failed'
  }

  return value === 'queued' ? 'queued' : 'running'
}

const compact = (text: string, max = PREVIEW_MAX): string => {
  const line = text.replace(/\s+/gu, ' ').trim()

  if (!line) {
    return ''
  }

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const capitalize = (word: string): string => (word ? word[0]!.toUpperCase() + word.slice(1) : word)
const toolLabel = (name: string): string => name.split('_').filter(Boolean).map(capitalize).join(' ') || name

const formatTool = (name: string, preview = ''): string => {
  const snippet = compact(preview, TOOL_PREVIEW_MAX)

  return snippet ? `${toolLabel(name)}("${snippet}")` : toolLabel(name)
}

interface TailEntry {
  isError?: boolean
  preview?: string
  tool?: string
}

const asTail = (value: unknown): TailEntry[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map(item => ({
          isError: item.is_error === true,
          preview: str(item.preview) || undefined,
          tool: str(item.tool) || undefined
        }))
    : []

/** Identity, with the same fallback the desktop uses when the emitter omits an id. */
export const subagentIdOf = (payload: Record<string, unknown>): string =>
  str(payload.subagent_id) || `${str(payload.parent_id) || 'root'}:${num(payload.task_index) ?? 0}:${str(payload.goal)}`

const appendStream = (stream: SubagentStreamEntry[], entry: SubagentStreamEntry): SubagentStreamEntry[] => {
  const last = stream.at(-1)

  if (last?.kind === entry.kind && last.text === entry.text && last.isError === entry.isError) {
    return stream
  }

  return [...stream, entry].slice(-SUBAGENT_STREAM_CAP)
}

/**
 * The backend sends no summary on a hard child timeout (only a preview and a
 * duration), so synthesize one rather than render a bare failure.
 */
const timeoutSummary = (payload: Record<string, unknown>): string => {
  const seconds = num(payload.duration_seconds)

  return str(payload.status) === 'timeout' ? `Timed out after ${seconds ?? '?'}s` : ''
}

function streamFromPayload(
  payload: Record<string, unknown>,
  status: SubagentStatus,
  eventType: string,
  at: number
): SubagentStreamEntry[] {
  const out: SubagentStreamEntry[] = []
  const tool = str(payload.tool_name)
  const preview = str(payload.tool_preview) || str(payload.text)
  const text = compact(str(payload.text) || preview)

  for (const tail of asTail(payload.output_tail)) {
    const line = tail.tool ? formatTool(tail.tool, tail.preview ?? '') : compact(tail.preview ?? '')

    if (line) {
      out.push({ at, kind: tail.tool ? 'tool' : 'progress', text: line, ...(tail.isError ? { isError: true } : {}) })
    }
  }

  if (tool) {
    out.push({ at, kind: 'tool', text: formatTool(tool, preview), ...(payload.error ? { isError: true } : {}) })
  }

  if (eventType === 'subagent.progress' && text) {
    out.push({ at, kind: 'progress', text, ...(payload.error ? { isError: true } : {}) })
  }

  if (eventType === 'subagent.thinking' && text) {
    out.push({ at, kind: 'thinking', text })
  }

  const summary = compact(str(payload.summary) || str(payload.text) || timeoutSummary(payload))

  if (TERMINAL_SUBAGENT_STATUS.has(status) && summary) {
    out.push({ at, kind: 'summary', text: summary, ...(status === 'failed' ? { isError: true } : {}) })
  }

  return out
}

export function toSubagent(
  payload: Record<string, unknown>,
  prev: Subagent | undefined,
  eventType: string,
  at: number
): Subagent {
  const status = asSubagentStatus(payload.status, eventType === 'subagent.complete')
  const tool = str(payload.tool_name)
  const stream = streamFromPayload(payload, status, eventType, at).reduce(appendStream, prev?.stream ?? [])
  const filesRead = strList(payload.files_read)
  const filesWritten = strList(payload.files_written)
  const childSessionId = str(payload.child_session_id) || prev?.childSessionId
  const delegationId = str(payload.delegation_id) || prev?.delegationId
  const model = str(payload.model) || prev?.model
  const depth = num(payload.depth) ?? prev?.depth
  const durationSeconds = num(payload.duration_seconds) ?? prev?.durationSeconds
  const toolCount = num(payload.tool_count) ?? prev?.toolCount
  const inputTokens = num(payload.input_tokens) ?? prev?.inputTokens
  const outputTokens = num(payload.output_tokens) ?? prev?.outputTokens
  const summary = str(payload.summary) || timeoutSummary(payload) || prev?.summary
  const currentTool = TERMINAL_SUBAGENT_STATUS.has(status) ? undefined : tool || prev?.currentTool

  return {
    id: prev?.id ?? subagentIdOf(payload),
    parentId: str(payload.parent_id) || prev?.parentId || null,
    ...(delegationId ? { delegationId } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    goal: str(payload.goal) || prev?.goal || 'Subagent',
    ...(model ? { model } : {}),
    ...(depth !== undefined ? { depth } : {}),
    taskIndex: num(payload.task_index) ?? prev?.taskIndex ?? 0,
    taskCount: num(payload.task_count) ?? prev?.taskCount ?? 1,
    status,
    startedAt: prev?.startedAt ?? at,
    updatedAt: at,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    filesRead: filesRead.length ? filesRead : (prev?.filesRead ?? []),
    filesWritten: filesWritten.length ? filesWritten : (prev?.filesWritten ?? []),
    stream,
    ...(summary ? { summary } : {}),
    ...(currentTool ? { currentTool } : {}),
    ...(prev?.acceptingSteer !== undefined ? { acceptingSteer: prev.acceptingSteer } : {})
  }
}
