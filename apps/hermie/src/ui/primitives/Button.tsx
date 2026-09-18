import { Pressable, type PressableProps, View } from 'react-native'

import { useTheme } from '../theme'
import { Text } from './Text'

export type ButtonProps = Omit<PressableProps, 'children'> & {
  title: string
  variant?: 'primary' | 'secondary' | 'danger'
}

export function Button({ title, variant = 'primary', disabled, style, ...rest }: ButtonProps) {
  const theme = useTheme()

  const background =
    variant === 'primary' ? theme.colors.accent : variant === 'danger' ? theme.colors.danger : theme.colors.surface
  const label = variant === 'secondary' ? 'text' : 'bg'

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      style={style}
      {...rest}
    >
      {({ pressed }) => (
        <View
          style={{
            backgroundColor: background,
            borderRadius: theme.radii.md,
            borderWidth: variant === 'secondary' ? 1 : 0,
            borderColor: theme.colors.border,
            paddingVertical: theme.space.md,
            paddingHorizontal: theme.space.lg,
            alignItems: 'center',
            opacity: disabled ? 0.4 : pressed ? 0.8 : 1
          }}
        >
          <Text variant="heading" color={label}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  )
}
