import { ActivityIndicator, Pressable, type PressableProps, View } from 'react-native'

import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'
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

  // `bubbleBlue` rather than `accent`: the accent is for links and focus rings,
  // and the filled action shade is the deeper one that keeps white text at AA.
  const background =
    variant === 'primary' ? theme.colors.bubbleBlue : variant === 'danger' ? theme.colors.danger : theme.colors.surface
  const label = variant === 'secondary' ? 'text' : 'onAccent'

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
            borderRadius: theme.radii.lg,
            borderWidth: variant === 'secondary' ? 1 : 0,
            borderColor: theme.colors.border,
            minHeight: CONTROL_MIN_HEIGHT,
            paddingVertical: theme.space.md,
            paddingHorizontal: theme.space.lg,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: inactive ? 0.4 : pressed ? 0.85 : 1
          }}
        >
          {busy ? (
            <ActivityIndicator color={variant === 'secondary' ? theme.colors.text : theme.colors.onAccent} />
          ) : (
            <Text variant="heading" color={label}>
              {title}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  )
}
