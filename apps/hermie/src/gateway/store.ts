import type { ConnectionStatus, GatewayError } from '@hermie/gateway-client'
import { create } from 'zustand'

import type { StoredGatewayConfig } from './config'

export interface ConnectionStoreState {
  status: ConnectionStatus
  /** The most recent failure, kept while reconnecting so a banner can explain it. */
  lastError: GatewayError | null
  config: StoredGatewayConfig | null
  setStatus: (status: ConnectionStatus, error: GatewayError | null) => void
  setConfig: (config: StoredGatewayConfig | null) => void
  reset: () => void
}

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
  setStatus: (status, error) => set({ status, lastError: error }),
  setConfig: config => set({ config }),
  reset: () => set(INITIAL)
}))
