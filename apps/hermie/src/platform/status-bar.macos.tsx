/**
 * macOS has no app-controlled status bar, and `expo-status-bar` has no macOS
 * slice — importing it there would fail at module scope the way
 * `@react-native-community/netinfo` does. The menu bar belongs to the system.
 */
export function AppStatusBar(_props: { scheme: 'light' | 'dark' }) {
  return null
}
