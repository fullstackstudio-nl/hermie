/**
 * @react-native-community/netinfo is not linked on macOS: its podspec declares
 * an `:osx` platform but Expo's autolinking resolver does not produce a macOS
 * pod for it, so `NativeModule.RNCNetInfo` is null and merely importing the
 * package throws on startup.
 *
 * A Mac is treated as permanently online instead. That is not a loss: the
 * offline state exists to stop a phone burning battery on the dial ladder while
 * it has no signal, and a dropped link on a desktop is already handled by the
 * connection's own reconnect ladder.
 */
export function subscribeToConnectivity(handler: (online: boolean) => void): () => void {
  handler(true)

  return () => undefined
}
