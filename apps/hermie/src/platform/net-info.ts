import NetInfo from '@react-native-community/netinfo'

/**
 * Whether the device believes it has connectivity.
 *
 * This is a platform seam rather than a direct NetInfo call because NetInfo has
 * no macOS build — see `net-info.macos.ts`. The handler is called on every
 * change; `isConnected` is `null` while the OS is still deciding, which counts
 * as online so a cold start does not sit out its first dial.
 */
export function subscribeToConnectivity(handler: (online: boolean) => void): () => void {
  return NetInfo.addEventListener(state => handler(state.isConnected !== false))
}
