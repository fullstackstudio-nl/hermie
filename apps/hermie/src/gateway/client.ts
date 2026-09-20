import {
  type AuthTimelineSink,
  CookieSessionCredentials,
  type CredentialProvider,
  DialPlanSocketFactory,
  GatewayConnection,
  type GatewayConfig,
  NativePkceCredentials,
  refreshTokens,
  SessionTokenCredentials,
  TokenCoordinator,
  type TokenSet,
  type TokenStore
} from '@hermie/gateway-client'
import { AppState } from 'react-native'

import { networkWatcher } from '../platform/net-info'
import { RUNS_ON_MAC } from '../platform/runs-on-mac'
import { secretStore } from '../platform/secret-store'
import { PlatformWebSocket } from '../platform/socket'
import { SECRET_KEYS } from './config'

interface TokenMeta {
  expiresAt: number
  provider: string
  userId: string
}

/**
 * The token set, split over the secret store: the two tokens get their own keys,
 * and the non-secret bookkeeping rides in one JSON blob beside them.
 *
 * Three keys mean three writes, and three writes mean a partial write is
 * possible — the keychain can refuse, and the process can be killed mid-save. So
 * the ORDER matters, and it used to be `Promise.all`, which has none.
 *
 * Rotation makes one of the two partial outcomes much worse than the other. The
 * refresh token just spent is dead at the identity provider the moment the
 * gateway answers, so a save that lands the new ACCESS token but not the new
 * REFRESH token leaves a working access token next to a dead refresh token: the
 * session looks healthy until the access token lapses, and then there is nothing
 * left to renew with. On a provider with reuse detection, presenting that dead
 * token does not merely fail — it revokes the session.
 *
 * The reverse partial outcome is recoverable: the new refresh token beside the
 * OLD access token still renews. So the refresh token goes first and alone, and
 * nothing else is written until it is safely down.
 */
export function createSecretTokenStore(): TokenStore {
  return {
    async load() {
      const [accessToken, refreshToken, rawMeta] = await Promise.all([
        secretStore.get(SECRET_KEYS.accessToken),
        secretStore.get(SECRET_KEYS.refreshToken),
        secretStore.get(SECRET_KEYS.tokenMeta)
      ])

      if (!accessToken) {
        return null
      }

      let meta: TokenMeta = { expiresAt: 0, provider: '', userId: '' }

      if (rawMeta) {
        try {
          meta = { ...meta, ...(JSON.parse(rawMeta) as Partial<TokenMeta>) }
        } catch {
          // A corrupt meta blob only costs a proactive refresh, never the session.
        }
      }

      return { accessToken, refreshToken: refreshToken ?? '', ...meta }
    },
    async save(tokens: TokenSet) {
      const meta: TokenMeta = {
        expiresAt: tokens.expiresAt,
        provider: tokens.provider,
        userId: tokens.userId
      }

      // First, alone, and awaited: see the note above on which partial write
      // costs the session and which one survives.
      await secretStore.set(SECRET_KEYS.refreshToken, tokens.refreshToken)
      await Promise.all([
        secretStore.set(SECRET_KEYS.accessToken, tokens.accessToken),
        secretStore.set(SECRET_KEYS.tokenMeta, JSON.stringify(meta))
      ])
    },
    async clear() {
      await Promise.all([
        secretStore.delete(SECRET_KEYS.accessToken),
        secretStore.delete(SECRET_KEYS.refreshToken),
        secretStore.delete(SECRET_KEYS.tokenMeta)
      ])
    }
  }
}

/**
 * A token store that never touches disk. The onboarding wizard signs in and
 * tests the connection before it is allowed to persist anything, so the tokens
 * it is holding have to live somewhere that an abandoned wizard simply forgets.
 */
export function createMemoryTokenStore(initial: TokenSet | null = null): TokenStore {
  let tokens = initial

  return {
    async load() {
      return tokens
    },
    async save(next: TokenSet) {
      tokens = next
    },
    async clear() {
      tokens = null
    }
  }
}

export interface CreateTokenCoordinatorOptions {
  baseUrl: string
  extraHeaders?: Record<string, string>
  /** Defaults to the secret store; the wizard hands in a memory store. */
  store?: TokenStore
  /** The app's auth ring. The wizard leaves it out: it has no session to explain yet. */
  timeline?: AuthTimelineSink
}

/**
 * The single owner of token rotation for one gateway. It is created outside the
 * connection because the reauthentication banner has to hand it a freshly minted
 * token set — writing to the secret store behind its back would leave its cache
 * holding the signed-out state.
 */
export function createTokenCoordinator(options: CreateTokenCoordinatorOptions): TokenCoordinator {
  const extraHeaders = options.extraHeaders ?? {}

  return new TokenCoordinator({
    store: options.store ?? createSecretTokenStore(),
    refresh: tokens => refreshTokens(options.baseUrl, tokens, { extraHeaders }),
    ...(options.timeline ? { timeline: options.timeline } : {})
  })
}

export interface CreateConnectionOptions {
  config: GatewayConfig
  /** Only for `authMode: 'session_token'`; the native flow uses the coordinator. */
  sessionToken?: string
  /** Only for `authMode: 'native_pkce'`; one is built over the secret store if omitted. */
  coordinator?: TokenCoordinator
  /**
   * The app's auth ring, shared by the connection, the coordinator and the ticket
   * mint: the whole point is to read one sequence, so all three record into the
   * same one. The developer screen's throwaway connection leaves it out.
   */
  timeline?: AuthTimelineSink
}

/** Build a connection for one configured gateway. The caller owns `start()` / `stop()`. */
export function createGatewayConnection(options: CreateConnectionOptions): GatewayConnection {
  const { config, timeline } = options
  const extraHeaders = config.extraHeaders ?? {}
  const credentials: CredentialProvider =
    config.authMode === 'cookie'
      ? new CookieSessionCredentials({
          baseUrl: config.baseUrl,
          ...(timeline ? { timeline } : {})
        })
      : config.authMode === 'session_token'
        ? new SessionTokenCredentials({ token: options.sessionToken ?? '' })
        : new NativePkceCredentials({
            baseUrl: config.baseUrl,
            coordinator:
              options.coordinator ??
              createTokenCoordinator({
                baseUrl: config.baseUrl,
                extraHeaders,
                ...(timeline ? { timeline } : {})
              }),
            extraHeaders,
            ...(timeline ? { timeline } : {})
          })

  return new GatewayConnection({
    config,
    credentials,
    socketFactory: new DialPlanSocketFactory(PlatformWebSocket),
    ...(timeline ? { timeline } : {})
  })
}

/**
 * Follow the app lifecycle and the network: a backgrounded app must close its
 * socket rather than have the OS kill it half-open, and a device with no
 * connectivity should not burn battery on the dial ladder.
 *
 * **A Mac never pauses.** `pause()` tears the socket down, and on a phone that is
 * the right trade — the OS is about to kill a half-open socket anyway. A Mac
 * window that is hidden, minimised or simply behind another app is still a live
 * window with a live network, so there is nothing to protect it from. The old
 * native macOS target skipped AppState entirely for this reason; `RUNS_ON_MAC` is
 * how that survives into the iPad build, which reports iOS's AppState values like
 * any other iOS app.
 *
 * There is also a hypothesis behind it, and it is worth naming as one: the owner
 * reports "gateway not connected" appearing on the Mac build, which is what a
 * socket closed on every loss of the front would look like. That has NOT been
 * measured — neither the AppState values a Mac window reports nor the banner's
 * actual cause — so this change is justified on its own terms rather than as a
 * fix for that report.
 *
 * `resume()` is still wired on a Mac, and cheaply: it returns immediately unless
 * the connection is actually paused or stopped, so on a window coming forward it
 * is a no-op — and if anything else did pause it, this is the recovery.
 *
 * `isConnected` is `null` while the OS is still deciding, which counts as
 * online: a cold start should not sit out its first dial waiting for an answer.
 */
export function attachLifecycle(connection: GatewayConnection): () => void {
  const subscriptions: (() => void)[] = []

  const appState = AppState.addEventListener('change', next => {
    if (next === 'active') {
      connection.resume()
    } else if (next === 'background' && !RUNS_ON_MAC) {
      connection.pause()
    }
  })
  subscriptions.push(() => appState.remove())

  subscriptions.push(networkWatcher.subscribe(online => connection.setOnline(online)))

  return () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
  }
}
