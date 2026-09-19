/**
 * The cron surface of the fake gateway, over both transports at once.
 *
 * It exists because the two halves have to agree about one thing and disagree
 * about another, and only a round trip proves it: the same job is `job_id` over
 * the socket and `id` over REST, the REST detail carries the prompt the list
 * row only previews, and a mutation on either half makes `cron.changed` arrive
 * on the socket. A client written against one half alone passes its own tests
 * and then cannot open a routine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }>()
const events: string[] = []

/** One JSON-RPC call over the live socket. */
function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function rest(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } })
  })

  expect(response.ok, `${init?.method ?? 'GET'} ${path} → HTTP ${response.status}`).toBe(true)

  return response.json()
}

/** Wait for one more `cron.changed` than we had when the mutation went out. */
async function waitForChange(before: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.filter(type => type === 'cron.changed').length > before) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error('no cron.changed broadcast arrived')
}

const changes = () => events.filter(type => type === 'cron.changed').length

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0 })
  events.length = 0
  nextId = 0
  socket = new WebSocket(`${gateway.wsUrl}`, ['hermes-gateway-v1'])

  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) {
        continue
      }

      const frame = JSON.parse(line) as Record<string, unknown>
      const id = typeof frame.id === 'number' ? frame.id : null

      if (id !== null && pending.has(id)) {
        const waiter = pending.get(id)!
        pending.delete(id)

        if (frame.error) {
          waiter.reject(new Error(JSON.stringify(frame.error)))
        } else {
          waiter.resolve((frame.result ?? {}) as Record<string, unknown>)
        }

        continue
      }

      if (frame.method === 'event') {
        events.push(String((frame.params as Record<string, unknown>)?.type ?? ''))
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterEach(async () => {
  socket.close()
  pending.clear()
  await gateway.close()
})

describe('cron.manage over the socket', () => {
  it('lists the jobs with the scheduler flag the banner needs', async () => {
    const result = await call('cron.manage', { action: 'list', include_disabled: true })
    const jobs = result.jobs as Record<string, unknown>[]

    expect(result.gateway_running).toBe(true)
    expect(jobs).toHaveLength(3)
    expect(jobs.map(job => job.job_id)).toEqual(['job-heartbeat', 'job-digest', 'job-cleanup'])
    // `_format_job` rows preview the prompt; they never carry the whole thing.
    expect(jobs[0]).toHaveProperty('prompt_preview')
    expect(jobs[0]).not.toHaveProperty('prompt')
  })

  it('covers the three rows the list has to draw', async () => {
    const jobs = (await call('cron.manage', { action: 'list', include_disabled: true })).jobs as Record<
      string,
      unknown
    >[]

    expect(jobs[0]).toMatchObject({ enabled: true, last_status: 'ok' })
    expect(jobs[1]!.last_error).toContain('has no model configured')
    expect(jobs[2]).toMatchObject({ enabled: false, state: 'paused' })
  })

  it('creates a job and broadcasts the change', async () => {
    const before = changes()
    const result = await call('cron.manage', {
      action: 'add',
      name: 'Nightly sweep',
      schedule: 'every 6h',
      prompt: 'Sweep the logs.',
      deliver: 'local'
    })

    expect(result.success).toBe(true)
    expect(result.next_run_at).toBeTypeOf('string')
    await waitForChange(before)

    const jobs = (await call('cron.manage', { action: 'list' })).jobs as Record<string, unknown>[]

    expect(jobs.map(job => job.name)).toContain('Nightly sweep')
  })

  it('pauses and resumes', async () => {
    const paused = (await call('cron.manage', { action: 'pause', name: 'job-heartbeat' })).job as Record<
      string,
      unknown
    >

    expect(paused).toMatchObject({ enabled: false, state: 'paused', next_run_at: null })

    const resumed = (await call('cron.manage', { action: 'resume', name: 'job-heartbeat' })).job as Record<
      string,
      unknown
    >

    expect(resumed).toMatchObject({ enabled: true, state: 'active' })
    expect(resumed.next_run_at).toBeTypeOf('string')
  })

  it('reports a job it does not have rather than inventing one', async () => {
    expect(await call('cron.manage', { action: 'pause', name: 'job-nope' })).toMatchObject({ success: false })
  })
})

describe('the REST half', () => {
  it('answers the detail read with the stored job and its full prompt', async () => {
    const job = (await rest('/api/cron/jobs/job-heartbeat')) as Record<string, unknown>

    expect(job.id).toBe('job-heartbeat')
    expect(job.prompt).toContain('summarize disk and memory')
  })

  it('merges a PUT and recomputes the next run', async () => {
    const before = (await rest('/api/cron/jobs/job-heartbeat')) as Record<string, unknown>
    const updated = (await rest('/api/cron/jobs/job-heartbeat', {
      method: 'PUT',
      body: { updates: { schedule: 'every 15m' } }
    })) as Record<string, unknown>

    expect(updated.schedule).toBe('every 15m')
    // The merge must not drop what the update did not mention.
    expect(updated.prompt).toBe(before.prompt)
    expect(updated.next_run_at).not.toBe(before.next_run_at)
    expect(Date.parse(String(updated.next_run_at))).toBeLessThan(Date.now() + 16 * 60_000)
  })

  it('lists the run sessions newest first', async () => {
    const body = (await rest('/api/cron/jobs/job-heartbeat/runs?limit=20')) as Record<string, unknown>
    const runs = body.runs as Record<string, unknown>[]

    expect(runs).toHaveLength(2)
    expect(Number(runs[0]!.started_at)).toBeGreaterThan(Number(runs[1]!.started_at))
    expect(String(runs[0]!.id)).toMatch(/^cron_job-heartbeat_\d+$/)
  })

  it('serves a run transcript through session.history', async () => {
    const body = (await rest('/api/cron/jobs/job-heartbeat/runs')) as Record<string, unknown>
    const run = (body.runs as Record<string, unknown>[])[0]!
    const history = await call('session.history', { session_id: run.id })

    expect(history.count).toBe(3)
    expect((history.messages as Record<string, unknown>[])[0]!.role).toBe('user')
  })

  it('appends a run on trigger, transcript included', async () => {
    const before = changes()
    const job = (await rest('/api/cron/jobs/job-cleanup/trigger', { method: 'POST' })) as Record<string, unknown>

    expect(job.last_status).toBe('ok')
    await waitForChange(before)

    const runs = ((await rest('/api/cron/jobs/job-cleanup/runs')) as Record<string, unknown>).runs as Record<
      string,
      unknown
    >[]

    expect(runs).toHaveLength(1)

    const history = await call('session.history', { session_id: runs[0]!.id })

    expect(Number(history.count)).toBeGreaterThan(0)
  })

  it('lists the delivery targets the editor offers', async () => {
    const body = (await rest('/api/cron/delivery-targets')) as Record<string, unknown>
    const targets = body.targets as Record<string, unknown>[]

    expect(targets.map(target => target.id)).toEqual(['local', 'bot-chat:researcher'])
  })

  it('deletes, and the socket list agrees', async () => {
    const before = changes()

    expect(await rest('/api/cron/jobs/job-digest', { method: 'DELETE' })).toEqual({ ok: true })
    await waitForChange(before)

    const jobs = (await call('cron.manage', { action: 'list', include_disabled: true })).jobs as Record<
      string,
      unknown
    >[]

    expect(jobs.map(job => job.job_id)).not.toContain('job-digest')
  })

  it('answers 404 for a job it does not have', async () => {
    const response = await fetch(`${gateway.url}/api/cron/jobs/job-nope`)

    expect(response.status).toBe(404)
  })
})
