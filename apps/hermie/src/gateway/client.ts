import {
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
import { AppState, Platform } from 'react-native'

import { subscribeToConnectivity } from '../platform/net-info'
import { secretStore } from '../platform/secret-store'
import { PlatformWebSocket } from '../platform/socket'
import { SECRET_KEYS } from './config'

interface TokenMeta {
  expiresAt: number
  provider: string
  userId: string
}

/**
 * The token set, split over the secret store: the two tokens get their own
 * keys so a partial write can never leave one readable next to the other's
 * metadata, and the non-secret bookkeeping rides in one JSON blob.
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

      await Promise.all([
        secretStore.set(SECRET_KEYS.accessToken, tokens.accessToken),
        secretStore.set(SECRET_KEYS.refreshToken, tokens.refreshToken),
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
    refresh: tokens => refreshTokens(options.baseUrl, tokens, { extraHeaders })
  })
}

export interface CreateConnectionOptions {
  config: GatewayConfig
  /** Only for `authMode: 'session_token'`; the native flow uses the coordinator. */
  sessionToken?: string
  /** Only for `authMode: 'native_pkce'`; one is built over the secret store if omitted. */
  coordinator?: TokenCoordinator
}

/** Build a connection for one configured gateway. The caller owns `start()` / `stop()`. */
export function createGatewayConnection(options: CreateConnectionOptions): GatewayConnection {
  const { config } = options
  const extraHeaders = config.extraHeaders ?? {}
  const credentials =
    config.authMode === 'session_token'
      ? new SessionTokenCredentials({ token: options.sessionToken ?? '' })
      : new NativePkceCredentials({
          baseUrl: config.baseUrl,
          coordinator: options.coordinator ?? createTokenCoordinator({ baseUrl: config.baseUrl, extraHeaders }),
          extraHeaders
        })

  return new GatewayConnection({
    config,
    credentials,
    socketFactory: new DialPlanSocketFactory(PlatformWebSocket)
  })
}

/**
 * Follow the app lifecycle and the network: on iOS and Android a backgrounded
 * app must close its socket rather than have the OS kill it half-open, and a
 * device with no connectivity should not burn battery on the dial ladder.
 * macOS windows stay live, so AppState is ignored there.
 */
export function attachLifecycle(connection: GatewayConnection): () => void {
  const subscriptions: (() => void)[] = []

  if (Platform.OS !== 'macos') {
    const appState = AppState.addEventListener('change', next => {
      if (next === 'active') {
        connection.resume()
      } else if (next === 'background') {
        connection.pause()
      }
    })
    subscriptions.push(() => appState.remove())
  }

  subscriptions.push(subscribeToConnectivity(online => connection.setOnline(online)))

  return () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
  }
}
