/**
 * An inbound bot-to-bot message.
 *
 * §6.6: incoming bot messages KEEP a tinted bubble — they start a turn in this
 * chat, so they are speech — with a `Writer · bot` chip, and they gain an
 * `↩ answered` marker once this bot has replied to them.
 *
 * The violet tint is not decoration: this is a `role:user` row that is not the
 * human speaking, and the distinction is too important to leave to the reader's
 * memory of who they were talking to.
 */
import { View } from 'react-native'

import { Markdown, markdownLeading } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Bubble, useBubbleContentWidth } from './primitives/Bubble'
import { Chip } from './primitives/Chip'
import { Fold, useFoldBlocks } from './primitives/Fold'
import { MetaLine } from './primitives/MetaLine'
import { useExpanded } from './expanded'
import { formatClock, needsReadingTreatment } from './format'
import { chatStrings } from './strings'
import type { DmCounterpartQuery } from './TranscriptList'
import type { BotDmInItem, Presentation } from './types'

export interface BotDmInBubbleProps {
  item: BotDmInItem
  presentation?: Presentation
  /** The handle of the bot whose chat this is, for the `@a → @b` line. */
  selfHandle?: string
  /**
   * This bot has replied to it.
   *
   * Only the caller can know: the answer is a later assistant item, and the
   * bubble cannot see its own neighbours.
   */
  answered?: boolean
  /** The ONE place this row navigates, if the caller offers it at all. */
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  onLinkPress?: (href: string) => void
  tail?: boolean
  grouped?: boolean
}

export function BotDmInBubble({
  item,
  presentation = 'full',
  selfHandle,
  answered = false,
  onOpenBot,
  onLinkPress,
  tail = true,
  grouped = false
}: BotDmInBubbleProps) {
  const theme = useTheme()
  const foldBlocks = useFoldBlocks()
  const [expanded, toggle] = useExpanded(item.id)
  // Above the early returns, because a hook cannot sit below one.
  const reading = needsReadingTreatment(item.text)
  const contentWidth = useBubbleContentWidth(reading)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const handle = item.senderHandle ?? item.senderName.toLowerCase()

  if (presentation === 'chip') {
    return (
      <Chip
        centered
        label={chatStrings.botDm.inChip(item.senderName)}
        // The far side of an inbound message is the sender's own OUTBOUND dispatch.
        onPress={
          onOpenBot
            ? () => onOpenBot(handle, { kind: 'bot_dm_out', ...(item.ts ? { at: item.ts } : {}), text: item.text })
            : undefined
        }
        testID={`bot-dm-in-chip-${item.id}`}
      />
    )
  }

  const time = formatClock(item.ts)
  const variant = reading ? 'dmRead' : 'dm'
  const recipe = theme.bubbles[variant]

  return (
    <Bubble
      grouped={grouped}
      meta={
        <MetaLine
          {...(answered ? { marker: chatStrings.botDm.answered } : {})}
          testID={`bot-dm-in-meta-${item.id}`}
          time={time}
        />
      }
      side="other"
      tail={tail}
      testID={`bot-dm-in-${item.id}`}
      variant={variant}
    >
      {grouped ? null : (
        <View style={{ gap: 1, marginBottom: theme.space.xs }} testID={`bot-dm-in-header-${item.id}`}>
          <Text color="accentText" variant="micro">
            {chatStrings.botDm.senderChip(item.senderName).toUpperCase()}
          </Text>
          {selfHandle ? (
            <Text color="textFaint" variant="micro">
              {chatStrings.botDm.header(handle, selfHandle)}
            </Text>
          ) : null}
        </View>
      )}

      <Fold
        blocks={foldBlocks.blocks}
        bleed={reading ? theme.space.lg : theme.space.md + 2}
        expanded={expanded}
        fadeTo={recipe.tail}
        lineHeight={markdownLeading(theme.type.body.fontSize)}
        onToggle={toggle}
        testID={`bot-dm-in-fold-${item.id}`}
      >
        <Markdown
          fadeTo={recipe.tail}
          fontSize={theme.type.body.fontSize}
          linkColor={theme.accent().text}
          maxContentWidth={contentWidth}
          onBlockLayout={foldBlocks.onBlockLayout}
          onLinkPress={onLinkPress}
          text={item.text}
        />
      </Fold>
    </Bubble>
  )
}
