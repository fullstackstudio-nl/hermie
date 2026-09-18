import NetInfo from '@react-native-community/netinfo'
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

import { secretStore } from '../platform/secret-store'
import { PlatformWebSocket } from '../platform/socket'

/** Secret-store keys. The non-secret gateway config lives in the key-value store. */
export const SECRET_KEYS = {
  accessToken: 'hermie.auth.access_token',
  refreshToken: 'hermie.auth.refresh_token',
  tokenMeta: 'hermie.auth.token_meta',
  sessionToken: 'hermie.auth.session_token'
} as const

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

export interface CreateConnectionOptions {
  config: GatewayConfig
  /** Only for `authMode: 'session_token'`; the native flow reads the secret store. */
  sessionToken?: string
  tokenStore?: TokenStore
}

/** Build a connection for one configured gateway. The caller owns `start()` / `stop()`. */
export function createGatewayConnection(options: CreateConnectionOptions): GatewayConnection {
  const { config } = options
  const credentials =
    config.authMode === 'session_token'
      ? new SessionTokenCredentials({ token: options.sessionToken ?? '' })
      : new NativePkceCredentials({
          baseUrl: config.baseUrl,
          coordinator: new TokenCoordinator({
            store: options.tokenStore ?? createSecretTokenStore(),
            refresh: tokens => refreshTokens(config.baseUrl, tokens, { extraHeaders: config.extraHeaders ?? {} })
          })
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

  subscriptions.push(
    NetInfo.addEventListener(state => {
      connection.setOnline(state.isConnected !== false)
    })
  )

  return () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
  }
}
