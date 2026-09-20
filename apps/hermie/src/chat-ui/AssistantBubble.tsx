/**
 * The bot's reply.
 *
 * Three things the mockup asks for and one it forbids:
 *
 *  - A short reply is a frosted glass bubble (`bubbleIn`). A LONG one takes the
 *    reading treatment (`bubbleInRead`): a near-opaque wash, looser leading,
 *    wider padding. §7.1 is explicit that this is not a stylistic variant — it is
 *    how body-text contrast stops depending on the wallpaper behind the bubble.
 *  - Past roughly fourteen lines the body folds, with the state held above the
 *    list so virtualisation cannot reset it. The message currently STREAMING is
 *    never folded.
 *  - One bubble from start to finish (§6.2): while the turn has no text this
 *    bubble holds the typing dots itself. It must not render as an empty box —
 *    that box, under a separate bubble of dots, is the grey rectangle the owner
 *    reported.
 *  - Forbidden: a blur view of its own. §7.4 — no per-bubble blur in a
 *    virtualised list, and none at all on Android. `Bubble` composites the recipe.
 */
import { View } from 'react-native'

import { Markdown, markdownLeading, type MarkdownImageSource } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { ErrorCard } from './ErrorCard'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { TypingDots } from './TypingIndicator'
import { Bubble } from './primitives/Bubble'
import { Fold, useFoldBlocks } from './primitives/Fold'
import { MetaLine } from './primitives/MetaLine'
import { useExpanded } from './expanded'
import { formatClock, formatCount, formatDuration, needsReadingTreatment } from './format'
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
  /** Where a gateway-relative image resolves, and what its request carries. */
  images?: MarkdownImageSource
  /** Last bubble of a run — the one that carries the tail. */
  tail?: boolean
  grouped?: boolean
}

/**
 * The line under a finished reply: how long it took, what it cost, on what.
 *
 * A duration NEVER stands alone. `0.1s` under a bubble is a loose number with
 * nothing to attach it to — it reads as a stray artifact rather than as part of
 * the reply — so the clock only appears next to something that explains it. A
 * gateway that reports no usage therefore shows no footer at all, which is the
 * honest outcome.
 */
function footerParts(item: AssistantItem): string[] {
  const parts: string[] = []
  const input = item.usage?.input
  const output = item.usage?.output

  if (typeof input === 'number' || typeof output === 'number') {
    parts.push(chatStrings.assistant.tokens(formatCount(input ?? 0), formatCount(output ?? 0)))
  }

  if (item.usage?.model) {
    parts.push(item.usage.model)
  }

  if (!parts.length) {
    return parts
  }

  const duration = formatDuration(item.durationS)

  return duration ? [duration, ...parts] : parts
}

export function AssistantBubble({
  item,
  presentation = 'full',
  showFooter = false,
  onRetry,
  onLinkPress,
  images,
  tail = true,
  grouped = false
}: AssistantBubbleProps) {
  const theme = useTheme()
  const foldBlocks = useFoldBlocks()
  const [expanded, toggle] = useExpanded(item.id)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const time = formatClock(item.ts)
  const parts = showFooter && !item.interim ? footerParts(item) : []
  const body = item.text
  const hasBody = Boolean(body.trim())
  const reading = hasBody && needsReadingTreatment(body)
  const variant = reading ? 'inRead' : 'in'
  const recipe = theme.bubbles[variant]

  return (
    <View testID={`assistant-${item.id}`}>
      {item.replyToBotHandle ? (
        <Text color="textFaint" style={{ marginBottom: theme.space.xxs }} variant="micro">
          {chatStrings.assistant.replyTo(item.replyToBotHandle).toUpperCase()}
        </Text>
      ) : null}

      {item.reasoning ? (
        <ReasoningDisclosure
          durationS={item.durationS}
          id={item.id}
          streaming={item.streaming && !hasBody}
          testID={`reasoning-${item.id}`}
          text={item.reasoning}
        />
      ) : null}

      {hasBody || item.streaming ? (
        <Bubble
          grouped={grouped}
          side="other"
          // An interim note is mid-turn commentary, not the answer: the design
          // mutes it rather than giving it a different shape. A reply addressed at
          // a teammate bot is muted less far — it IS the answer, just not one the
          // human asked for.
          style={item.interim ? { opacity: 0.72 } : item.replyToBotHandle ? { opacity: 0.9 } : undefined}
          tail={tail}
          variant={variant}
        >
          {hasBody ? (
            <Fold
              // The leading and the block geometry are what let the cut land on a
              // line boundary and step over a table or a code block.
              blocks={foldBlocks.blocks}
              bleed={reading ? theme.space.lg : theme.space.md + 2}
              expanded={expanded}
              fadeTo={recipe.tail}
              lineHeight={markdownLeading(theme.type.body.fontSize)}
              onToggle={toggle}
              streaming={item.streaming}
              testID={`assistant-fold-${item.id}`}
            >
              <Markdown
                fontSize={theme.type.body.fontSize}
                {...(images ? { images } : {})}
                linkColor={theme.accent().text}
                onBlockLayout={foldBlocks.onBlockLayout}
                onLinkPress={onLinkPress}
                streaming={item.streaming}
                text={body}
              />
            </Fold>
          ) : (
            // The turn is running and nothing has arrived. Same bubble, dots
            // instead of text — never an empty box with a timestamp in it.
            <TypingDots testID={`assistant-typing-${item.id}`} />
          )}

          {hasBody ? <MetaLine testID={`assistant-meta-${item.id}`} time={time} /> : null}
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
        <Text color="textFaint" style={{ marginLeft: theme.space.md, marginTop: theme.space.xxs }} variant="meta">
          {chatStrings.assistant.footer(parts)}
        </Text>
      ) : null}
    </View>
  )
}
