/**
 * What every REST route ANSWERS WITH, pinned against the real gateway's handler.
 *
 * The crons list could not load from any gateway at all for two releases, and
 * the reason nobody caught it is written into this file's existence: every test
 * that touched that route drove the fake, the fake agreed with the app, and
 * neither had been compared with `hermes serve`. A fake that lies is worse than
 * no fake — it turns a green suite into evidence for the wrong thing.
 *
 * So each case below names the upstream handler it was read from. Cite the file
 * when you change one, and change the FAKE to match upstream rather than the
 * other way round. Where the two genuinely differ and the app copes, say so in
 * the test rather than leaving the reader to wonder whether anybody looked.
 *
 * Upstream is NousResearch/hermes-agent, `hermes_cli/web_routers/`, at the pin
 * in `packages/hermes-shared/upstream.json`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway, type FakeGateway } from './server'

let gateway: FakeGateway

const get = async (path: string): Promise<unknown> => fetch(`${gateway.url}${path}`).then(response => response.json())

const keysOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>).sort()

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
})

afterAll(async () => {
  await gateway.close()
})

describe('GET /api/status — status.py::_status_payload', () => {
  it('answers an object with the three keys the probe insists on', async () => {
    const body = (await get('/api/status')) as Record<string, unknown>

    expect(Array.isArray(body)).toBe(false)
    expect(typeof body.auth_required).toBe('boolean')
    expect(Array.isArray(body.auth_flows)).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  /**
   * `status.py` puts the topology rows here, not a list of names. Nothing in the
   * app reads them — which is exactly how the fake got away with `string[]` for
   * three rounds, and exactly why it is worth holding still now.
   */
  it('reports profiles as rows, not as names', async () => {
    const body = (await get('/api/status')) as { profiles: Record<string, unknown>[] }

    expect(body.profiles.length).toBeGreaterThan(0)
    expect(typeof body.profiles[0]?.name).toBe('string')
    expect(body.profiles.every(profile => typeof profile === 'object')).toBe(true)
  })
})

describe('GET /api/auth/me — dashboard_auth/routes.py', () => {
  it('answers exactly the six keys the client maps', async () => {
    expect(keysOf(await get('/api/auth/me'))).toEqual([
      'display_name',
      'email',
      'expires_at',
      'org_id',
      'provider',
      'user_id'
    ])
  })
})

describe('GET /api/profiles — profiles.py::_list_profiles', () => {
  it('wraps the list in `profiles`', async () => {
    const body = (await get('/api/profiles')) as Record<string, unknown>

    expect(Array.isArray(body)).toBe(false)
    expect(Array.isArray(body.profiles)).toBe(true)
  })
})

describe('GET /api/cron/jobs — cron.py::_list_cron_jobs_sync', () => {
  /**
   * The one that cost a release. `_list_cron_jobs_sync` builds a plain list and
   * returns it; FastAPI serialises that as a top-level JSON array. There is no
   * `{"jobs": …}` envelope anywhere in the Python gateway, which is why a
   * transport that demanded an object made the list unreachable everywhere.
   */
  it('answers a BARE ARRAY, with no envelope around it', async () => {
    const body = await get('/api/cron/jobs?profile=all')

    expect(Array.isArray(body)).toBe(true)
    expect((body as unknown[]).length).toBeGreaterThan(0)
  })

  it('annotates every row with the store it came from — `_annotate_cron_job`', async () => {
    const rows = (await get('/api/cron/jobs?profile=all')) as Record<string, unknown>[]

    for (const row of rows) {
      expect(typeof row.profile).toBe('string')
      expect(typeof row.profile_name).toBe('string')
      expect(typeof row.is_default_profile).toBe('boolean')
    }
  })

  /**
   * `_job_state` produces `scheduled`, `paused`, `completed` or `error`. The
   * fake used to say `active`, a word no gateway has ever sent.
   */
  it('uses the state vocabulary the store actually writes', async () => {
    const rows = (await get('/api/cron/jobs?profile=all')) as Record<string, unknown>[]

    for (const row of rows) {
      expect(['scheduled', 'paused', 'completed', 'error']).toContain(row.state)
    }
  })
})

describe('GET /api/cron/jobs/{id} — cron.py::_get_cron_job_sync', () => {
  it('answers the bare job, with no `{job: …}` wrapper', async () => {
    const body = (await get('/api/cron/jobs/job-heartbeat')) as Record<string, unknown>

    expect(body.id).toBe('job-heartbeat')
    expect(body.job).toBeUndefined()
    expect(typeof body.prompt).toBe('string')
  })

  /**
   * `get_job` matches on the ID alone; only `/trigger` goes through
   * `resolve_job_ref`, which is the single place a name may stand in for one.
   * The fake used to accept a name everywhere, so a client could be written
   * against a route that 404s on a real gateway.
   */
  it('404s for a NAME where upstream would, and takes one on trigger', async () => {
    const byName = await fetch(`${gateway.url}/api/cron/jobs/${encodeURIComponent('VM heartbeat')}`)

    expect(byName.status).toBe(404)

    const triggered = await fetch(`${gateway.url}/api/cron/jobs/${encodeURIComponent('VM heartbeat')}/trigger`, {
      method: 'POST'
    })

    expect(triggered.status).toBe(200)
  })
})

describe('GET /api/cron/jobs/{id}/runs — cron.py::_list_cron_job_runs_sync', () => {
  it('wraps the rows in `runs` and echoes the requested, clamped limit', async () => {
    const body = (await get('/api/cron/jobs/job-heartbeat/runs?limit=20')) as Record<string, unknown>

    expect(Array.isArray(body.runs)).toBe(true)
    expect(body.limit).toBe(20)
  })

  /**
   * A run row is `dict(sqlite_row)` over the sessions table, and that table has
   * NO status column: the outcome is `end_reason`. The fake invented `status`,
   * which meant this app's run history read "ok" against this server whatever
   * the run did — and would have read "ok" against a real gateway for every run
   * ever, because the key it was looking for is never sent.
   */
  it('carries `end_reason`, never a `status` the sessions table does not have', async () => {
    const body = (await get('/api/cron/jobs/job-heartbeat/runs')) as { runs: Record<string, unknown>[] }

    expect(body.runs.length).toBeGreaterThan(0)

    for (const run of body.runs) {
      expect(run.status).toBeUndefined()
      expect(typeof run.end_reason).toBe('string')
      expect(run.source).toBe('cron')
      expect(typeof run.profile).toBe('string')
    }

    // …and not every run says the same word, or nothing here would notice which
    // key was being read.
    expect(new Set(body.runs.map(run => run.end_reason)).size).toBeGreaterThan(1)
  })
})

describe('GET /api/cron/delivery-targets — cron.py + scheduler_delivery.py', () => {
  it('wraps the rows and names them the way the delivery module does', async () => {
    const body = (await get('/api/cron/delivery-targets')) as { targets: Record<string, unknown>[] }

    expect(body.targets[0]).toEqual({
      id: 'local',
      name: 'Local (save only)',
      home_target_set: true,
      home_env_var: null
    })
    expect(body.targets[1]?.name).toBe('Bot Chat (researcher)')
  })
})

describe('DELETE /api/cron/jobs/{id} — cron.py::_delete_cron_job_sync', () => {
  it('answers `{ok: true}` and nothing else', async () => {
    const body = await fetch(`${gateway.url}/api/cron/jobs/job-cleanup`, { method: 'DELETE' }).then(r => r.json())

    expect(body).toEqual({ ok: true })
  })
})

describe('GET /api/sessions/{id}/messages — sessions.py::_get_session_messages', () => {
  const chat = async (): Promise<string> => {
    const jobs = (await get('/api/cron/jobs?profile=researcher')) as Record<string, unknown>[]

    expect(jobs.length).toBeGreaterThan(0)

    // Any stored session will do; the cron run sessions are the ones with a
    // predictable id.
    const runs = (await get(`/api/cron/jobs/job-heartbeat/runs`)) as { runs: Record<string, unknown>[] }

    return String(runs.runs[0]?.id)
  }

  it('names the session it read and pages with `pagination`', async () => {
    const body = (await get(`/api/sessions/${encodeURIComponent(await chat())}/messages?limit=50`)) as Record<
      string,
      unknown
    >

    expect(keysOf(body)).toEqual(['messages', 'pagination', 'profile', 'session_id'])
    expect(keysOf(body.pagination)).toEqual(['limit', 'offset', 'order', 'returned'])
    // `count` is what the fake used to send. Upstream has never sent it, and
    // nothing on either side ever read it.
    expect(body.count).toBeUndefined()
  })

  /**
   * The row shape a real gateway ALWAYS takes and the fake never used to.
   * `sessions.py` reads `dict(messages_row)`, so the body is `content` and the
   * key is `id`; `text` and `row_id` belong to the socket's `session.history`.
   */
  it('answers rows keyed as the messages table keys them', async () => {
    const body = (await get(`/api/sessions/${encodeURIComponent(await chat())}/messages`)) as {
      messages: Record<string, unknown>[]
    }

    expect(body.messages.length).toBeGreaterThan(0)

    for (const row of body.messages) {
      expect(typeof row.role).toBe('string')
      expect(typeof row.content).toBe('string')
      expect(row.text).toBeUndefined()
      expect(row.row_id).toBeUndefined()
    }
  })
})

/**
 * The one RPC in this file, and it earns its socket.
 *
 * `session.active_list` is where the fake lied in the most expensive way
 * available: it FILTERED ON `profile`, upstream does not, and so every test that
 * drove it agreed with an app that was calling it once per bot and marking the
 * bot busy if any row came back. One bot working painted the working bead on
 * every row in the chat list, and nothing here could see it.
 *
 * Upstream is `tui_gateway/methods_session.py`, `session.active_list`: a plain
 * `@method` over the process's live sessions. It takes `ProfileParams` and reads
 * only `current_session_id` from them. The rows come from
 * `server.py::_session_live_item`, whose contract is
 * `contracts/sessions.py::SessionActiveItem`.
 */
describe('session.active_list over the socket — methods_session.py::session.active_list', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const activeRows = async (params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> =>
    ((await call('session.active_list', params)).sessions ?? []) as Record<string, unknown>[]

  beforeAll(async () => {
    // Slow the stream right down: every assertion below needs the session to
    // still be running when it reads the list.
    live = await startFakeGateway({ port: 0, streamDelayMs: 400 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter) {
          pending.delete(id as number)
          waiter((frame.result ?? {}) as Record<string, unknown>)
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
    await live.close()
  })

  /** The researcher's stored session id, and a turn running on it. */
  const busyResearcher = async (): Promise<string> => {
    const profiles = (await call('profiles.list', { include_sessions: true })).profiles as Record<string, unknown>[]
    const researcher = profiles.find(row => row.name === 'researcher')
    const stored = String((researcher?.canonical_session as Record<string, unknown> | undefined)?.id ?? '')

    expect(stored).not.toBe('')

    await call('session.resume', { session_id: stored })
    await call('prompt.submit', { session_id: stored, text: 'Take your time.' })

    return stored
  }

  it('answers with the ten fields `SessionActiveItem` declares, and no others', async () => {
    await busyResearcher()

    const rows = await activeRows()

    expect(rows.length).toBeGreaterThan(0)
    expect(keysOf(rows[0])).toEqual([
      'current',
      'id',
      'last_active',
      'message_count',
      'model',
      'preview',
      'session_key',
      'started_at',
      'status',
      'title'
    ])
  })

  /**
   * The field the app has to attribute a row with. `_session_live_item` sets
   * `id` to the runtime session id and `session_key` to
   * `_session_lookup_key` — the agent's own session id, else the stored key.
   * They are different strings, and neither of them encodes the profile.
   */
  it('reports the runtime id and the stored key as two different ids, with no profile on either', async () => {
    const stored = await busyResearcher()
    const row = (await activeRows()).find(entry => entry.session_key === stored)

    expect(row, 'the busy session is missing from the list').toBeDefined()
    expect(row?.id).not.toBe(row?.session_key)
    expect(row).not.toHaveProperty('profile')
    expect(row).not.toHaveProperty('profile_home')
  })

  /**
   * The bug, held still. Asking for `writer` returns the `researcher` row,
   * because upstream never looks at the parameter — so a client cannot read
   * "these are that profile's sessions" out of the answer, however it asked.
   */
  it('IGNORES the `profile` parameter, exactly as upstream does', async () => {
    const stored = await busyResearcher()

    const asWriter = await activeRows({ profile: 'writer' })
    const unscoped = await activeRows()
    const nonsense = await activeRows({ profile: 'no-such-profile' })

    expect(asWriter.map(row => row.session_key)).toContain(stored)
    expect(asWriter.map(row => row.session_key).sort()).toEqual(unscoped.map(row => row.session_key).sort())
    expect(nonsense.map(row => row.session_key)).toContain(stored)
  })

  /** Every row the list reports is one the gateway calls busy. */
  it('lists only live sessions, so an idle profile contributes no row', async () => {
    const stored = await busyResearcher()
    const rows = await activeRows()

    expect(rows.every(row => typeof row.status === 'string' && row.status !== 'idle')).toBe(true)
    expect(rows.map(row => row.session_key)).toContain(stored)
  })
})
