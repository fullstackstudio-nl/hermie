import { forwardRef } from 'react'
import { TextInput, type TextInputProps, View } from 'react-native'

import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'
import { useInsetRow } from './InsetGroup'
import { Text } from './Text'

export type TextFieldProps = TextInputProps & {
  /** Quiet label above the input, inside the row. */
  label?: string
  /** Shown under the input in the danger colour; also marks the input invalid. */
  error?: string | null
}

/**
 * The app's one text field.
 *
 * It draws the sunk well the design board gives every editable thing — a level
 * tint, a hairline and the inset radius — because without it a field on a sheet
 * is placeholder text floating on glass, which is exactly how the cron editor's
 * Name, Instructions and Every fields read on a device. The hairline is the part
 * that says "editable": the tint alone is nearly invisible on the light panel.
 *
 * Inside an `InsetRow` it draws none of that, because the row IS the chrome and
 * two boxes around one input is worse than none. That is read from the row
 * rather than passed, so a caller cannot forget it in either direction.
 *
 * A plain `TextInput` underneath — no masking, no formatting — so every caller
 * keeps control of `autoCapitalize`, `keyboardType` and `textContentType`, which
 * the platform uses to decide what keyboard and which autofill to offer.
 */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, style, ...rest },
  ref
) {
  const theme = useTheme()
  const inset = useInsetRow()

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
          inset
            ? null
            : {
                backgroundColor: theme.tintSunk,
                borderColor: error ? theme.colors.danger : theme.hairline,
                borderRadius: theme.radii.inset,
                borderWidth: 1,
                minHeight: CONTROL_MIN_HEIGHT - theme.space.sm,
                paddingHorizontal: theme.space.sm,
                paddingVertical: theme.space.sm
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
