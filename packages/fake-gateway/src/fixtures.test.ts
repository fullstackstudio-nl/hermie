/**
 * The scripted transcript fixtures, over both transports.
 *
 * They exist so three states are reachable in the running app and in its
 * developer gallery without driving a real gateway into them: a cron delivery, a
 * report long enough to need folding, and a run of dispatches to one target that
 * the app rolls up. Each one is only useful if it is shaped EXACTLY like the
 * thing it stands in for, so these tests assert the shape, not just the presence
 * — a fixture that drifts stops standing in for anything.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway, type TranscriptRow } from './server'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }>()

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** One bot's Bot Chat, over the socket. */
async function botChat(profile: string): Promise<{ id: string; rows: TranscriptRow[] }> {
  const sessions = (await call('session.list', { profile })).sessions as Record<string, unknown>[]
  const id = String(sessions[0]?.id)
  const history = await call('session.history', { session_id: id })

  return { id, rows: history.messages as TranscriptRow[] }
}

/** The cron delivery and the long report live in the researcher's chat… */
const researcherChat = () => botChat('researcher')
/** …and the run of dispatches in the writer's, so the two DM fixtures stay apart. */
const writerChat = () => botChat('writer')

const dispatchesTo = (rows: readonly TranscriptRow[], target: string) =>
  rows.filter(row => row.role === 'tool' && row.name === 'message_agent' && row.args?.target === target)

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) {
        continue
      }

      const frame = JSON.parse(line) as Record<string, unknown>
      const id = typeof frame.id === 'number' ? frame.id : null
      const waiter = id === null ? undefined : pending.get(id)

      if (!waiter) {
        continue
      }

      pending.delete(id as number)

      if (frame.error) {
        waiter.reject(new Error(JSON.stringify(frame.error)))
      } else {
        waiter.resolve((frame.result ?? {}) as Record<string, unknown>)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterAll(async () => {
  socket.close()
  pending.clear()
  await gateway.close()
})

describe('the cron delivery row', () => {
  it('is served with the upstream header, character for character', async () => {
    const { rows } = await researcherChat()
    const cron = rows.find(row => row.text?.startsWith('[Cronjob '))

    expect(cron).toBeDefined()
    expect(cron?.text).toContain(
      '[Cronjob "Source scan" output — scheduled job, not the user. Review it, act on ' +
        'anything that needs action, and summarize for the chat.]'
    )
    // The blank line between header and report is part of the wire format.
    expect(cron?.text?.split('\n').slice(0, 2).at(-1)).toBe('')
  })

  it('carries no marker at all, which is the reason a heuristic is needed', async () => {
    const { rows } = await researcherChat()
    const cron = rows.find(row => row.text?.startsWith('[Cronjob '))!

    expect(cron.role).toBe('user')
    expect(cron.display_kind).toBeUndefined()
    expect(cron.display_metadata).toBeUndefined()
  })

  it('names the fixture cron that actually delivers into this chat', async () => {
    const jobs = (await fetch(`${gateway.url}/api/cron/jobs?profile=researcher`).then(r => r.json())) as Record<
      string,
      unknown
    >[]
    const { rows } = await researcherChat()
    const cron = rows.find(row => row.text?.startsWith('[Cronjob '))!

    expect(jobs[0]).toMatchObject({ name: 'Source scan', deliver: 'bot-chat:researcher' })
    expect(cron.text).toContain(`"${String(jobs[0]?.name)}"`)
  })

  /**
   * The same row over REST, in the shape REST actually answers with.
   *
   * `sessions.py` reads `dict(messages_row)`: the body is `content` and the key
   * is `id`. `session.history` is the surface that says `text` and `row_id`. The
   * fake used to answer `text` on both, so the branch `rowsToItems(rows, 'rest')`
   * takes against every real gateway was the one branch nothing here drove.
   */
  it('reaches the REST transcript route as the same row, in the REST shape', async () => {
    const { id } = await researcherChat()
    const body = (await fetch(`${gateway.url}/api/sessions/${encodeURIComponent(id)}/messages`).then(r =>
      r.json()
    )) as { messages: Record<string, unknown>[] }
    const cron = body.messages.find(row => String(row.content ?? '').startsWith('[Cronjob '))

    expect(cron?.id).toBe(5)
    expect(cron?.content).toBeTypeOf('string')
    expect(cron?.text).toBeUndefined()
    expect(cron?.display_kind).toBeUndefined()
  })
})

describe('the long report', () => {
  it('is long enough to need folding', async () => {
    const { rows } = await researcherChat()
    const report = rows.find(row => row.role === 'assistant' && row.text?.startsWith('## Retry semantics'))

    expect(report).toBeDefined()
    expect(report!.text!.split('\n').length).toBeGreaterThan(20)
  })

  it('holds the three structures that make folding awkward', async () => {
    const { rows } = await researcherChat()
    const text = rows.find(row => row.text?.startsWith('## Retry semantics'))!.text!

    // A table with a real body, not just a header.
    expect(text).toContain('| Behaviour | Before | After |')
    expect(text.split('\n').filter(line => line.startsWith('| ')).length).toBeGreaterThan(5)
    // A fenced code block, opened and closed.
    expect(text.match(/^```/gmu)).toHaveLength(2)
    // A list nested two deep.
    expect(text).toMatch(/^ {4}- /mu)
  })
})

describe('the run of dispatches to one target', () => {
  it('sends at least five message_agent calls to the same handle', async () => {
    const { rows } = await writerChat()

    expect(dispatchesTo(rows, '@researcher').length).toBeGreaterThanOrEqual(5)
  })

  it('keeps five of them consecutive, so the roll-up has a run to collapse', async () => {
    const { rows } = await writerChat()
    // A delivery row that joins onto a dispatch is consumed by the projection and
    // draws nothing, so it does not interrupt a run and is dropped here too.
    const drawn = rows.filter(row => !(row.display_kind === 'process_complete' && row.text?.includes('--run-delivery')))
    let longest = 0
    let current = 0

    for (const row of drawn) {
      current = row.role === 'tool' && row.name === 'message_agent' ? current + 1 : 0
      longest = Math.max(longest, current)
    }

    expect(longest).toBeGreaterThanOrEqual(5)
  })

  it('answers some of them and leaves at least one in flight', async () => {
    const { rows } = await writerChat()
    const answered = rows.filter(
      row => row.display_kind === 'process_complete' && row.text?.includes('--run-delivery')
    ).length

    expect(answered).toBeGreaterThanOrEqual(2)
    expect(dispatchesTo(rows, '@researcher').length).toBeGreaterThan(answered)
  })

  it('gives every delivery its own background process id', async () => {
    const { rows } = await writerChat()
    const ids = rows
      .map(row => /Background process (\S+) completed/u.exec(row.text ?? '')?.[1])
      .filter((id): id is string => Boolean(id))

    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('fixture hygiene', () => {
  it('names nobody real: documentation-reserved domains only', async () => {
    const rows = [...(await researcherChat()).rows, ...(await writerChat()).rows]
    const hosts = rows.flatMap(row => Array.from((row.text ?? '').matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gu)))

    for (const [host] of hosts) {
      if (!/\.(?:com|org|net|io|dev|co|uk)$/u.test(host)) {
        // A file name or a package path, not a hostname.
        continue
      }

      expect(host, `${host} is not a documentation-reserved domain`).toMatch(/(?:^|\.)example\.(?:com|org|net)$/u)
    }
  })
})
