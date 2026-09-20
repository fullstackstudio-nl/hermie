/**
 * "Is there a network", as the connection's dial ladder asks it.
 *
 * A seam rather than a direct `NetInfo` call because the browser build has no
 * `@react-native-community/netinfo` — `net-info.web.ts` answers the same
 * question with `navigator.onLine`, which is a weaker but honest answer.
 *
 * The contract is one subscription that reports the current value immediately
 * and then on every change, and returns its own unsubscribe. `isConnected` is
 * `null` while the OS is still deciding, which counts as online: a cold start
 * should not sit out its first dial waiting for an answer.
 */
import NetInfo from '@react-native-community/netinfo'

import type { NetworkWatcher } from './platform-contracts'

export type { NetworkWatcher } from './platform-contracts'

export const networkWatcher: NetworkWatcher = {
  subscribe(onChange) {
    return NetInfo.addEventListener(state => onChange(state.isConnected !== false))
  }
}
