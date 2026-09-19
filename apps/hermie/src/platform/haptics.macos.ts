/**
 * A Mac has no Taptic engine under the cursor, and `expo-haptics` ships no
 * macOS slice — importing it there would fail the same way `@react-native-
 * community/netinfo` does (see `net-info.macos.ts`).
 *
 * The type is declared here rather than re-exported from `./haptics`: inside a
 * `.macos` file that specifier resolves back to this file, so a value re-export
 * would be a self-referencing getter. See "Platform-variant modules resolve to
 * themselves" in `docs/platform-notes.md`.
 */
export type HapticMoment = 'send' | 'choice' | 'complete'

export function haptic(_moment: HapticMoment): void {
  // Nothing to buzz.
}
