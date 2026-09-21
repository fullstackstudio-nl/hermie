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
import { type PushCredentials, resolveCredentials } from './credentials'
import { sendExpo } from './expo'
import { GatewayLink, type LinkEvent, type LinkServerRequest } from './link'
import { loadPushState, prunePushState, type PushState, savePushState } from './state'
import { PushWatcher, type PushSender } from './watcher'

export interface PushDaemonOptions {
  gatewayUrl: string
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
  /**
   * Replace the transports. The default sends through Expo; the tests hand in a
   * recorder, and a deployment with no Expo registrations never reaches it.
   */
  sender?: PushSender
  /** Off for a link-only test that has no business resuming anything. */
  watch?: boolean
}

export interface PushDaemon {
  link: GatewayLink
  credentials: PushCredentials
  state: PushState
  /** The watcher, when this daemon was asked to watch. */
  watcher: PushWatcher | null
  /** Persist the state file. Debounced by the caller, not here. */
  save(): Promise<void>
  stop(): Promise<void>
}

/** Expo is the default transport for a registration that carries an Expo token. */
const expoSender: PushSender = {
  async send(registrations, message) {
    const { dead } = await sendExpo(registrations, message)

    return { dead }
  }
}

export async function startPushDaemon(options: PushDaemonOptions): Promise<PushDaemon> {
  const log = options.log ?? ((line: string) => console.warn(line))
  const state = prunePushState(await loadPushState(options.stateDir), Math.floor(Date.now() / 1000))

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

  if (options.watch !== false) {
    watcher = new PushWatcher({
      link,
      state,
      save,
      sender: options.sender ?? expoSender,
      log
    })
  }

  // A restart must not replay everything the gateway still has in its ring.
  for (const [sessionId, seq] of Object.entries(state.seq)) {
    link.seedWatermark(sessionId, seq)
  }

  log(`push: watching ${options.gatewayUrl} (${credentials.mode} credential), state in ${options.stateDir}`)
  link.start()

  return {
    link,
    credentials,
    state,
    watcher,
    save,
    async stop() {
      await link?.stop()
      await watcher?.settle()
      await save()
    }
  }
}
