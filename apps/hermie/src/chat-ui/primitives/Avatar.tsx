/**
 * The circular initial the design board uses wherever a bot appears.
 *
 * The tint is derived from the name, so a bot keeps the same colour in the
 * chat list, the header and a forwarded DM without anyone persisting one.
 */
import { View, type ViewStyle } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { initialFor, tintIndex } from '../format'

const LIGHT_TINTS = [
  { background: '#DCEBFC', foreground: '#175B9E' },
  { background: '#E9DFFA', foreground: '#6A4494' },
  { background: '#DDEEE9', foreground: '#25624C' },
  { background: '#F7E8D5', foreground: '#825321' }
]

const DARK_TINTS = [
  { background: '#173049', foreground: '#9FCBF5' },
  { background: '#2C2140', foreground: '#CBB0F0' },
  { background: '#173029', foreground: '#8FD4B5' },
  { background: '#3A2A16', foreground: '#EEC79A' }
]

export interface AvatarProps {
  name: string
  size?: number
  style?: ViewStyle
}

export function Avatar({ name, size = 40, style }: AvatarProps) {
  const theme = useTheme()
  const palette = theme.scheme === 'dark' ? DARK_TINTS : LIGHT_TINTS
  const tint = palette[tintIndex(name, palette.length)] ?? palette[0]

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          alignItems: 'center',
          backgroundColor: tint?.background,
          borderRadius: size / 2,
          height: size,
          justifyContent: 'center',
          width: size
        },
        style
      ]}
    >
      <Text style={{ color: tint?.foreground, fontSize: Math.round(size * 0.44), fontWeight: '600' }}>
        {initialFor(name)}
      </Text>
    </View>
  )
}
