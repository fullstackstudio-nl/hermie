import type { AuthTimelineSnapshot, ConnectionStatus, GatewayError } from '@hermie/gateway-client'
import { create } from 'zustand'

import type { StoredGatewayConfig } from './config'

export interface ConnectionStoreState {
  status: ConnectionStatus
  /** The most recent failure, kept while reconnecting so a banner can explain it. */
  lastError: GatewayError | null
  config: StoredGatewayConfig | null
  /**
   * The auth ring as the timeline last published it: the developer screen reads
   * the events, the signed-out card reads the reason.
   */
  authTimeline: AuthTimelineSnapshot
  setStatus: (status: ConnectionStatus, error: GatewayError | null) => void
  setConfig: (config: StoredGatewayConfig | null) => void
  setAuthTimeline: (snapshot: AuthTimelineSnapshot) => void
  reset: () => void
}

/**
 * What a teardown puts back.
 *
 * `authTimeline` is deliberately absent: `reset()` runs on sign-out, which is the
 * one moment the ring is worth the most, and `set` merges rather than replaces.
 * Wiping the account of a sign-out as part of performing it would be a neat way
 * to lose it every single time.
 */
const INITIAL = {
  status: 'disconnected' as ConnectionStatus,
  lastError: null,
  config: null
}

/**
 * Connection state as a store rather than as context state, so a deeply nested
 * chat row can subscribe to `status` without every provider consumer
 * re-rendering on an unrelated change. The `GatewayConnection` itself stays out
 * of here: it is a mutable long-lived object, not state.
 */
export const useConnectionStore = create<ConnectionStoreState>(set => ({
  ...INITIAL,
  authTimeline: { events: [], lastSignOut: null },
  setStatus: (status, error) => set({ status, lastError: error }),
  setConfig: config => set({ config }),
  setAuthTimeline: authTimeline => set({ authTimeline }),
  reset: () => set(INITIAL)
}))
