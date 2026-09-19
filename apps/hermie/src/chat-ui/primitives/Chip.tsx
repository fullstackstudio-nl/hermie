/**
 * The small rounded label the transcript uses for a demoted item.
 *
 * `showBotToBot: false` never removes a DM — it collapses it to one of these,
 * because a bot's reply to a message you cannot see is unexplainable.
 */
import type { ReactNode } from 'react'
import { Pressable, View, type ViewStyle } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { ColorRole } from '../../ui/tokens'

export interface ChipProps {
  label: string
  tone?: ColorRole
  leading?: ReactNode
  onPress?: () => void
  /** Centres the chip in the transcript, the way a system notice sits. */
  centered?: boolean
  style?: ViewStyle
  testID?: string
}

export function Chip({ label, tone = 'textMuted', leading, onPress, centered = false, style, testID }: ChipProps) {
  const theme = useTheme()

  const body = (
    <View
      style={[
        {
          alignItems: 'center',
          alignSelf: centered ? 'center' : 'flex-start',
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: theme.radii.pill,
          flexDirection: 'row',
          gap: theme.space.xs,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.xs
        },
        style
      ]}
    >
      {leading}
      <Text color={tone} variant="caption">
        {label}
      </Text>
    </View>
  )

  if (!onPress) {
    return body
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: centered ? 'center' : 'flex-start', opacity: pressed ? 0.6 : 1 })}
      testID={testID}
    >
      {body}
    </Pressable>
  )
}
