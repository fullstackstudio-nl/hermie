/**
 * An outgoing bot-to-bot message, as a LINE.
 *
 * §6.6, and the sentence that decides the whole shape: *collapsed outgoing is a
 * line, not a bubble and not a pill.* An arrow glyph, `Message to @writer`, a
 * one-line truncated preview, the time, and at the right a reply indicator that is
 * ALWAYS present — replied, waiting, or failed.
 *
 * Two behaviours the previous build got wrong and that are the point of this
 * rewrite:
 *
 *  - **Tapping expands the exchange in place.** It used to navigate to the other
 *    bot's chat and scroll it to the matching row. That is a reasonable thing to
 *    be able to do and a terrible thing for a tap to do by default: the reader
 *    loses the conversation they were reading to see a message they were already
 *    looking at. Navigation now lives behind one explicit secondary link,
 *    `Open @writer's chat`, and nowhere else.
 *  - **Nothing animates.** The old card breathed while a delivery was in flight.
 *    §5: the `Delivered · waiting for reply` marker and every other status
 *    indicator are static, and waiting uses a hollow dot rather than a blink.
 */
import { Pressable, View } from 'react-native'

import { Markdown } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP, type ColorRole } from '../ui/tokens'
import { GlassSurface } from '../ui/glass'
import { hasReply } from './dm-rollup'
import { useExpanded } from './expanded'
import { clipInline, formatClock } from './format'
import { chatStrings } from './strings'
import { Chip } from './primitives/Chip'
import type { DmCounterpartQuery } from './TranscriptList'
import type { BotDmOutItem, DispatchStatus, Presentation } from './types'

export interface BotDmOutLineProps {
  item: BotDmOutItem
  presentation?: Presentation
  /**
   * The ONE place a DM line navigates: the secondary link, not the row.
   *
   * It still carries the counterpart query, so the far chat lands on the matching
   * inbound row rather than at its bottom. What §6.6 removed is navigation as the
   * DEFAULT gesture, not the ability to land somewhere useful once asked.
   */
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  /** Links inside an expanded reply. */
  onLinkPress?: (href: string) => void
  /**
   * The recipient's chat is live and its turn is running RIGHT NOW.
   *
   * Only a caller that holds both chats can know this — the dispatch itself says
   * nothing about what happened to it. It refines the WAITING marker rather than
   * adding a fourth one: "@writer is writing…" is still a static statement about
   * a delivery that has not come back, which is what §6.6's third row is.
   */
  targetTyping?: boolean
  testID?: string
}

type Marker = { label: string; tone: ColorRole; hollow: boolean }

/**
 * The reply indicator, which is never absent.
 *
 * A line with nothing on its right would read as "delivered and answered", which
 * is the one state the reader cannot verify. Three outcomes, three shapes.
 */
export function markerFor(item: BotDmOutItem, targetTyping = false): Marker {
  if (item.dispatch.status === 'failed' || item.reply?.error) {
    return { hollow: false, label: chatStrings.botDm.marker.failed, tone: 'dangerText' }
  }

  if (hasReply(item)) {
    return { hollow: false, label: chatStrings.botDm.marker.replied, tone: 'accentText' }
  }

  if (targetTyping) {
    return { hollow: true, label: chatStrings.botDm.targetTyping(item.targetHandle || item.target), tone: 'textFaint' }
  }

  return { hollow: true, label: chatStrings.botDm.marker.waiting, tone: 'textFaint' }
}

function statusLabel(status: DispatchStatus): string {
  switch (status) {
    case 'sending':
      return chatStrings.botDm.sending
    case 'queued':
      return chatStrings.botDm.queued
    case 'failed':
      return chatStrings.botDm.failed
    case 'ambiguous':
      return chatStrings.botDm.ambiguous
    default:
      return chatStrings.botDm.unknown
  }
}

/**
 * What to look for on the far side of this dispatch.
 *
 * The far side is an INBOUND row in the target's chat carrying the same body; the
 * stamp is close but never identical, because the delivery process queues between
 * the two.
 */
function counterpart(item: BotDmOutItem): DmCounterpartQuery {
  return { kind: 'bot_dm_in', ...(item.ts ? { at: item.ts } : {}), text: item.message }
}

/** A still, hollow dot. The shape §5 gives to waiting, instead of motion. */
function HollowDot({ color }: { color: string }) {
  return <View style={{ borderColor: color, borderRadius: 4, borderWidth: 1.5, height: 8, width: 8 }} />
}

export function BotDmOutLine({
  item,
  presentation = 'collapsed',
  onOpenBot,
  onLinkPress,
  targetTyping = false,
  testID
}: BotDmOutLineProps) {
  const theme = useTheme()
  const [expanded, toggle] = useExpanded(item.id)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const handle = item.targetHandle || item.target

  if (presentation === 'chip') {
    return (
      <Chip
        centered
        label={chatStrings.botDm.chip(item.target)}
        onPress={onOpenBot ? () => onOpenBot(handle, counterpart(item)) : undefined}
        testID={`bot-dm-out-chip-${item.id}`}
      />
    )
  }

  const marker = markerFor(item, targetTyping)
  const time = formatClock(item.ts)
  // Short. On a phone the row holds four things and the marker is the one that
  // must survive intact — a quoted reply that squeezes `Message to @writer` down
  // to "Ca…" has taken the row's whole point with it.
  const replyPreview = hasReply(item) ? clipInline(item.reply?.text ?? '', 18) : ''

  return (
    <View style={{ gap: theme.space.xs }} testID={testID ?? `bot-dm-out-${item.id}`}>
      <Pressable
        accessibilityHint={chatStrings.botDm.lineTo(handle)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        hitSlop={TAP_SLOP}
        onPress={toggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        testID={`bot-dm-out-line-${item.id}`}
      >
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, minHeight: 24 }}>
          <Text color="textFaint" style={{ fontSize: 12, lineHeight: 16 }}>
            {'→'}
          </Text>

          <Text color="textMuted" numberOfLines={1} style={{ flexShrink: 0 }} variant="meta">
            {chatStrings.botDm.lineTo(handle)}
          </Text>

          {/* The message preview is the one part the row can afford to lose: it
              is a truncation of text the expanded card shows in full. It yields
              first, and `minWidth: 0` is what lets it actually shrink inside a
              row rather than forcing the row wider. */}
          <Text
            color="textFaint"
            numberOfLines={1}
            style={{ flexGrow: 1, flexShrink: 100, minWidth: 0 }}
            variant="meta"
          >
            {clipInline(item.message, 60)}
          </Text>

          {time ? (
            <Text color="textFaint" numberOfLines={1} style={{ flexShrink: 0 }} variant="meta">
              {time}
            </Text>
          ) : null}

          {marker.hollow ? <HollowDot color={theme.colors.textFaint} /> : null}

          <Text
            color={marker.tone}
            numberOfLines={1}
            style={{ flexShrink: 1 }}
            testID={targetTyping && marker.hollow ? `bot-dm-out-typing-${item.id}` : undefined}
            variant="meta"
          >
            {replyPreview ? `${marker.label} · “${replyPreview}”` : marker.label}
          </Text>
        </View>
      </Pressable>

      {expanded ? (
        <GlassSurface
          contentStyle={{ gap: theme.space.sm, padding: theme.space.md }}
          testID={`bot-dm-out-expanded-${item.id}`}
          variant="card"
        >
          <Text color="textFaint" variant="micro">
            {chatStrings.botDm.sent.toUpperCase()}
          </Text>
          <Text color="text" selectable variant="preview">
            {item.message}
          </Text>

          <Text color={item.dispatch.status === 'failed' ? 'dangerText' : 'textFaint'} variant="meta">
            {statusLabel(item.dispatch.status)}
          </Text>

          {item.dispatch.error ? (
            <Text color="dangerText" variant="meta">
              {item.dispatch.error}
            </Text>
          ) : null}

          {item.reply ? (
            <View style={{ gap: theme.space.xs }}>
              <Text color="textFaint" variant="micro">
                {chatStrings.botDm.reply.toUpperCase()}
              </Text>

              {item.reply.error ? (
                <Text color="dangerText" variant="preview">
                  {item.reply.error}
                </Text>
              ) : (
                // The reply is markdown the other bot wrote, so it is rendered as
                // markdown rather than shown as characters.
                <Markdown
                  fontSize={theme.type.preview.fontSize}
                  linkColor={theme.accent().text}
                  onLinkPress={onLinkPress}
                  text={item.reply.text}
                />
              )}
            </View>
          ) : null}

          {onOpenBot ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={TAP_SLOP}
              onPress={() => onOpenBot(handle, counterpart(item))}
              testID={`bot-dm-out-open-${item.id}`}
            >
              <Text color="accentText" variant="meta">
                {chatStrings.botDm.openChat(handle)}
              </Text>
            </Pressable>
          ) : null}
        </GlassSurface>
      ) : null}
    </View>
  )
}
