/**
 * The human's own turn: right-aligned, blue, white text, tail, timestamp, and
 * — under the last one only — a delivery receipt.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Bubble } from './primitives/Bubble'
import { Chip } from './primitives/Chip'
import { formatClock } from './format'
import { chatStrings } from './strings'
import type { Presentation, Receipt, UserItem } from './types'

export interface UserBubbleProps {
  item: UserItem
  presentation?: Presentation
  /** The receipt line under the bubble; only the last own bubble gets one. */
  receipt?: Receipt
  /** Last bubble of a run — the one that carries the tail. */
  tail?: boolean
}

export function UserBubble({ item, presentation = 'full', receipt, tail = true }: UserBubbleProps) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return <Chip label={item.text} style={{ alignSelf: 'flex-end' }} />
  }

  const time = formatClock(item.ts)

  return (
    <View style={{ marginBottom: theme.space.sm, marginTop: theme.space.md }}>
      <Bubble background={theme.colors.bubbleBlue} side="own" tail={tail}>
        <Text color="onAccent" selectable style={{ fontSize: 17, lineHeight: 24 }}>
          {item.text}
        </Text>

        {item.attachments?.length ? (
          <Text color="onAccent" style={{ fontSize: 12, marginTop: theme.space.xs, opacity: 0.85 }}>
            {item.attachments.join(' · ')}
          </Text>
        ) : null}

        {time ? (
          <Text color="onAccent" style={{ fontSize: 11, marginTop: theme.space.xs, opacity: 0.8, textAlign: 'right' }}>
            {time}
          </Text>
        ) : null}
      </Bubble>

      {receipt ? (
        <Text
          color="textMuted"
          style={{ fontSize: 11, marginRight: theme.space.xs, marginTop: theme.space.xs, textAlign: 'right' }}
        >
          {`${chatStrings.receipt[receipt]}${time ? ` ${time}` : ''}`}
        </Text>
      ) : null}
    </View>
  )
}
