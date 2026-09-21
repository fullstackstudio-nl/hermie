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
import { createHash, randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway, type FakeGateway } from './server'

const base64url = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

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

  /**
   * `offset` skips from the end `order` names, and the page comes back oldest
   * first either way.
   *
   * Measured against a real gateway (0.21.3) on 2026-09-21, because this route
   * is not vendored here and the fake used to parse this parameter, echo it in
   * `pagination` and then ignore it — a fake advertising paging it did not do,
   * which is the one kind of infidelity a test written against the fake cannot
   * catch. The app's older-history paging rests on exactly this.
   */
  it('pages from the end `order` names, and answers oldest first', async () => {
    const session = await chat()
    const all = (await get(`/api/sessions/${encodeURIComponent(session)}/messages?limit=500&order=oldest`)) as {
      messages: { content: string }[]
    }

    expect(all.messages.length).toBeGreaterThan(2)

    const page = async (query: string) =>
      (
        (await get(`/api/sessions/${encodeURIComponent(session)}/messages?${query}`)) as {
          messages: { content: string }[]
        }
      ).messages.map(row => row.content)

    const contents = all.messages.map(row => row.content)

    expect(await page('limit=1&order=latest')).toEqual(contents.slice(-1))
    expect(await page('limit=1&order=latest&offset=1')).toEqual(contents.slice(-2, -1))
    expect(await page('limit=2&order=latest&offset=1')).toEqual(contents.slice(-3, -1))
    expect(await page('limit=1&order=oldest&offset=1')).toEqual(contents.slice(1, 2))
    // Past the end is an empty list, not an error.
    expect(await page('limit=5&order=latest&offset=9999')).toEqual([])
  })
})

describe('GET /api/sessions/search — sessions.py::search_sessions', () => {
  it('wraps the hits in `results`, and answers one for a blank query at all', async () => {
    expect(keysOf(await get('/api/sessions/search?q=introduce'))).toEqual(['results'])
    expect(await get('/api/sessions/search?q=')).toEqual({ results: [] })
  })

  /**
   * The projection, and what it costs.
   *
   * The handler asks `SessionDB.search_messages` for exactly
   * `("session_id", "role", "snippet", "source", "model", "session_started")`
   * and then merges `get_session_rich_row` onto it. `search_messages` CAN
   * return the message's `id` and `timestamp` — the field list allows both —
   * and this route does not ask for either. So a hit names a conversation and
   * never a message, and "open the chat at that row" is work the client has to
   * do for itself. Running the real `search_messages` on a scratch database is
   * what settled that; nothing in the response shape says it out loud.
   */
  it('names a conversation, never a message', async () => {
    const body = (await get('/api/sessions/search?q=introduce')) as { results: Record<string, unknown>[] }

    expect(body.results.length).toBeGreaterThan(0)

    for (const hit of body.results) {
      expect(typeof hit.session_id).toBe('string')
      expect(hit.timestamp).toBeUndefined()
      expect(hit.row_id).toBeUndefined()
      expect(hit.message_id).toBeUndefined()
    }
  })

  /**
   * One `state.db` per profile, so one search per profile.
   *
   * `_open_session_db_for_profile` resolves the profile to its own home and
   * opens the `state.db` there. There is no call that searches the whole
   * gateway, and an unknown profile is a 404 out of `_cron_profile_home`
   * rather than an empty result — which is what a fan-out over a roster has to
   * be written to survive.
   */
  it('is scoped to one profile, and 404s a profile that is not there', async () => {
    const all = (await get('/api/sessions/search?q=introduce')) as { results: unknown[] }
    const one = (await get('/api/sessions/search?q=introduce&profile=writer')) as { results: unknown[] }

    expect(all.results.length).toBeGreaterThan(one.results.length)
    expect((await fetch(`${gateway.url}/api/sessions/search?q=introduce&profile=nobody`)).status).toBe(404)
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

/**
 * The native token endpoints, pinned against `hermes_cli/dashboard_auth/routes.py`.
 *
 * These matter more than most routes here: the client turns a status code from
 * the refresh endpoint straight into "keep this session" or "delete the refresh
 * token", and it cannot undo the second one. Which codes mean which is therefore
 * a contract, not an implementation detail.
 */
describe('POST /auth/native/refresh — routes.py::auth_native_refresh', () => {
  const refresh = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${gateway.url}/auth/native/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  /**
   * routes.py:501-502, `if not body.refresh_token: raise _http(400, ...)`. The
   * only 400 this route answers, and the reason the client may treat 400 as
   * final: it can never describe a transient condition.
   */
  it('answers 400 `refresh_token required` for an empty token', async () => {
    const empty = await refresh({ refresh_token: '', provider: 'self-hosted' })

    expect(empty.status).toBe(400)
    expect(empty.body.detail).toBe('refresh_token required')
  })

  /**
   * routes.py:516-519. Expired, unknown, and rejected-by-every-provider all
   * collapse into this one answer, with an `error` key no other route in
   * `dashboard_auth` sends and — unlike the gate's 401 in `middleware.py:73-76` —
   * no `login_url`.
   */
  it('answers 401 `session_expired` for a token it does not know', async () => {
    const unknown = await refresh({ refresh_token: 'rt-never-issued', provider: 'self-hosted' })

    expect(unknown.status).toBe(401)
    expect(unknown.body.error).toBe('session_expired')
    expect(typeof unknown.body.detail).toBe('string')
    expect(unknown.body.login_url).toBeUndefined()
  })

  /**
   * The codes this route cannot answer with, which is what lets the client treat
   * them as retryable. Upstream has no rate limiter on any native route — the
   * only 429 in `dashboard_auth` is `/auth/password-login` (routes.py:382-384) —
   * and no 403 literal exists in the package at all. If upstream ever did start
   * refusing a grant with one of these, this is where it would be noticed, and
   * `DEFINITIVE_REFRESH_STATUSES` in `native-auth.ts` is what would have to move.
   */
  it('never refuses a grant with 403, 408 or 429', async () => {
    const refused = await refresh({ refresh_token: 'rt-never-issued', provider: 'self-hosted' })

    expect([403, 408, 429]).not.toContain(refused.status)
  })

  /**
   * `_bearer_payload`, routes.py:110-115 — the shape BOTH `/auth/native/token`
   * and `/auth/native/refresh` answer with.
   *
   * `expires_at` is unix SECONDS: pinned at the dataclass (`base.py:18`, "unix
   * seconds; the access_token's exp claim"), computed as the raw JWT `exp`
   * (`_shared.py:177`) or `int(time.time()) + ttl` (`basic/__init__.py:172-173`),
   * and there is no `* 1000` anywhere in the package. There is no `expires_in`
   * key to fall back on either. A client reading it as milliseconds would put the
   * expiry some fifty thousand years out and never refresh proactively at all,
   * which is a bug that hides until the access token lapses.
   */
  it('rotates into the six-key bearer payload, with expires_at in unix seconds', async () => {
    const gated = await startFakeGateway({ port: 0, auth: 'native' })

    try {
      const verifier = base64url(randomBytes(32))
      const authorize = new URL(`${gated.url}/auth/native/authorize`)
      authorize.searchParams.set('provider', 'self-hosted')
      authorize.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:8765/callback')
      authorize.searchParams.set('state', 'state-1')
      authorize.searchParams.set('auto', '1')

      const redirected = await fetch(authorize, { redirect: 'manual' })
      const code = new URL(String(redirected.headers.get('location'))).searchParams.get('code')

      const exchanged = await fetch(`${gated.url}/auth/native/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier })
      })
      const issued = (await exchanged.json()) as Record<string, unknown>

      expect(exchanged.status).toBe(200)
      expect(keysOf(issued)).toEqual([
        'access_token',
        'expires_at',
        'provider',
        'refresh_token',
        'token_type',
        'user_id'
      ])
      expect(issued.token_type).toBe('Bearer')
      expect(issued.expires_in).toBeUndefined()

      // Seconds, not milliseconds: the same instant in ms would be ~1.7e12.
      const expiresAt = issued.expires_at as number
      expect(expiresAt).toBeGreaterThan(Date.now() / 1000)
      expect(expiresAt).toBeLessThan(Date.now())

      const rotated = await fetch(`${gated.url}/auth/native/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: issued.refresh_token, provider: 'self-hosted' })
      })
      const next = (await rotated.json()) as Record<string, unknown>

      expect(rotated.status).toBe(200)
      expect(keysOf(next)).toEqual(keysOf(issued))
      // Rotation: a new refresh token, and the old one is spent.
      expect(next.refresh_token).not.toBe(issued.refresh_token)

      const replayed = await fetch(`${gated.url}/auth/native/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: issued.refresh_token, provider: 'self-hosted' })
      })

      /**
       * Upstream keeps no refresh-token store of its own; rotation happens at the
       * identity provider, and `refresh_singleflight.py` caches a successful
       * rotation for 30 s (`_SUCCESS_TTL`), so a replay inside that window gets
       * **200 with the same body** and only afterwards reaches the provider and
       * becomes a 401. The fake refuses immediately instead, which is the case
       * the client has to survive — and on a provider with reuse detection the
       * replay does not merely fail, it revokes the session.
       */
      expect(replayed.status).toBe(401)
      expect(gated.state.refreshReuseAttempts).toBe(1)
    } finally {
      await gated.close()
    }
  })
})

/**
 * The slash-command trio, pinned against `hermes serve` 0.21.3 as it answered
 * on 2026-09-21 (`tui_gateway/methods_tools.py` and `methods_complete.py`).
 *
 * This block exists because of a bug report, not a hunch. Slash autocomplete
 * shipped green: every test drove the fake, and the fake answered
 * `commands.catalog` with unslashed keys, `complete.slash` with slashed item
 * text and `replace_from: 0`, and `slash.exec` with one cheerful line for
 * ANYTHING — including the skills a real gateway refuses outright. The owner
 * typed `/` on a real gateway and saw nothing.
 *
 * So each case below names what upstream actually does, and the fake was
 * changed to match it rather than the other way round.
 */
describe('the slash trio over the socket — methods_tools.py + methods_complete.py', () => {
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

  /** The whole frame, because half these cases are about the ERROR half. */
  const raw = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          // Resolve with the RESULT when there is one and with the whole frame
          // otherwise, so an error case can read `error.code`.
          waiter((frame.result ?? frame) as Record<string, unknown>)
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

  describe('commands.catalog — methods_tools.py::_Catalog', () => {
    it('keys every map WITH the slash, the way the accumulator writes them', async () => {
      const catalog = await call('commands.catalog', { session_id: 'bot-chat-writer', profile: 'writer' })

      for (const pair of catalog.pairs as string[][]) {
        expect(pair[0]).toMatch(/^\//u)
      }

      for (const key of Object.keys(catalog.canon as Record<string, string>)) {
        expect(key).toMatch(/^\//u)
      }

      for (const key of Object.keys(catalog.commands as Record<string, unknown>)) {
        expect(key).toMatch(/^\//u)
      }

      // `_catalog_skills` writes `cat.pairs.append([k, …])` with `k` already
      // slashed, and fills `skills[k]` under the same key.
      for (const key of Object.keys(catalog.skills as Record<string, unknown>)) {
        expect(key).toMatch(/^\//u)
      }
    })

    it('answers every key the accumulator returns, including the empty warning', () => {
      return call('commands.catalog', { session_id: 'bot-chat-writer' }).then(catalog => {
        expect(keysOf(catalog)).toEqual([
          'canon',
          'categories',
          'commands',
          'pairs',
          'skill_count',
          'skills',
          'sub',
          'warning'
        ])
        // `""` when nothing failed discovery — not absent, and not null.
        expect(catalog.warning).toBe('')
      })
    })

    /**
     * `skills[k]` is `{usage, origin}` and nothing else: every consumer ranks by
     * them. The fake used to put a `description` there, which is a field no
     * gateway sends and nothing could read.
     */
    it('describes a skill by usage and origin, not by a description', async () => {
      const catalog = await call('commands.catalog', {})
      const skills = catalog.skills as Record<string, Record<string, unknown>>

      for (const entry of Object.values(skills)) {
        expect(keysOf(entry)).toEqual(['origin', 'usage'])
      }

      expect(catalog.skill_count).toBe(Object.keys(skills).length)
    })

    /** `ArgumentMode` is `options | text | mixed` — or null. Never `required`. */
    it('uses upstream’s three-value argument_mode', async () => {
      const catalog = await call('commands.catalog', {})
      const commands = catalog.commands as Record<string, { argument_mode?: unknown }>

      for (const meta of Object.values(commands)) {
        expect([null, 'options', 'text', 'mixed']).toContain(meta.argument_mode ?? null)
      }
    })
  })

  describe('complete.slash — methods_complete.py', () => {
    /**
     * The single most load-bearing shape here. `c.text` is the completion's own
     * text with NO slash; the slash the reader typed is kept because
     * `replace_from` is 1 rather than 0. A client that accepted an item by
     * pasting `text` over the whole line would write `/` + `/model`.
     */
    it('answers unslashed text, slashed display, and replace_from 1', async () => {
      const result = await call('complete.slash', { text: '/mo', session_id: 'bot-chat-writer' })
      const items = result.items as { text: string; display: string; kind: string }[]

      expect(items.length).toBeGreaterThan(0)
      expect(result.replace_from).toBe(1)

      for (const item of items) {
        expect(item.text).not.toMatch(/^\//u)
        expect(item.display).toMatch(/^\//u)
        // `kind` rides only on slash completions: command vs skill.
        expect(['command', 'skill']).toContain(item.kind)
      }
    })

    /** Accepting an item has to rebuild the typed line without doubling it. */
    it('rebuilds the line the way the composer does', async () => {
      const typed = '/mo'
      const result = await call('complete.slash', { text: typed, session_id: 'bot-chat-writer' })
      const first = (result.items as { text: string }[])[0]!

      expect(`${typed.slice(0, result.replace_from as number)}${first.text}`).toBe('/model')
    })

    /** `text.rfind(" ") + 1` once there is an argument: the command is kept. */
    it('moves replace_from to the argument once there is one', async () => {
      const result = await call('complete.slash', { text: '/model ', session_id: 'bot-chat-writer' })

      expect(result.replace_from).toBe(7)
    })

    /** `if not text.startswith("/"): return {"items": []}` — and no replace_from. */
    it('answers nothing at all for a line that is not a command', async () => {
      const result = await call('complete.slash', { text: 'model', session_id: 'bot-chat-writer' })

      expect(result.items).toEqual([])
      expect(result.replace_from).toBeUndefined()
    })
  })

  describe('slash.exec — methods_tools.py::slash.exec', () => {
    /**
     * The refusal that broke the feature. Every skill in `commands.catalog`
     * answers `knowsSlashCommand` yes, and upstream's `_is_profile_skill_command`
     * guard refuses all of them here with 4018 — measured verbatim on the
     * reviewer gateway for `/docx`, `/pdf` and `/github`.
     */
    it('refuses a skill command and names the method that takes it', async () => {
      const frame = await raw('slash.exec', { session_id: 'bot-chat-writer', command: '/release-notes' })
      const error = frame.error as { code: number; message: string }

      expect(error.code).toBe(4018)
      expect(error.message).toContain('command.dispatch')
    })

    /**
     * `slash.exec` hands a rerouted built-in's DIRECTIVE straight back, so its
     * result can carry a `type` and no `output` at all. `/queue list` answers
     * `{type: 'send', message: 'list'}` on a real gateway: a client that reads
     * `output ?? message` renders the word `list` as though it were the result
     * and never queues anything.
     */
    it('can answer with a command.dispatch directive rather than output', async () => {
      const result = await call('slash.exec', { session_id: 'bot-chat-writer', command: '/queue write it up' })

      expect(result.type).toBe('send')
      expect(result.message).toBe('write it up')
      expect(result.output).toBeUndefined()
    })

    /** A worker command's text is a BLOCK, not a line. It needs somewhere to go. */
    it('answers a multi-line block for the commands that have one', async () => {
      const result = await call('slash.exec', { session_id: 'bot-chat-writer', command: '/status' })

      expect(String(result.output).split('\n').length).toBeGreaterThan(3)
    })
  })

  describe('command.dispatch — methods_tools.py::command.dispatch', () => {
    /**
     * `display` is the line a UI renders; `message` is the expanded skill body,
     * which is model-facing scaffolding no surface may show.
     */
    it('answers a skill as a directive with a display and a message', async () => {
      const result = await call('command.dispatch', {
        name: 'release-notes',
        arg: 'for 1.2',
        session_id: 'bot-chat-writer'
      })

      expect(result.type).toBe('skill')
      expect(result.display).toBe('/release-notes for 1.2')
      expect(String(result.message).length).toBeGreaterThan(String(result.display).length)
    })

    it('answers a prefill with the text the composer is meant to take', async () => {
      const result = await call('command.dispatch', { name: 'undo', session_id: 'bot-chat-writer' })

      expect(result.type).toBe('prefill')
      expect(typeof result.message).toBe('string')
    })
  })
})

/**
 * The one key whose values are NOT the boolean words every other switch takes.
 *
 * This is the shape a whole feature was lost to: the options sheet sent
 * `true`/`false` for fast mode because that is what the yolo switch next to it
 * sends, upstream parses this key against `_FAST_WORDS` instead, and every tap
 * came back 4002. The fake stored whatever it was handed, so the suite agreed
 * with the app and both were wrong about the gateway.
 */
describe('config.set fast — methods_config_set.py::_set_fast', () => {
  let live: FakeGateway
  let socket: WebSocket
  let nextId = 0

  const pending = new Map<number, (value: Record<string, unknown>) => void>()

  /** The whole frame: half of these cases are about the ERROR half of it. */
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  beforeAll(async () => {
    live = await startFakeGateway({ port: 0 })
    socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>
        const id = typeof frame.id === 'number' ? frame.id : null
        const waiter = id === null ? undefined : pending.get(id)

        if (waiter && id !== null) {
          pending.delete(id)
          waiter(frame)
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

  /** A stored session id the server will actually resolve and write against. */
  const storedIdOf = async (profile: string): Promise<string> => {
    const frame = await call('profiles.list', { include_sessions: true })
    const profiles = (frame.result as Record<string, unknown>).profiles as Record<string, unknown>[]
    const row = profiles.find(entry => entry.name === profile)
    const stored = String((row?.canonical_session as Record<string, unknown> | undefined)?.id ?? '')

    expect(stored).not.toBe('')

    return stored
  }

  let session = ''

  beforeAll(async () => {
    session = await storedIdOf('writer')
  })

  it('refuses `true` with 4002, the way upstream refuses a word it does not know', async () => {
    const frame = await call('config.set', { key: 'fast', value: 'true', session_id: session })

    expect(frame.result).toBeUndefined()
    expect(frame.error).toMatchObject({ code: 4002, message: 'unknown fast mode: true' })
  })

  it('takes the words the gateway takes, and reads them back as a mode', async () => {
    for (const [sent, stored] of [
      ['fast', 'fast'],
      ['on', 'fast'],
      ['normal', 'normal'],
      ['off', 'normal']
    ]) {
      const set = await call('config.set', { key: 'fast', value: sent, session_id: session })

      expect(set.error).toBeUndefined()

      const read = await call('config.get', { key: 'fast', session_id: session })

      expect((read.result as Record<string, unknown>).value).toBe(stored)
    }
  })

  it('reports a session nobody has switched as `normal`, never as blank', async () => {
    const read = await call('config.get', { key: 'fast', session_id: await storedIdOf('researcher') })

    expect((read.result as Record<string, unknown>).value).toBe('normal')
  })

  /**
   * The neighbour that made the defect above so easy to miss. `yolo` is parsed
   * against `_BOOL_WORDS`, which really does take `true` — so the sheet's
   * `true`/`false` was right here and wrong one row up.
   */
  it('takes every boolean word upstream takes for yolo, and reports it back switched on', async () => {
    for (const word of ['1', 'on', 'true', 'yes']) {
      const set = await call('config.set', { key: 'yolo', value: word, session_id: session })
      const result = set.result as Record<string, unknown>

      expect(set.error).toBeUndefined()
      // The value is echoed as it was sent; what it MEANS is reported on the
      // session, which is where a client reads it back.
      expect(result.value).toBe(word)
      expect((result.info as Record<string, unknown>).yolo).toBe(true)
    }

    for (const word of ['0', 'off', 'false', 'no']) {
      const set = await call('config.set', { key: 'yolo', value: word, session_id: session })

      expect(set.error).toBeUndefined()
      expect(((set.result as Record<string, unknown>).info as Record<string, unknown>).yolo).toBe(false)
    }
  })
})
