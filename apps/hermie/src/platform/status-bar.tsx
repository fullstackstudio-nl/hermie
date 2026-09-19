/**
 * The system status bar's ink, following the app's own appearance.
 *
 * iOS infers it from the view controller and Android does not: the window
 * starts with `windowLightStatusBar` unset (white icons), and edge-to-edge —
 * on by default since Expo SDK 54 — makes the bar transparent, so those white
 * icons land straight on Hermie's own background. On the light theme (#F2F2F7)
 * the clock, the battery and the signal bars simply disappear.
 *
 * It is driven by the resolved theme rather than by the system scheme, so a
 * reader who pinned the app to Light while the phone is Dark gets the ink the
 * APP is painting under, not the one the phone would have chosen.
 */
import { StatusBar } from 'expo-status-bar'

export function AppStatusBar({ scheme }: { scheme: 'light' | 'dark' }) {
  // `expo-status-bar`'s `style` is the ink, not the background: a dark app
  // needs light icons.
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
}
