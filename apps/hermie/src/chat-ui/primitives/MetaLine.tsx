/**
 * The metadata line under a bubble's body: the clock, and on the owner's own
 * last bubble the delivery ticks.
 *
 * It sits INSIDE the bubble on the sender's side, which is what the mockup draws
 * and what keeps a one-word message from being twice as tall as its text. The
 * receipt's WORD is not repeated next to the tick — the tick is the word, and
 * `Delivered ✓` on every bubble is noise — but the accessibility label says it,
 * because a tick is not readable.
 */
import { View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { chatStrings } from '../strings'
import type { Receipt } from '../types'
import { Ticks } from './Ticks'

export interface MetaLineProps {
  time: string
  /** Only the last own bubble carries one. */
  receipt?: Receipt
  /** True inside an outgoing bubble, where the ink is white. */
  onAccent?: boolean
  /** A trailing marker the mockup puts on this line: `↩ answered`. */
  marker?: string
  testID?: string
}

export function MetaLine({ time, receipt, onAccent = false, marker, testID }: MetaLineProps) {
  const theme = useTheme()

  if (!time && !receipt && !marker) {
    return null
  }

  const ink = onAccent ? theme.colors.onAccent : theme.colors.textFaint

  return (
    <View
      accessibilityLabel={receipt ? `${time} ${chatStrings.receipt[receipt]}` : undefined}
      style={{
        alignItems: 'center',
        alignSelf: 'flex-end',
        flexDirection: 'row',
        gap: theme.space.xs,
        marginTop: theme.space.xs
      }}
      testID={testID}
    >
      {marker ? (
        <Text style={{ color: ink, opacity: onAccent ? 0.85 : 1 }} variant="meta">
          {marker}
        </Text>
      ) : null}

      {time ? (
        <Text style={{ color: ink, opacity: onAccent ? 0.85 : 1 }} variant="meta">
          {time}
        </Text>
      ) : null}

      {receipt ? <Ticks color={ink} receipt={receipt} /> : null}
    </View>
  )
}
