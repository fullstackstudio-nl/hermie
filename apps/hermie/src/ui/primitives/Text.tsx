import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native'

import { useTheme } from '../theme'
import type { ColorRole, TypeToken } from '../tokens'

export type TextProps = RNTextProps & {
  variant?: TypeToken
  color?: ColorRole
}

export function Text({ variant = 'body', color = 'text', style, ...rest }: TextProps) {
  const theme = useTheme()
  const token = theme.type[variant]

  const base: TextStyle = {
    fontSize: token.fontSize,
    lineHeight: token.lineHeight,
    fontWeight: token.fontWeight,
    color: theme.colors[color]
  }

  return <RNText {...rest} style={[base, style]} />
}
