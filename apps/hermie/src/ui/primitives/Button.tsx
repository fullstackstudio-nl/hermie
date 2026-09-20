import { ActivityIndicator, Pressable, type PressableProps, View } from 'react-native'

import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT, withAlpha } from '../tokens'
import { Text } from './Text'

export type ButtonProps = Omit<PressableProps, 'children'> & {
  title: string
  variant?: 'primary' | 'secondary' | 'danger'
  /** Shows a spinner in place of the title and blocks presses. */
  busy?: boolean
}

export function Button({ title, variant = 'primary', busy = false, disabled, style, ...rest }: ButtonProps) {
  const theme = useTheme()
  const inactive = Boolean(disabled) || busy

  // `danger` is a TINT here, not the solid fill (§3's `.btn--danger`). A sheet
  // whose four answers include one saturated red block reads as a warning about
  // itself and fights its own primary; the readable ink beside the tint is
  // `dangerText`, which is the whole reason those two roles are separate.
  const background =
    variant === 'primary' ? theme.colors.accent : variant === 'danger' ? theme.dangerSoft : theme.elevation.e3c
  const label = variant === 'primary' ? 'onAccent' : variant === 'danger' ? 'dangerText' : 'text'
  const border = variant === 'primary' ? null : variant === 'danger' ? theme.colors.danger : theme.hairline

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      style={style}
      {...rest}
    >
      {({ pressed }) => (
        <View
          style={{
            backgroundColor: background,
            borderRadius: theme.radii.inset,
            borderWidth: border ? 1 : 0,
            // The danger tint's own edge is the danger colour at low alpha: the
            // tint alone is too faint to read as a button on a light sheet.
            borderColor: border === theme.colors.danger ? withAlpha(theme.colors.danger, 0.34) : (border ?? undefined),
            minHeight: CONTROL_MIN_HEIGHT,
            paddingVertical: theme.space.md,
            paddingHorizontal: theme.space.lg,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: inactive ? 0.4 : pressed ? 0.85 : 1
          }}
        >
          {busy ? (
            <ActivityIndicator color={variant === 'primary' ? theme.colors.onAccent : theme.colors.text} />
          ) : (
            <Text variant="name" color={label}>
              {title}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  )
}
