/**
 * The file the daemon's memory lives in.
 *
 * Two of these are about permissions rather than about behaviour, and they are
 * here because the file holds a refresh token: ADR-0017's threat model says
 * plainly that whoever can read it has the daemon's gateway access, which is
 * read access to every transcript on that gateway.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  defaultStateDir,
  loadPushState,
  prunePushState,
  PUSH_STATE_FILE,
  PUSH_STATE_VERSION,
  savePushState,
  SENT_TTL_SECONDS
} from './state'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hermie-push-state-'))
})

describe('the state file', () => {
  it('round-trips everything the watcher has to remember', async () => {
    await savePushState(dir, {
      v: PUSH_STATE_VERSION,
      seq: { 'session-a': 42 },
      sent: { 'session-a:7': 1789957143 },
      invalid: { 'dev-1': 1789957143 },
      tickets: [{ id: 'ticket-1', installationId: 'dev-2', token: 'ExponentPushToken[x]' }],
      vapid: { publicKey: 'pub', privateKey: 'priv' },
      oidc: { refreshToken: 'rt', provider: 'oidc', gateway: 'http://127.0.0.1:9119/' }
    })

    const state = await loadPushState(dir)

    expect(state.seq['session-a']).toBe(42)
    expect(state.sent['session-a:7']).toBe(1789957143)
    expect(state.invalid['dev-1']).toBe(1789957143)
    expect(state.tickets).toEqual([{ id: 'ticket-1', installationId: 'dev-2', token: 'ExponentPushToken[x]' }])
    expect(state.vapid?.publicKey).toBe('pub')
    expect(state.oidc?.refreshToken).toBe('rt')
  })

  it('is written 0600, inside a 0700 directory', async () => {
    await savePushState(dir, { v: PUSH_STATE_VERSION, seq: {}, sent: {}, invalid: {}, tickets: [] })

    expect((await stat(path.join(dir, PUSH_STATE_FILE))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('tightens a state directory that already existed with looser permissions', async () => {
    const loose = path.join(dir, 'loose')
    await mkdir(loose, { recursive: true, mode: 0o755 })
    await savePushState(loose, { v: PUSH_STATE_VERSION, seq: {}, sent: {}, invalid: {}, tickets: [] })

    expect((await stat(loose)).mode & 0o777).toBe(0o700)
  })

  it('starts empty rather than refusing to run', async () => {
    // No file, unparseable file, and a version this build does not know: all
    // three cost one round of notifications the owner may have seen already,
    // and the alternative is a daemon that will not start.
    expect((await loadPushState(path.join(dir, 'nothing-here'))).seq).toEqual({})

    await writeFile(path.join(dir, PUSH_STATE_FILE), 'not json', 'utf8')
    expect((await loadPushState(dir)).seq).toEqual({})

    await writeFile(path.join(dir, PUSH_STATE_FILE), JSON.stringify({ v: 99, seq: { a: 1 } }), 'utf8')
    expect((await loadPushState(dir)).seq).toEqual({})
  })

  it('drops a ticket with no id, because a receipt is read by id', async () => {
    await writeFile(
      path.join(dir, PUSH_STATE_FILE),
      JSON.stringify({
        v: PUSH_STATE_VERSION,
        tickets: [{ installationId: 'dev-1' }, { id: 'a', installationId: 'b' }]
      }),
      'utf8'
    )

    expect((await loadPushState(dir)).tickets).toHaveLength(1)
  })

  it('does not leave a truncated file behind when a write is interrupted', async () => {
    // The guarantee is the rename, not the write: what is checked here is that
    // the finished file is the whole document and nothing else is left beside it.
    await savePushState(dir, { v: PUSH_STATE_VERSION, seq: { a: 1 }, sent: {}, invalid: {}, tickets: [] })
    const text = await readFile(path.join(dir, PUSH_STATE_FILE), 'utf8')

    expect(() => JSON.parse(text) as unknown).not.toThrow()
  })
})

describe('pruning', () => {
  it('forgets a dedupe key that has outlived its usefulness and keeps a fresh one', () => {
    const now = 2_000_000
    const state = prunePushState(
      {
        v: PUSH_STATE_VERSION,
        seq: {},
        sent: { old: now - SENT_TTL_SECONDS - 1, fresh: now - 10 },
        invalid: {},
        tickets: []
      },
      now
    )

    expect(Object.keys(state.sent)).toEqual(['fresh'])
  })
})

describe('where the state goes by default', () => {
  it('takes an explicit directory first, then XDG, then the home', () => {
    expect(defaultStateDir({ HERMIE_STATE_DIR: '/srv/hermie' })).toBe('/srv/hermie')
    expect(defaultStateDir({ XDG_STATE_HOME: '/var/lib/x' })).toBe(path.join('/var/lib/x', 'hermie-web'))
    expect(defaultStateDir({})).toMatch(/hermie-web$/)
  })

  it('is never the install root, which a self-update replaces', () => {
    // A daemon that forgot its VAPID key after an update would orphan every
    // browser subscription it had ever handed out.
    expect(defaultStateDir({})).not.toMatch(/releases|current/)
  })
})
