/**
 * The human's own turn: right-aligned, the chat's accent gradient, white text,
 * a tail on the last of a run, the clock and — under the last one only — ticks.
 *
 * The body is real Markdown, not raw characters. A person who types `**done**` or
 * a path in backticks was writing markup, and the reply beside it renders the
 * same markup: showing the asterisks on one side and bold on the other is the
 * app disagreeing with itself. Links are underlined in white rather than in the
 * accent, which on its own gradient would be invisible.
 */
import { View } from 'react-native'

import { Markdown } from '../markdown'
import { useTheme } from '../ui/theme'
import { FileChip } from './FileChip'
import { Bubble } from './primitives/Bubble'
import { Chip } from './primitives/Chip'
import { MetaLine } from './primitives/MetaLine'
import { formatClock } from './format'
import type { Presentation, Receipt, UserItem } from './types'

export interface UserBubbleProps {
  item: UserItem
  presentation?: Presentation
  /** The receipt on the metadata line; only the last own bubble gets one. */
  receipt?: Receipt
  /** Last bubble of a run — the one that carries the tail. */
  tail?: boolean
  /** Continues the run above it. */
  grouped?: boolean
  /** The chat's outgoing gradient, from `useChatAccent`. */
  accent?: { top: string; bottom: string }
  onLinkPress?: (href: string) => void
}

/** `@file:/srv/x/report.pdf` → `report.pdf`. Backticked paths lose the quotes. */
export function attachmentName(reference: string): string {
  const raw = reference.replace(/^@(?:file|image):/u, '').replace(/^[`"']|[`"']$/gu, '')

  return raw.split(/[/\\]/).pop() || raw
}

export function UserBubble({
  item,
  presentation = 'full',
  receipt,
  tail = true,
  grouped = false,
  accent,
  onLinkPress
}: UserBubbleProps) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return <Chip label={item.text} style={{ alignSelf: 'flex-end' }} />
  }

  const time = formatClock(item.ts)
  const bubble = accent ?? theme.accent().bubble

  return (
    <Bubble accent={bubble} grouped={grouped} side="own" tail={tail} testID={`user-${item.id}`}>
      {item.text ? (
        <Markdown
          // White on the gradient. The accent link colour is the bubble's own
          // fill, so it would vanish into it.
          color="onAccent"
          linkColor={theme.colors.onAccent}
          mutedColor="onAccent"
          onLinkPress={onLinkPress}
          // A code chip inside a white-on-accent bubble needs a light wash. The
          // default steps DOWN from the surface it sits on, which on a saturated
          // gradient reads as a redaction bar.
          inlineCodeBackground="rgba(255,255,255,0.22)"
          inlineCodeBorderColor="rgba(255,255,255,0.32)"
          surface="rgba(255,255,255,0.16)"
          text={item.text}
        />
      ) : null}

      {/*
        A sent file is a chip, never the raw `@file:` token the gateway needs in
        the prompt. §6.7: the reference is plumbing, and plumbing is not a
        message.
      */}
      {item.attachments?.length ? (
        <View style={{ gap: theme.space.xs, marginTop: item.text ? theme.space.sm : 0 }}>
          {item.attachments.map(reference => (
            <FileChip key={reference} name={attachmentName(reference)} onAccent testID={`user-file-${item.id}`} />
          ))}
        </View>
      ) : null}

      <MetaLine onAccent receipt={receipt} testID={`user-meta-${item.id}`} time={time} />
    </Bubble>
  )
}
