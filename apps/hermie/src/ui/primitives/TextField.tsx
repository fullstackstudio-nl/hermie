import { forwardRef } from 'react'
import { TextInput, type TextInputProps, View } from 'react-native'

import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'
import { Text } from './Text'

export type TextFieldProps = TextInputProps & {
  /** Quiet label above the input, inside the row. */
  label?: string
  /** Shown under the input in the danger colour; also marks the input invalid. */
  error?: string | null
}

/**
 * A text input sized and coloured for an inset grouped form. It is a plain
 * `TextInput` underneath — no masking, no formatting — so every caller keeps
 * control of `autoCapitalize`, `keyboardType` and `textContentType`, which the
 * platform uses to decide what keyboard and which autofill to offer.
 */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, style, ...rest },
  ref
) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.xxs }}>
      {label ? (
        <Text variant="meta" color="textMuted">
          {label}
        </Text>
      ) : null}
      <TextInput
        ref={ref}
        accessibilityLabel={label ?? rest.accessibilityLabel ?? rest.placeholder ?? ''}
        placeholderTextColor={theme.colors.textMuted}
        style={[
          {
            color: theme.colors.text,
            fontSize: theme.type.body.fontSize,
            lineHeight: theme.type.body.lineHeight,
            minHeight: CONTROL_MIN_HEIGHT - theme.space.lg,
            paddingVertical: theme.space.xs
          },
          style
        ]}
        {...rest}
      />
      {error ? (
        <Text variant="meta" color="dangerText">
          {error}
        </Text>
      ) : null}
    </View>
  )
})
