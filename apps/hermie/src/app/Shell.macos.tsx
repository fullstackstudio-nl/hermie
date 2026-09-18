import { RegularShell } from './RegularShell'

// macOS is always the sidebar-plus-detail layout, so the compact shell — and with
// it react-native-screens, which has no macOS slice — stays out of the bundle.
export function Shell() {
  return <RegularShell />
}
