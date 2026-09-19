/**
 * The bot's reply: a grey received bubble with incremental Markdown inside.
 *
 * The bubble is the only place `<Markdown streaming>` is used in anger — the
 * memoized block list is what keeps a 20 KB reply from re-rendering itself
 * thirty times a second while it arrives.
 */
import { View } from 'react-native'

import { Markdown } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Bubble } from './primitives/Bubble'
import { ErrorCard } from './ErrorCard'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { formatClock, formatCount, formatDuration } from './format'
import { chatStrings } from './strings'
import type { AssistantItem, Presentation } from './types'

export interface AssistantBubbleProps {
  item: AssistantItem
  presentation?: Presentation
  /** Usage and duration under the bubble. Off for an interim note. */
  showFooter?: boolean
  onRetry?: () => void
  /** Links inside the reply; defaults to the platform's own handler. */
  onLinkPress?: (href: string) => void
}

function footerParts(item: AssistantItem): string[] {
  const parts: string[] = []
  const duration = formatDuration(item.durationS)

  if (duration) {
    parts.push(duration)
  }

  const input = item.usage?.input
  const output = item.usage?.output

  if (typeof input === 'number' || typeof output === 'number') {
    parts.push(chatStrings.assistant.tokens(formatCount(input ?? 0), formatCount(output ?? 0)))
  }

  if (item.usage?.model) {
    parts.push(item.usage.model)
  }

  return parts
}

export function AssistantBubble({
  item,
  presentation = 'full',
  showFooter = false,
  onRetry,
  onLinkPress
}: AssistantBubbleProps) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const time = formatClock(item.ts)
  const parts = showFooter && !item.interim ? footerParts(item) : []

  return (
    <View style={{ marginBottom: theme.space.sm, marginTop: theme.space.xs }} testID={`assistant-${item.id}`}>
      {item.replyToBotHandle ? (
        <Text color="textMuted" style={{ fontSize: 11, marginBottom: theme.space.xxs }}>
          {chatStrings.assistant.replyTo(item.replyToBotHandle)}
        </Text>
      ) : null}

      {item.reasoning ? (
        <ReasoningDisclosure
          durationS={item.durationS}
          streaming={item.streaming && !item.text.trim()}
          testID={`reasoning-${item.id}`}
          text={item.reasoning}
        />
      ) : null}

      {item.text.trim() || item.streaming ? (
        <Bubble
          background={theme.colors.surfaceRaised}
          side="other"
          // An interim note is mid-turn commentary, not the answer: the design
          // mutes it rather than giving it a different shape.
          style={item.interim ? { opacity: 0.72 } : undefined}
          tail
        >
          <Markdown
            fontSize={17}
            onLinkPress={onLinkPress}
            streaming={item.streaming}
            surface={theme.scheme === 'dark' ? '#1B1B1F' : '#F7F7FA'}
            text={item.text}
          />

          {time ? (
            <Text color="textMuted" style={{ fontSize: 11, marginTop: theme.space.xs, textAlign: 'right' }}>
              {time}
            </Text>
          ) : null}
        </Bubble>
      ) : null}

      {item.error ? (
        <ErrorCard
          message={item.error.message}
          onRetry={onRetry}
          recoverable={item.error.recoverable}
          // A partial reply is worth keeping, so the turn stays retryable only
          // when the backend is not holding it for us.
          retryable={!item.error.recoverable}
          testID={`assistant-error-${item.id}`}
        />
      ) : null}

      {parts.length ? (
        <Text color="textMuted" style={{ fontSize: 11, marginTop: theme.space.xxs }}>
          {chatStrings.assistant.footer(parts)}
        </Text>
      ) : null}
    </View>
  )
}
