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

    // `scheduled`, which is the word `cron/jobs.py::_job_state` produces. There
    // is no `active` state on a real gateway.
    expect(resumed).toMatchObject({ enabled: true, state: 'scheduled' })
    expect(resumed.next_run_at).toBeTypeOf('string')
  })

  it('reports a job it does not have rather than inventing one', async () => {
    expect(await call('cron.manage', { action: 'pause', name: 'job-nope' })).toMatchObject({ success: false })
  })
})

/**
 * The half of the contract that made a real cron invisible in Hermie.
 *
 * `cron.manage` is a `_scoped_rpc`: it binds HERMES_HOME to its `profile` param
 * and reads ONE profile's `cron/jobs.json`. The REST list is the only surface
 * that walks every profile, and the only one that says which store a row came
 * out of. A client that lists over the socket therefore cannot see a cron that
 * belongs to a bot, and cannot mutate one if it somehow learned the id.
 */
describe('profile scope', () => {
  it('hides a profile-owned cron from an unscoped socket list', async () => {
    const jobs = (await call('cron.manage', { action: 'list', include_disabled: true })).jobs as Record<
      string,
      unknown
    >[]

    expect(jobs.map(job => job.job_id)).not.toContain('job-inbox-scan')
    // Not a filter on the row: the rows it does answer carry no owner at all.
    expect(jobs[0]).not.toHaveProperty('profile')
  })

  it("answers that profile's store when the socket call is scoped", async () => {
    const result = await call('cron.manage', { action: 'list', include_disabled: true, profile: 'researcher' })
    const jobs = result.jobs as Record<string, unknown>[]

    expect(result.scoped).toBe('researcher')
    expect(jobs.map(job => job.job_id)).toEqual(['job-inbox-scan'])
  })

  it('lists every profile over REST, each row tagged with its own', async () => {
    const rows = (await rest('/api/cron/jobs')) as Record<string, unknown>[]
    const owners = new Map(rows.map(row => [row.id, row.profile]))

    expect(owners.get('job-inbox-scan')).toBe('researcher')
    expect(owners.get('job-heartbeat')).toBe('default')
    expect(rows).toHaveLength(4)
  })

  it('narrows the REST list to one profile when asked', async () => {
    const rows = (await rest('/api/cron/jobs?profile=researcher')) as Record<string, unknown>[]

    expect(rows.map(row => row.id)).toEqual(['job-inbox-scan'])
  })

  it("refuses to mutate a profile-owned cron from the launch profile's scope", async () => {
    expect(await call('cron.manage', { action: 'pause', name: 'job-inbox-scan' })).toMatchObject({ success: false })

    const paused = await call('cron.manage', { action: 'pause', name: 'job-inbox-scan', profile: 'researcher' })

    expect(paused.success).toBe(true)
    expect(paused.job).toMatchObject({ enabled: false, state: 'paused' })
  })

  it('creates into the scope it was given, not into the launch profile', async () => {
    await call('cron.manage', {
      action: 'add',
      name: 'Scoped sweep',
      schedule: 'every 6h',
      prompt: 'Sweep.',
      deliver: 'local',
      profile: 'writer'
    })

    const rows = (await rest('/api/cron/jobs')) as Record<string, unknown>[]
    const created = rows.find(row => row.name === 'Scoped sweep')

    expect(created?.profile).toBe('writer')

    const unscoped = (await call('cron.manage', { action: 'list', include_disabled: true })).jobs as Record<
      string,
      unknown
    >[]

    expect(unscoped.map(job => job.name)).not.toContain('Scoped sweep')
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
