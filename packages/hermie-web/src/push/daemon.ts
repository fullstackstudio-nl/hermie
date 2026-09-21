/**
 * `hermie-web --push`: the thing that is awake when nobody is looking.
 *
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md) in one
 * paragraph: an app that is not running has no socket — iOS suspends it within
 * seconds of backgrounding and Android's Doze does the equivalent — so
 * something that is always running has to watch, and it has to be something the
 * owner already runs. This process already sits next to the gateway, so it is
 * the one.
 *
 * This file owns the LIFECYCLE and nothing else: one connection, the state file
 * around it, and a clean stop. What to notify about is `watcher.ts`, how to
 * reach a device is `expo.ts` and `web-push.ts`, and who asked to be told is
 * `registrations.ts`.
 */
import { PUSH_PUBLIC_KEY_PATH } from '../options'
import { type PushCredentials, resolveCredentials } from './credentials'
import { GatewayLink, type LinkEvent, type LinkServerRequest } from './link'
import { createSender, pollExpoReceipts, RECEIPT_POLL_INTERVAL_MS } from './senders'
import { loadPushState, prunePushState, type PushState, savePushState } from './state'
import { AVAILABILITY_TTL_SECONDS, PushWatcher, type PushSender, type WatcherOptions } from './watcher'
import { generateVapidKeys, vapidKeysUsable } from './web-push'

export interface PushDaemonOptions {
  gatewayUrl: string
  /** Hermie Web's own version, written into the availability stamp. */
  version?: string
  /** The session token an ungated gateway takes; empty on a gated one. */
  gatewayToken?: string
  stateDir: string
  log?: (line: string) => void
  /** Injected by the tests. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  fetchImpl?: typeof fetch
  /** Called after every connect, once the link is live and the watcher has resumed. */
  onOpen?: (link: GatewayLink) => Promise<void> | void
  onEvent?: (event: LinkEvent) => void
  onServerRequest?: (request: LinkServerRequest) => void
  /** The `sub` claim of the VAPID token: a `mailto:` or `https:` contact. */
  vapidSubject?: string
  /**
   * Replace the transports. The default sends through Expo and Web Push; the
   * tests hand in a recorder.
   */
  sender?: PushSender
  /** Off for a link-only test that has no business resuming anything. */
  watch?: boolean
  /** Off in the tests, which have no use for a quarter-hourly timer. */
  pollReceipts?: boolean
  /** The watcher's clocks, so a test does not have to wait out the real ones. */
  tuning?: Pick<
    WatcherOptions,
    'attachedWindowSeconds' | 'availabilityTtlSeconds' | 'openingGraceMs' | 'rateLimit' | 'registrationTtlMs'
  >
}

export interface PushDaemon {
  link: GatewayLink
  credentials: PushCredentials
  state: PushState
  /** The watcher, when this daemon was asked to watch. */
  watcher: PushWatcher | null
  /** The public half of the VAPID key pair, base64url — what `GET /push/vapid-public-key` serves. */
  vapidPublicKey: string
  /** Persist the state file. Debounced by the caller, not here. */
  save(): Promise<void>
  stop(): Promise<void>
}

export async function startPushDaemon(options: PushDaemonOptions): Promise<PushDaemon> {
  const log = options.log ?? ((line: string) => console.warn(line))
  const state = prunePushState(await loadPushState(options.stateDir), Math.floor(Date.now() / 1000))
  /*
    Generated once and then never again. A browser's `PushSubscription` is bound
    to the application-server key that created it, so a daemon that minted a new
    pair on every start would silently orphan every web registration it had ever
    handed out — the subscriptions would still exist and every send to them
    would be refused.
  */
  const vapid = { keys: state.vapid ?? generateVapidKeys(), subject: options.vapidSubject ?? 'https://hermie.dev' }

  if (!vapidKeysUsable(state.vapid)) {
    if (state.vapid) {
      log('push: the stored VAPID key pair could not be read; a new one was generated')
      vapid.keys = generateVapidKeys()
    }

    state.vapid = vapid.keys
  }

  let link: GatewayLink | null = null

  const save = async (): Promise<void> => {
    // The link is the authority on how far each session has been read; the file
    // is only where that survives a restart.
    Object.assign(state.seq, link?.snapshotWatermarks() ?? {})
    await savePushState(options.stateDir, state)
  }

  const credentials = resolveCredentials({
    gatewayUrl: options.gatewayUrl,
    token: options.gatewayToken || undefined,
    state,
    persist: async stored => {
      state.oidc = stored
      await save()
    },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })

  let watcher: PushWatcher | null = null

  link = new GatewayLink({
    dial: () => credentials.dial(),
    onEvent: event => {
      watcher?.onEvent(event)
      options.onEvent?.(event)
    },
    onServerRequest: request => {
      watcher?.onServerRequest(request)
      options.onServerRequest?.(request)
    },
    onOpen: async (): Promise<void> => {
      // Resuming is what subscribes this connection to a session's events, so
      // it happens on EVERY connect and not only on the first.
      await watcher?.resumeAll()
      await options.onOpen?.(link as GatewayLink)
    },
    log,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {})
  })

  const sender =
    options.sender ??
    createSender({ state, vapid, log, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) })

  if (options.watch !== false) {
    watcher = new PushWatcher({
      link,
      state,
      save,
      sender,
      log,
      // Informational only. ADR-0017: the app never dials this; it reads the
      // stamp so Settings can say whether push is available at all.
      availability: () => ({
        endpoint: PUSH_PUBLIC_KEY_PATH,
        vapidPublicKey: vapid.keys.publicKey,
        version: options.version ?? '0.0.0'
      }),
      ...(options.tuning ?? {})
    })
  }

  /*
    Receipts, not tickets. Expo answers a send with a ticket, which only says the
    request was accepted; whether Apple or Google took it is in a receipt read
    afterwards by ticket id, and it is not ready at send time. This is the sweep
    that reads them back and retires the tokens they condemn.
  */
  const receipts =
    options.pollReceipts === false
      ? null
      : setInterval(() => {
          void pollExpoReceipts(state, {
            state,
            vapid,
            log,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
          })
            .then(result => (result.dead.length || result.expired ? save() : undefined))
            .catch(() => undefined)
        }, RECEIPT_POLL_INTERVAL_MS)

  receipts?.unref()

  /*
    The liveness stamp has to keep moving on a quiet gateway too. Settings reads
    it to say whether push is available, and "available" is a claim about NOW —
    a stamp that only advanced when a chat did would say the daemon had stopped
    every time nobody talked to a bot overnight.
  */
  const heartbeat =
    options.pollReceipts === false || !watcher
      ? null
      : setInterval(
          () => {
            void watcher?.announce().catch(() => undefined)
          },
          (AVAILABILITY_TTL_SECONDS / 2) * 1000
        )

  heartbeat?.unref()

  // A restart must not replay everything the gateway still has in its ring.
  for (const [sessionId, seq] of Object.entries(state.seq)) {
    link.seedWatermark(sessionId, seq)
  }

  log(`push: watching ${options.gatewayUrl} (${credentials.mode} credential), state in ${options.stateDir}`)
  await save()
  link.start()

  return {
    link,
    credentials,
    state,
    watcher,
    vapidPublicKey: vapid.keys.publicKey,
    save,
    async stop() {
      if (receipts) {
        clearInterval(receipts)
      }

      if (heartbeat) {
        clearInterval(heartbeat)
      }

      await link?.stop()
      await watcher?.settle()
      await save()
    }
  }
}
