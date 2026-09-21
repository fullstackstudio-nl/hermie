/**
 * The human's own turn: right-aligned, the chat's flat accent, white text,
 * a tail on the last of a run, the clock on the body's last line and — on the last
 * sent message only — ticks beside it.
 *
 * The body is real Markdown, not raw characters. A person who types `**done**` or
 * a path in backticks was writing markup, and the reply beside it renders the
 * same markup: showing the asterisks on one side and bold on the other is the
 * app disagreeing with itself. Links are underlined in white rather than in the
 * accent, which on its own fill would be invisible.
 */
import { View } from 'react-native'

import { Markdown } from '../markdown'
import { useTheme } from '../ui/theme'
import { AttachmentGallery, type GalleryAttachment } from './AttachmentGallery'
import { Bubble } from './primitives/Bubble'
import { Chip } from './primitives/Chip'
import { MetaLine } from './primitives/MetaLine'
import { formatClock } from './format'
import { chatStrings } from './strings'
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
  /** The chat's outgoing fill, from `useChatAccent`. */
  accent?: string
  onLinkPress?: (href: string) => void
  /**
   * Something `Image` can load for this reference, when the host has one.
   *
   * A reference is a path on the GATEWAY's disk, which nothing here can fetch,
   * so the bubble cannot decide on its own whether an attachment is showable —
   * only the screen knows which images it still holds bytes for. Returning
   * `undefined` is the ordinary answer and draws the chip.
   */
  attachmentUri?: (reference: string) => string | undefined
  /** Open one: the full-screen viewer for a picture, the system for a file. */
  onOpenAttachment?: (attachment: GalleryAttachment) => void
}

/**
 * `@file:/srv/x/report.pdf` → `report.pdf`. Backticked paths lose the quotes.
 *
 * `UserItem.attachments` stores the reference and nothing else, so the name a
 * chip shows is derived here, at render time. `attachmentRefName` in
 * `@hermie/transcript` derives the same name to PAIR a sent turn with its row, and
 * the two have to agree; the kit imports no runtime code from the engine, so what
 * keeps them in step is an assertion in `__tests__/chat-ui/components.test.tsx`
 * rather than a shared call.
 */
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
  onLinkPress,
  attachmentUri,
  onOpenAttachment
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
    <Bubble
      accent={bubble}
      grouped={grouped}
      /*
        The clock on EVERY bubble, on the body's last line. The ticks still only
        appear where the engine has a receipt to report — which is the last sent
        message and nothing else, because a receipt is one fact about the
        conversation rather than one per message. Painting a tick on an older
        bubble would be inventing a delivery the gateway never confirmed.
      */
      meta={
        <MetaLine
          /*
            A steer is a user turn that started no turn of its own: the gateway
            handed it to the agent with its next tool result. Without this word
            the bubble is indistinguishable from an ordinary message the bot
            went on to ignore, because the reply it steers is already streaming
            ABOVE it.
          */
          marker={item.displayKind === 'steer' ? chatStrings.queue.steeredMarker : undefined}
          onAccent
          receipt={receipt}
          testID={`user-meta-${item.id}`}
          time={time}
        />
      }
      side="own"
      tail={tail}
      testID={`user-${item.id}`}
    >
      {item.text ? (
        <Markdown
          // White on the accent. The accent link colour is the bubble's own
          // fill, so it would vanish into it.
          color="onAccent"
          linkColor={theme.colors.onAccent}
          mutedColor="onAccent"
          onLinkPress={onLinkPress}
          // A code chip inside a white-on-accent bubble needs a light wash. The
          // default steps DOWN from the surface it sits on, which on a saturated
          // fill reads as a redaction bar.
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
        <View style={{ marginTop: item.text ? theme.space.sm : 0 }}>
          <AttachmentGallery
            attachments={item.attachments.map(reference => {
              const uri = attachmentUri?.(reference)

              return { name: attachmentName(reference), reference, ...(uri ? { uri } : {}) }
            })}
            onAccent
            {...(onOpenAttachment ? { onOpen: onOpenAttachment } : {})}
            testID={`user-file-${item.id}`}
          />
        </View>
      ) : null}
    </Bubble>
  )
}
