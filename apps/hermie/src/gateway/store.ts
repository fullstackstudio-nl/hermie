import type { AuthTimelineSnapshot, ConnectionStatus, GatewayError } from '@hermie/gateway-client'
import { create } from 'zustand'

import type { StoredGatewayConfig } from './config'
import { pushRpcFailure, type RpcFailure } from './rpc-failures'

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
  /**
   * Gateway calls whose failure a screen decided to absorb, oldest first.
   *
   * Separate from `authTimeline` on purpose: that ring's whole design is a
   * closed set of names with no message text, so it can be pasted into an issue
   * without a judgement call. This one carries the gateway's words, which is the
   * only thing that makes a protocol mismatch readable.
   */
  rpcFailures: RpcFailure[]
  setStatus: (status: ConnectionStatus, error: GatewayError | null) => void
  setConfig: (config: StoredGatewayConfig | null) => void
  setAuthTimeline: (snapshot: AuthTimelineSnapshot) => void
  noteRpcFailure: (failure: RpcFailure) => void
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
  rpcFailures: [],
  setStatus: (status, error) => set({ status, lastError: error }),
  setConfig: config => set({ config }),
  setAuthTimeline: authTimeline => set({ authTimeline }),
  noteRpcFailure: failure => set(state => ({ rpcFailures: pushRpcFailure(state.rpcFailures, failure) })),
  reset: () => set(INITIAL)
}))
