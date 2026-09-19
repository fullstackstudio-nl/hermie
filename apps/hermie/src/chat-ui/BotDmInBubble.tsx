/**
 * An inbound bot-to-bot message.
 *
 * Violet rather than grey, with an explicit sender chip: this row is a
 * `role:user` row that is NOT the human speaking, and the design board gives it
 * its own colour so that distinction is never left to the reader's memory.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Bubble } from './primitives/Bubble'
import { Chip } from './primitives/Chip'
import { formatClock } from './format'
import { chatStrings } from './strings'
import type { DmCounterpartQuery } from './TranscriptList'
import type { BotDmInItem, Presentation } from './types'

export interface BotDmInBubbleProps {
  item: BotDmInItem
  presentation?: Presentation
  /** The handle of the bot whose chat this is, for the `@a → @b` header. */
  selfHandle?: string
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
}

export function BotDmInBubble({ item, presentation = 'full', selfHandle, onOpenBot }: BotDmInBubbleProps) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const handle = item.senderHandle ?? item.senderName.toLowerCase()
  // The far side of an inbound message is the sender's own OUTBOUND dispatch.
  const open = () => onOpenBot?.(handle, { kind: 'bot_dm_out', ...(item.ts ? { at: item.ts } : {}), text: item.text })

  if (presentation === 'chip') {
    return (
      <Chip
        centered
        label={chatStrings.botDm.inChip(item.senderName)}
        onPress={onOpenBot ? open : undefined}
        testID={`bot-dm-in-chip-${item.id}`}
      />
    )
  }

  const time = formatClock(item.ts)
  const header = selfHandle ? chatStrings.botDm.header(handle, selfHandle) : `@${handle}`

  return (
    <View style={{ marginVertical: theme.space.sm }}>
      <Bubble background={theme.colors.incoming} side="other" tail>
        <Pressable
          accessibilityHint={onOpenBot ? chatStrings.botDm.openSender(item.senderName) : undefined}
          accessibilityRole={onOpenBot ? 'button' : undefined}
          disabled={!onOpenBot}
          onPress={onOpenBot ? open : undefined}
          testID={`bot-dm-in-header-${item.id}`}
        >
          <Text style={{ color: theme.colors.incomingText, fontSize: 12, fontWeight: '700' }}>
            {chatStrings.botDm.senderChip(item.senderName)}
          </Text>
          <Text style={{ color: theme.colors.incomingText, fontSize: 11, opacity: 0.85 }}>{header}</Text>
        </Pressable>

        <Text selectable style={{ color: theme.colors.text, fontSize: 17, lineHeight: 24, marginTop: theme.space.sm }}>
          {item.text}
        </Text>

        {time ? (
          <Text color="textMuted" style={{ fontSize: 11, marginTop: theme.space.xs, textAlign: 'right' }}>
            {time}
          </Text>
        ) : null}
      </Bubble>
    </View>
  )
}
