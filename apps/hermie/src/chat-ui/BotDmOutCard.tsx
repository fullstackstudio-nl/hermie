/**
 * An outbound `message_agent` call, drawn as a forwarded quote block.
 *
 * `message_agent` is fire-and-forget: the call returns `queued` and the answer
 * arrives much later as a separate row. The card therefore has two halves — the
 * dispatch and, once it lands, the reply nested inside it — and a status line
 * that says which of the two you are looking at.
 */
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import type { ColorRole } from '../ui/tokens'
import { Avatar } from './primitives/Avatar'
import { Chip } from './primitives/Chip'
import { chatStrings } from './strings'
import type { DmCounterpartQuery } from './TranscriptList'
import type { BotDmOutItem, DispatchStatus, Presentation } from './types'

export interface BotDmOutCardProps {
  item: BotDmOutItem
  presentation?: Presentation
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  /**
   * The recipient's chat is live and its turn is running RIGHT NOW.
   *
   * Only a caller that holds both chats can know this — the dispatch itself
   * says nothing about what happened to it — which is why it is a prop rather
   * than something the card derives.
   */
  targetTyping?: boolean
}

const COLLAPSED_LINES = 4

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

function statusTone(status: DispatchStatus, delivered: boolean): ColorRole {
  if (status === 'failed' || status === 'ambiguous') {
    return 'danger'
  }

  return delivered ? 'success' : 'textMuted'
}

/** A slow breath while the delivery is still in flight. Nothing moves once it lands. */
function usePulse(active: boolean) {
  const value = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (!active) {
      value.setValue(1)

      return
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { duration: 700, toValue: 0.45, useNativeDriver: false }),
        Animated.timing(value, { duration: 700, toValue: 1, useNativeDriver: false })
      ])
    )

    loop.start()

    return () => loop.stop()
  }, [active, value])

  return value
}

export function BotDmOutCard({ item, presentation = 'collapsed', onOpenBot, targetTyping = false }: BotDmOutCardProps) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(presentation === 'full')

  const delivered = Boolean(item.reply) || Boolean(item.dispatch.processId && item.dispatch.status !== 'failed')
  const pending = item.dispatch.status === 'sending' || item.dispatch.status === 'queued'
  const opacity = usePulse(pending && !item.reply)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  // The far side of this dispatch is an INBOUND row in the target's chat,
  // carrying the same body; the stamp is close but never identical, because the
  // delivery process queues between the two.
  const open = () =>
    onOpenBot?.(item.targetHandle, { kind: 'bot_dm_in', ...(item.ts ? { at: item.ts } : {}), text: item.message })
  const label = item.reply ? chatStrings.botDm.delivered : statusLabel(item.dispatch.status)
  const tone = statusTone(item.dispatch.status, delivered)

  if (presentation === 'chip') {
    return (
      <Chip
        centered
        label={chatStrings.botDm.chip(item.target)}
        onPress={onOpenBot ? open : undefined}
        testID={`bot-dm-out-chip-${item.id}`}
      />
    )
  }

  const lines = item.message.split('\n')
  const clipped = !expanded && lines.length > COLLAPSED_LINES

  return (
    <View
      style={{
        backgroundColor: theme.colors.surfaceRaised,
        borderBottomRightRadius: theme.radii.xl,
        borderLeftColor: theme.colors.accent,
        borderLeftWidth: 3,
        borderTopRightRadius: theme.radii.xl,
        marginRight: 26,
        marginVertical: theme.space.md,
        padding: theme.space.md
      }}
      testID={`bot-dm-out-${item.id}`}
    >
      <Pressable
        accessibilityHint={onOpenBot ? `Opens the chat with ${item.target}` : undefined}
        accessibilityRole={onOpenBot ? 'button' : undefined}
        disabled={!onOpenBot}
        onPress={open}
        testID={`bot-dm-out-header-${item.id}`}
      >
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          <Avatar name={item.target} size={24} />
          <Text color="accent" style={{ flex: 1, fontSize: 14, fontWeight: '700' }}>
            {chatStrings.botDm.to(item.target)}
          </Text>
          <Animated.View style={{ opacity }}>
            <Text color={tone} style={{ fontSize: 12 }}>
              {label}
            </Text>
          </Animated.View>
        </View>
      </Pressable>

      <Text
        numberOfLines={clipped ? COLLAPSED_LINES : undefined}
        selectable
        style={{ color: theme.colors.text, fontSize: 16, lineHeight: 23, marginTop: theme.space.sm }}
      >
        {item.message}
      </Text>

      {lines.length > COLLAPSED_LINES ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(current => !current)}
          testID={`bot-dm-out-more-${item.id}`}
        >
          <Text color="accent" variant="caption">
            {expanded ? chatStrings.botDm.showLess : chatStrings.botDm.showMore}
          </Text>
        </Pressable>
      ) : null}

      {item.dispatch.error ? (
        <Text color="danger" style={{ fontSize: 12, marginTop: theme.space.xs }}>
          {item.dispatch.error}
        </Text>
      ) : null}

      {/* The delivery is out and the recipient is answering it. Only shown while
          the reply has not landed: afterwards the reply itself is the answer. */}
      {targetTyping && pending && !item.reply ? (
        <Text
          color="accent"
          style={{ fontSize: 12, marginTop: theme.space.xs }}
          testID={`bot-dm-out-typing-${item.id}`}
        >
          {chatStrings.botDm.targetTyping(item.targetHandle || item.target)}
        </Text>
      ) : null}

      {item.reply ? (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderBottomRightRadius: theme.radii.lg,
            borderLeftColor: theme.colors.accent,
            borderLeftWidth: 2,
            borderTopRightRadius: theme.radii.lg,
            marginTop: theme.space.sm,
            padding: theme.space.sm
          }}
          testID={`bot-dm-out-reply-${item.id}`}
        >
          <Text color="accent" style={{ fontSize: 13 }}>
            {chatStrings.botDm.replied(item.target)}
          </Text>
          <Text selectable style={{ color: theme.colors.text, fontSize: 15, marginTop: theme.space.xxs }}>
            {item.reply.text}
          </Text>
        </View>
      ) : null}
    </View>
  )
}
