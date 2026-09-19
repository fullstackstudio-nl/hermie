/**
 * How a `KeyboardAvoidingView` should behave on this platform.
 *
 * `padding` on Android too, deliberately. The old `Platform.OS === 'ios' ?
 * 'padding' : undefined` leaned on `android:windowSoftInputMode="adjustResize"`
 * to lift the window, and under the edge-to-edge layout Expo SDK 54 turns on by
 * default that resize no longer happens: the window frame stays the full screen
 * with the keyboard up, so nothing moved and the composer sat behind the
 * keyboard. `padding` makes React Native do the work itself, from the
 * `keyboardDidShow` metrics, which arrive on both platforms.
 *
 * macOS has no soft keyboard at all; there the view is inert either way, and
 * `undefined` keeps it that way.
 */
import { Platform } from 'react-native'

export const KEYBOARD_AVOID_BEHAVIOR: 'padding' | undefined = Platform.OS === 'macos' ? undefined : 'padding'
