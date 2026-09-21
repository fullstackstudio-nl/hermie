/**
 * What the daemon has to remember between runs, and where it keeps it.
 *
 * A watcher with no memory is a watcher that notifies the whole backlog every
 * time it restarts. So four things survive a restart, and each of them exists
 * to stop a specific wrong notification:
 *
 *  - **`seq`** — the last event sequence acted on per session, so a reconnect's
 *    `session.events.since` replay does not re-announce what was already sent;
 *  - **`sent`** — the dedupe keys already notified, so the same row arriving
 *    twice (live, then again through a replay) buzzes once;
 *  - **`tickets`** — Expo tickets whose receipt has not resolved yet, because a
 *    receipt is the only thing that says a token is dead and it is not ready at
 *    send time;
 *  - **`invalid`** — installations whose address is finished, so a registration
 *    the owner has not cleaned up is not retried for ever.
 *
 * And two credentials: the VAPID key pair, which must be STABLE (a browser
 * subscription is bound to the key that created it, so regenerating one silently
 * orphans every web registration), and the OIDC refresh token on a gated
 * gateway.
 *
 * The file is therefore a credential store, and it is written `0600` inside a
 * `0700` directory. ADR-0017 says this plainly in its threat model: anyone who
 * can read this file has the daemon's gateway access, which is read access to
 * every transcript on that gateway. That is the same trust level as the
 * gateway's own host, which is where the daemon runs.
 */
import { constants as fsConstants } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type { ExpoTicket } from './expo'

/** Bumped when a reader could not safely take an older file. */
export const PUSH_STATE_VERSION = 1

/** The file inside the state directory. */
export const PUSH_STATE_FILE = 'push-state.json'

export interface VapidKeyPair {
  /** base64url, uncompressed P-256 point (65 bytes). This is what a browser subscribes against. */
  publicKey: string
  /** base64url, the 32-byte private scalar. */
  privateKey: string
}

export interface StoredRefreshToken {
  refreshToken: string
  provider: string
  /** The gateway it was issued by. A credential is only meaningful for one. */
  gateway: string
}

export interface PushState {
  v: number
  /** session id → highest event seq this daemon has already considered. */
  seq: Record<string, number>
  /** dedupe key → unix seconds it was sent. Pruned by age on every save. */
  sent: Record<string, number>
  /** installation id → unix seconds its address was refused for good. */
  invalid: Record<string, number>
  /** Accepted Expo tickets still waiting for a receipt. */
  tickets: ExpoTicket[]
  vapid?: VapidKeyPair
  oidc?: StoredRefreshToken
}

/** How long a dedupe key is worth keeping. Long enough to outlive a restart loop. */
export const SENT_TTL_SECONDS = 7 * 24 * 60 * 60

const EMPTY: PushState = { v: PUSH_STATE_VERSION, seq: {}, sent: {}, invalid: {}, tickets: [] }

/**
 * Where the state lives when nobody says.
 *
 * `HERMIE_STATE_DIR` first, then the XDG state directory, then a dot directory
 * in the home. Deliberately NOT the install root: a self-update replaces that,
 * and a daemon that forgot its VAPID key after an update would orphan every web
 * registration it had ever handed out.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERMIE_STATE_DIR) {
    return path.resolve(env.HERMIE_STATE_DIR)
  }

  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), 'hermie-web')
  }

  return path.join(homedir(), '.local', 'state', 'hermie-web')
}

const numberMap = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {}

  for (const [key, entry] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      out[key] = entry
    }
  }

  return out
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

function ticketsOf(value: unknown): ExpoTicket[] {
  if (!Array.isArray(value)) {
    return []
  }

  const out: ExpoTicket[] = []

  for (const entry of value as Record<string, unknown>[]) {
    const id = str(entry?.id)
    const installationId = str(entry?.installationId)

    // Only an ACCEPTED ticket is worth keeping: a receipt is read by id, and an
    // entry with no id has nothing to look up.
    if (id && installationId) {
      out.push({ id, installationId, token: str(entry.token) })
    }
  }

  return out
}

function vapidOf(value: unknown): VapidKeyPair | undefined {
  const row = (value ?? {}) as Record<string, unknown>
  const publicKey = str(row.publicKey)
  const privateKey = str(row.privateKey)

  return publicKey && privateKey ? { publicKey, privateKey } : undefined
}

function oidcOf(value: unknown): StoredRefreshToken | undefined {
  const row = (value ?? {}) as Record<string, unknown>
  const refreshToken = str(row.refreshToken)

  return refreshToken ? { refreshToken, provider: str(row.provider), gateway: str(row.gateway) } : undefined
}

/**
 * Read the state file, or start empty.
 *
 * Every failure is the same answer: a fresh state. A file that cannot be parsed,
 * a version this build does not know, a directory that is not there yet — none
 * of those is worth refusing to start over, because the cost is one round of
 * notifications the owner may have already seen and the alternative is a daemon
 * that will not run.
 */
export async function loadPushState(stateDir: string): Promise<PushState> {
  let text: string

  try {
    text = await readFile(path.join(stateDir, PUSH_STATE_FILE), 'utf8')
  } catch {
    return { ...EMPTY, seq: {}, sent: {}, invalid: {}, tickets: [] }
  }

  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ...EMPTY, seq: {}, sent: {}, invalid: {}, tickets: [] }
  }

  if (typeof parsed?.v !== 'number' || parsed.v !== PUSH_STATE_VERSION) {
    return { ...EMPTY, seq: {}, sent: {}, invalid: {}, tickets: [] }
  }

  const vapid = vapidOf(parsed.vapid)
  const oidc = oidcOf(parsed.oidc)

  return {
    v: PUSH_STATE_VERSION,
    seq: numberMap(parsed.seq),
    sent: numberMap(parsed.sent),
    invalid: numberMap(parsed.invalid),
    tickets: ticketsOf(parsed.tickets),
    ...(vapid ? { vapid } : {}),
    ...(oidc ? { oidc } : {})
  }
}

/** Drop dedupe keys older than the TTL, in place. Returns the same object. */
export function prunePushState(state: PushState, now: number, ttlSeconds = SENT_TTL_SECONDS): PushState {
  for (const [key, at] of Object.entries(state.sent)) {
    if (now - at > ttlSeconds) {
      delete state.sent[key]
    }
  }

  return state
}

/**
 * Write the state file atomically, `0600`.
 *
 * Temp file then rename, so a daemon killed mid-write leaves the previous state
 * rather than a truncated one — a half-written `sent` map is a round of
 * duplicate notifications, and a half-written VAPID key is every web
 * registration orphaned at once.
 */
export async function savePushState(stateDir: string, state: PushState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  // `mkdir` only applies the mode when it CREATES the directory, so a directory
  // that already existed with looser permissions keeps them. Say it again.
  await chmod(stateDir, 0o700).catch(() => undefined)

  const target = path.join(stateDir, PUSH_STATE_FILE)
  const temporary = `${target}.${process.pid}.tmp`

  await writeFile(temporary, `${JSON.stringify({ ...state, v: PUSH_STATE_VERSION }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
  })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, target)
}
