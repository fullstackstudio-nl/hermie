/**
 * The pinned bar under the chat header: "3 agents working · 1m 12s".
 *
 * It lives at the TOP of the transcript, not above the composer, because that
 * is where the design board pins it and because a bar that moves with the
 * composer fights the keyboard.
 */
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { formatDuration } from './format'
import { chatStrings } from './strings'

export interface AgentsBarProps {
  /** How many children are queued or running. Zero hides the bar. */
  count: number
  /**
   * Epoch MILLISECONDS the oldest running child started; the bar ticks from it.
   *
   * Named for its unit on purpose. `Subagent.startedAt` is milliseconds — the
   * agents sheet already treats it as such — and this prop used to be seconds,
   * so the screen handed it a number a thousand times too large and the clock
   * read `0s` for the whole run.
   */
  startedAtMs?: number
  /** Overrides the ticking clock — the gallery and the tests pass a fixed value. */
  elapsedSeconds?: number
  onPress: () => void
  testID?: string
}

export function AgentsBar({ count, startedAtMs, elapsedSeconds, onPress, testID = 'agents-bar' }: AgentsBarProps) {
  const theme = useTheme()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (elapsedSeconds !== undefined || !startedAtMs || count === 0) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [count, elapsedSeconds, startedAtMs])

  if (count <= 0) {
    return null
  }

  const elapsed = elapsedSeconds ?? (startedAtMs ? Math.max(0, (now - startedAtMs) / 1000) : 0)

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      testID={testID}
    >
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.elevation.e3c,
          borderBottomColor: theme.hairline,
          borderBottomWidth: 1,
          flexDirection: 'row',
          gap: theme.space.sm,
          minHeight: 42,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm
        }}
      >
        <Text color="accent" style={{ flex: 1, fontSize: 13, fontWeight: '600' }}>
          {chatStrings.subagents.working(count, formatDuration(elapsed) || '0s')}
        </Text>
        <Text color="accent" style={{ fontSize: 15 }}>
          {'⌄'}
        </Text>
      </View>
    </Pressable>
  )
}
