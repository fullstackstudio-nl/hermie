import type {
  AuthTimeline,
  ConnectionStatus,
  GatewayConnection,
  GatewayError,
  GatewayHttp,
  RequestOptions,
  TokenCoordinator,
  TokenSet
} from '@hermie/gateway-client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { seedDevGateway } from '../dev/seed-gateway'
import { createPersistentAuthTimeline } from './auth-timeline'
import { attachLifecycle, createGatewayConnection, createTokenCoordinator } from './client'
import { clearCredentials, clearGateway, type GatewaySetup, loadGatewaySetup, type StoredGatewayConfig } from './config'
import { useConnectionStore } from './store'

/**
 * `loading` is the disk read at startup, `onboarding` means there is no usable
 * gateway to connect to (never configured, or signed out), and `connected`
 * means one `GatewayConnection` exists and owns the socket for the rest of the
 * app's lifetime.
 */
export type GatewayPhase = 'loading' | 'onboarding' | 'connected'

export interface GatewayContextValue {
  phase: GatewayPhase
  /** Set when the user signed out: the address survives, the credentials do not. */
  resumeConfig: StoredGatewayConfig | null
  connection: GatewayConnection | null
  status: ConnectionStatus
  lastError: GatewayError | null
  config: StoredGatewayConfig | null
  extraHeaders: Record<string, string>
  http: GatewayHttp | null
  /** One JSON-RPC call on the live connection. Throws while there is none. */
  request: GatewayConnection['request']
  /** Adopt tokens from an in-place sign-in and resume the dial loop. */
  adoptTokens: (tokens: TokenSet) => Promise<void>
  /** Re-read the configuration from disk and connect; the wizard calls this when it finishes. */
  reload: () => Promise<void>
  signOut: () => Promise<void>
  changeGateway: () => Promise<void>
}

const GatewayContext = createContext<GatewayContextValue | null>(null)

function toGatewayConfig(setup: GatewaySetup) {
  const { config, extraHeaders } = setup

  return {
    baseUrl: config.baseUrl,
    authMode: config.authMode,
    ...(config.provider ? { provider: config.provider } : {}),
    extraHeaders
  }
}

/**
 * Owns the app's single `GatewayConnection` for as long as a gateway is
 * configured. One instance, never replaced while it lives: the vendored
 * JSON-RPC client keeps per-session sequence watermarks, and those are what make
 * replay work across a reconnect.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<GatewayPhase>('loading')
  const [setup, setSetup] = useState<GatewaySetup | null>(null)
  const [resumeConfig, setResumeConfig] = useState<StoredGatewayConfig | null>(null)

  const connectionRef = useRef<GatewayConnection | null>(null)
  const coordinatorRef = useRef<TokenCoordinator | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  // Outlives every connection here on purpose: `teardown` must not clear it.
  const timelineRef = useRef<AuthTimeline | null>(null)

  const status = useConnectionStore(state => state.status)
  const lastError = useConnectionStore(state => state.lastError)
  const setStatus = useConnectionStore(state => state.setStatus)
  const setStoredConfig = useConnectionStore(state => state.setConfig)
  const resetStore = useConnectionStore(state => state.reset)

  const teardown = useCallback(() => {
    unsubscribeRef.current?.()
    detachRef.current?.()
    connectionRef.current?.stop()
    unsubscribeRef.current = null
    detachRef.current = null
    connectionRef.current = null
    coordinatorRef.current = null
    resetStore()
  }, [resetStore])

  const connect = useCallback(
    (loaded: GatewaySetup, timeline: AuthTimeline) => {
      teardown()

      const coordinator =
        loaded.config.authMode === 'session_token'
          ? null
          : createTokenCoordinator({ baseUrl: loaded.config.baseUrl, extraHeaders: loaded.extraHeaders, timeline })

      const connection = createGatewayConnection({
        config: toGatewayConfig(loaded),
        timeline,
        ...(loaded.sessionToken ? { sessionToken: loaded.sessionToken } : {}),
        ...(coordinator ? { coordinator } : {})
      })

      connectionRef.current = connection
      coordinatorRef.current = coordinator
      unsubscribeRef.current = connection.onStatus((next, error) => setStatus(next, error))
      detachRef.current = attachLifecycle(connection)
      setStoredConfig(loaded.config)
      setSetup(loaded)
      setResumeConfig(null)
      setPhase('connected')
      connection.start()
    },
    [setStatus, setStoredConfig, teardown]
  )

  const reload = useCallback(async () => {
    // One ring for the app's whole life, not one per connect: it has to span the
    // sign-out and the reconnect that follow, which is the sequence worth reading.
    timelineRef.current ??= await createPersistentAuthTimeline()

    // Development only, and BEFORE the read below rather than beside it: a launch
    // argument may name a gateway, and the point of it is that the ordinary read
    // then finds a configured one. Compiled out of a production bundle with the
    // rest of `src/dev`; see `seed-gateway.ts` for the three gates.
    await seedDevGateway()

    const loaded = await loadGatewaySetup()

    if (!loaded || !loaded.hasCredentials) {
      // A configured gateway with no credential beside it is the shape of the
      // "signed out after replacing the app bundle" report, and the ring is the
      // only thing that outlives the launch to say which of the two happened.
      if (loaded) {
        timelineRef.current.record(loaded.credentialError ? { event: 'token.read_failed' } : { event: 'token.absent' })
      }

      teardown()
      setSetup(loaded)
      setResumeConfig(loaded?.config ?? null)
      setPhase('onboarding')

      return
    }

    connect(loaded, timelineRef.current)
  }, [connect, teardown])

  useEffect(() => {
    // A rejection here used to escape into nothing and leave the app on the
    // splash screen for ever. Whatever went wrong, the wizard is a better
    // answer than a spinner with no end.
    void reload().catch(() => setPhase('onboarding'))

    return () => {
      teardown()
    }
    // Startup and teardown only: `reload` is stable and re-running this on a
    // later render would drop the live socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signOut = useCallback(async () => {
    const keep = setup?.config ?? null
    teardown()
    await clearCredentials()
    setSetup(null)
    setResumeConfig(keep)
    setPhase('onboarding')
  }, [setup, teardown])

  const changeGateway = useCallback(async () => {
    teardown()
    await clearGateway()
    setSetup(null)
    setResumeConfig(null)
    setPhase('onboarding')
  }, [teardown])

  const adoptTokens = useCallback(async (tokens: TokenSet) => {
    // Through the coordinator rather than straight into the secret store: it
    // caches the token set and fences any refresh that is in flight, so a write
    // behind its back would leave it serving the signed-out state.
    await coordinatorRef.current?.save(tokens)
    connectionRef.current?.resume()
  }, [])

  const request = useCallback(
    (<M extends Parameters<GatewayConnection['request']>[0]>(
      method: M,
      params?: Parameters<GatewayConnection['request']>[1],
      options?: RequestOptions
    ) => {
      const connection = connectionRef.current

      if (!connection) {
        return Promise.reject(new Error('There is no gateway connection yet.'))
      }

      return connection.request(method, params, options)
    }) as GatewayConnection['request'],
    []
  )

  const value = useMemo<GatewayContextValue>(
    () => ({
      phase,
      resumeConfig,
      connection: connectionRef.current,
      status,
      lastError,
      config: setup?.config ?? null,
      extraHeaders: setup?.extraHeaders ?? {},
      http: connectionRef.current?.http ?? null,
      request,
      adoptTokens,
      reload,
      signOut,
      changeGateway
    }),
    [adoptTokens, changeGateway, lastError, phase, reload, request, resumeConfig, setup, signOut, status]
  )

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export function useGateway(): GatewayContextValue {
  const value = useContext(GatewayContext)

  if (!value) {
    throw new Error('useGateway() was called outside a <GatewayProvider>.')
  }

  return value
}
