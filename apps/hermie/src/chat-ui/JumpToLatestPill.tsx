/**
 * The floating pill that appears once the transcript is scrolled away from the
 * bottom, carrying the count of messages that arrived meanwhile.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { chatStrings } from './strings'

export interface JumpToLatestPillProps {
  onPress: () => void
  /** Messages that arrived while you were reading further up. */
  count?: number
  testID?: string
}

export function JumpToLatestPill({ onPress, count = 0, testID = 'jump-to-latest' }: JumpToLatestPillProps) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityLabel={
        count > 0
          ? `${chatStrings.transcript.jumpToLatest}, ${chatStrings.transcript.newMessages(count)}`
          : chatStrings.transcript.jumpToLatest
      }
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: 'center', opacity: pressed ? 0.8 : 1 })}
      testID={testID}
    >
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.colors.bubbleBlue,
          borderRadius: theme.radii.pill,
          flexDirection: 'row',
          gap: theme.space.xs,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm
        }}
      >
        <Text color="onAccent" style={{ fontSize: 13 }}>
          {'↓'}
        </Text>
        <Text color="onAccent" style={{ fontSize: 13, fontWeight: '600' }}>
          {count > 0 ? chatStrings.transcript.newMessages(count) : chatStrings.transcript.jumpToLatest}
        </Text>
      </View>
    </Pressable>
  )
}
