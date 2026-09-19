/**
 * A text field for a value that should not sit on screen in plain sight — a
 * session token, a proxy header's value.
 *
 * It exists because of one platform fact, documented in `docs/platform-notes.md`:
 * **on react-native-macos a `secureTextEntry` `TextInput` renders the dots but
 * never fires `onChangeText`.** The keystrokes arrive — the same field without
 * masking records them — so the draft stays empty, "Continue" stays disabled,
 * and onboarding cannot be finished on macOS at all. Masking is therefore off
 * on macOS, and the "Show token" toggle is offered everywhere so the choice is
 * the user's rather than the platform's.
 *
 * The toggle is a `Pressable`, not an icon button: macOS has no vector icon set
 * in this app, and a word is unambiguous in a form.
 */
import { forwardRef, useState } from 'react'
import { Platform, Pressable, type TextInput, View } from 'react-native'

import { useTheme } from '../theme'
import { Text } from './Text'
import { TextField, type TextFieldProps } from './TextField'

export type SecretFieldProps = Omit<TextFieldProps, 'secureTextEntry'> & {
  /** Label for the reveal control, e.g. "Show token". */
  revealLabel: string
  /** Label once revealed, e.g. "Hide token". */
  concealLabel: string
}

/**
 * True when this platform can be trusted to mask and still report typing.
 * macOS cannot; see the note above.
 */
export const SECURE_TEXT_ENTRY_SUPPORTED = Platform.OS !== 'macos'

export const SecretField = forwardRef<TextInput, SecretFieldProps>(function SecretField(
  { revealLabel, concealLabel, ...rest },
  ref
) {
  const theme = useTheme()
  const [revealed, setRevealed] = useState(!SECURE_TEXT_ENTRY_SUPPORTED)

  const masked = SECURE_TEXT_ENTRY_SUPPORTED && !revealed

  return (
    <View style={{ gap: theme.space.xs }}>
      <TextField {...rest} ref={ref} secureTextEntry={masked} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ checked: revealed }}
        hitSlop={8}
        onPress={() => setRevealed(current => !current)}
        style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
        testID={rest.testID ? `${rest.testID}-reveal` : 'secret-reveal'}
      >
        <Text color="accent" variant="caption">
          {revealed ? concealLabel : revealLabel}
        </Text>
      </Pressable>
    </View>
  )
})
