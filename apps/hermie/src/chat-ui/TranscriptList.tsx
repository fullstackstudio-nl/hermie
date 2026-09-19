/**
 * The transcript itself.
 *
 * An INVERTED `FlatList`: the newest item is index 0, which is what makes
 * "stick to the bottom while streaming" free — the bottom is offset 0, and a
 * list that is already at 0 stays there when content grows. Together with
 * `maintainVisibleContentPosition` it also means a page of older history
 * landing at the far end does not shove the reader up the screen.
 *
 * Rows are memoized on `(id, version, presentation, receipt)`. The engine bumps
 * `version` on every mutation, so that tuple is an exact change key: during a
 * streaming turn only the assistant row re-renders, and inside it only the last
 * Markdown block.
 *
 * The agents bar is a pinned sibling rather than a list header. The design
 * board pins it under the chat header, and a header inside an inverted list
 * would scroll away with the oldest message.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from 'react-native'

import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AssistantBubble } from './AssistantBubble'
import { BotDmInBubble } from './BotDmInBubble'
import { BotDmOutCard } from './BotDmOutCard'
import { JumpToLatestPill } from './JumpToLatestPill'
import { NoticePill } from './NoticePill'
import { StatusRow } from './StatusRow'
import { SubagentGroupCard } from './SubagentGroupCard'
import { ToolCard } from './ToolCard'
import { TypingIndicator } from './TypingIndicator'
import { UserBubble } from './UserBubble'
import { Chip } from './primitives/Chip'
import { clipInline } from './format'
import { chatStrings } from './strings'
import type { ApprovalItem, ClarifyItem, Presentation, Receipt, Subagent, TranscriptItem, VisibleItem } from './types'

/** What to look for in the chat being opened; see `TranscriptContext.onOpenBot`. */
export interface DmCounterpartQuery {
  kind: 'bot_dm_in' | 'bot_dm_out'
  at?: number
  text?: string
}

export interface TranscriptContext {
  selfHandle?: string
  subagents?: Record<string, Subagent>
  /**
   * Handles whose chat is live and mid-turn right now, so a pending dispatch
   * can say "@writer is writing…". A set rather than a flag per card: the
   * screen knows this once, the cards read it many times.
   */
  typingHandles?: readonly string[]
  /**
   * Open another bot's chat. `counterpart` describes the row to look for on the
   * far side, so the caller can land on the same message rather than at the
   * bottom of a chat the reader then has to search.
   */
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  onRetry?: (itemId: string) => void
  onOpenTranscript?: (subagentId: string) => void
  /** Re-opens the sheet for a question still sitting in the transcript. */
  onOpenRequest?: (item: ApprovalItem | ClarifyItem) => void
  onLinkPress?: (href: string) => void
}

export interface TranscriptListProps extends TranscriptContext {
  items: VisibleItem[]
  /** Pinned above the list — the `AgentsBar` slot. */
  header?: ReactNode
  /** A turn is running but no text has arrived: shows the typing bubble. */
  typing?: boolean
  /** Messages that landed while the reader was scrolled away. */
  newMessageCount?: number
  onScrolledAwayFromBottom?: (away: boolean) => void
  /** Older history: fired at the far (visually top) end. */
  onEndReached?: () => void
  /** Receipt under the last own bubble. */
  receipt?: Receipt
  contentStyle?: ViewStyle
  testID?: string
}

/** What a screen may ask the list to do; see `scrollToItem`. */
export interface TranscriptListHandle {
  /**
   * Bring one item into view.
   *
   * This is how a tapped DM card lands on the matching message in the OTHER
   * bot's chat rather than at the bottom of it. Returns false when that item is
   * not in the visible set — a chat filtered to Quiet genuinely does not show
   * every row, and silently scrolling somewhere else would be a lie.
   */
  scrollToItem: (itemId: string) => boolean
  scrollToLatest: () => void
}

interface RowProps {
  entry: VisibleItem
  context: TranscriptContext
  receipt?: Receipt
}

/**
 * The receipt an answered question leaves behind.
 *
 * `Allowed once · rm -rf ./build` — the decision AND what it was about, on one
 * line, truncated so a long command cannot push the decision off the row. A
 * question the user answered somewhere else says so instead; a withdrawn one
 * says that.
 */
function outcomeLabel(item: ApprovalItem | ClarifyItem): string {
  if (item.state === 'cancelled') {
    return chatStrings.approval.answeredElsewhere
  }

  if (item.kind === 'clarify') {
    const answered = Object.keys(item.answers).length

    return chatStrings.clarify.outcome(answered, item.questions.length)
  }

  const decision = chatStrings.approval.outcomes[item.answer ?? ''] ?? chatStrings.approval.answered(item.answer ?? '')
  const command = clipInline(item.command, 48)

  return command ? `${decision} · ${command}` : decision
}

function RequestRow({
  item,
  presentation,
  onOpen
}: {
  item: ApprovalItem | ClarifyItem
  presentation: Presentation
  onOpen?: (item: ApprovalItem | ClarifyItem) => void
}) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const approval = item.kind === 'approval'
  const title = approval ? chatStrings.approval.title : chatStrings.clarify.title

  // An answered question stays in the transcript as a one-line receipt, in the
  // place the question was asked. "Answered: once" alone said nothing about
  // WHAT was allowed, which is the only part worth keeping afterwards.
  if (item.state !== 'open') {
    return (
      <Chip
        centered
        label={outcomeLabel(item)}
        testID={`request-${item.id}`}
        tone={item.state === 'answered' && item.kind === 'approval' && item.answer === 'deny' ? 'danger' : 'textMuted'}
      />
    )
  }

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.accent,
        borderRadius: theme.radii.xl,
        borderWidth: 1,
        gap: theme.space.sm,
        marginVertical: theme.space.sm,
        padding: theme.space.md
      }}
      testID={`request-${item.id}`}
    >
      <Text variant="heading">{title}</Text>
      <Text color="textMuted" numberOfLines={2} variant="callout">
        {approval ? (item as ApprovalItem).command : ((item as ClarifyItem).questions[0]?.question ?? '')}
      </Text>
      {onOpen ? (
        <Button onPress={() => onOpen(item)} testID={`request-open-${item.id}`} title={chatStrings.transcript.answer} />
      ) : null}
    </View>
  )
}

function groupChildren(item: TranscriptItem, subagents: Record<string, Subagent>): Subagent[] {
  if (item.kind !== 'subagent_group') {
    return []
  }

  return item.rootIds.map(id => subagents[id]).filter((child): child is Subagent => Boolean(child))
}

function RowView({ entry, context, receipt }: RowProps) {
  const { item, presentation } = entry

  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} presentation={presentation} receipt={receipt} />

    case 'bot_dm_in':
      return (
        <BotDmInBubble
          item={item}
          onOpenBot={context.onOpenBot}
          presentation={presentation}
          selfHandle={context.selfHandle}
        />
      )

    case 'assistant':
      return (
        <AssistantBubble
          item={item}
          onLinkPress={context.onLinkPress}
          onRetry={context.onRetry ? () => context.onRetry?.(item.id) : undefined}
          presentation={presentation}
          showFooter={presentation === 'full' && !item.streaming}
        />
      )

    case 'tool':
      return <ToolCard item={item} presentation={presentation} />

    case 'bot_dm_out':
      return (
        <BotDmOutCard
          item={item}
          onOpenBot={context.onOpenBot}
          presentation={presentation}
          targetTyping={context.typingHandles?.includes(item.targetHandle) ?? false}
        />
      )

    case 'subagent_group':
      return (
        <SubagentGroupCard
          item={item}
          onOpenTranscript={context.onOpenTranscript}
          presentation={presentation}
          subagents={groupChildren(item, context.subagents ?? {})}
        />
      )

    case 'status':
      return <StatusRow item={item} presentation={presentation} />

    case 'notice':
      return <NoticePill item={item} presentation={presentation} />

    case 'approval':
    case 'clarify':
      return <RequestRow item={item} onOpen={context.onOpenRequest} presentation={presentation} />

    default:
      return null
  }
}

const TranscriptRow = memo(
  RowView,
  (previous, next) =>
    previous.entry.item.id === next.entry.item.id &&
    previous.entry.item.version === next.entry.item.version &&
    previous.entry.presentation === next.entry.presentation &&
    previous.receipt === next.receipt &&
    previous.context === next.context
)

const AWAY_THRESHOLD = 32

/** A stable empty array, so the context memo does not churn on every render. */
const EMPTY_HANDLES: readonly string[] = []

export const TranscriptList = forwardRef<TranscriptListHandle, TranscriptListProps>(function TranscriptList(
  {
    items,
    header,
    typing = false,
    newMessageCount = 0,
    onScrolledAwayFromBottom,
    onEndReached,
    receipt,
    contentStyle,
    testID = 'transcript-list',
    ...handlers
  },
  ref
) {
  const theme = useTheme()
  const listRef = useRef<FlatList<VisibleItem>>(null)
  const [away, setAway] = useState(false)

  const context = useMemo<TranscriptContext>(
    () => ({
      onLinkPress: handlers.onLinkPress,
      onOpenBot: handlers.onOpenBot,
      onOpenRequest: handlers.onOpenRequest,
      onOpenTranscript: handlers.onOpenTranscript,
      onRetry: handlers.onRetry,
      selfHandle: handlers.selfHandle,
      subagents: handlers.subagents ?? {},
      typingHandles: handlers.typingHandles ?? EMPTY_HANDLES
    }),
    [
      handlers.onLinkPress,
      handlers.onOpenBot,
      handlers.onOpenRequest,
      handlers.onOpenTranscript,
      handlers.onRetry,
      handlers.selfHandle,
      handlers.subagents,
      handlers.typingHandles
    ]
  )

  // Inverted: newest first. The reverse is memoized because a fresh array on
  // every render would defeat `FlatList`'s own bail-outs.
  const data = useMemo(() => [...items].reverse(), [items])

  const lastOwnId = useMemo(() => {
    for (const entry of data) {
      if (entry.item.kind === 'user' && !entry.item.unknownAuthor) {
        return entry.item.id
      }
    }

    return undefined
  }, [data])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Inverted list: offset 0 IS the bottom of the conversation.
    setAway(event.nativeEvent.contentOffset.y > AWAY_THRESHOLD)
  }, [])

  /**
   * Tell the screen about it in an EFFECT, not from inside the state updater.
   *
   * React runs an updater during the render phase, so calling the parent's
   * setter from there is "cannot update a component while rendering a different
   * component" — which React reports as an error and which really can drop the
   * update on the floor.
   */
  const notifyAway = useRef(onScrolledAwayFromBottom)

  notifyAway.current = onScrolledAwayFromBottom

  useEffect(() => {
    notifyAway.current?.(away)
  }, [away])

  const jump = useCallback(() => {
    listRef.current?.scrollToOffset({ animated: true, offset: 0 })
    setAway(false)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      scrollToItem(itemId) {
        const index = data.findIndex(entry => entry.item.id === itemId)

        if (index < 0) {
          return false
        }

        // `viewPosition: 0.5` centres the row: a message scrolled to the very
        // edge of the screen reads as "the end of the chat", which is the one
        // thing this is meant to disprove.
        listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 })

        return true
      },
      scrollToLatest: jump
    }),
    [data, jump]
  )

  /**
   * `scrollToIndex` on a virtualised list can fail: the row's height is not
   * measured yet, so the list does not know where it is. The documented
   * recovery is to scroll to the best guess, let a frame render, and try once
   * more — not to leave the reader where they were with nothing having moved.
   */
  const recoverScroll = useCallback((info: { index: number; averageItemLength: number }) => {
    listRef.current?.scrollToOffset({ animated: false, offset: info.averageItemLength * info.index })

    setTimeout(() => {
      listRef.current?.scrollToIndex({ animated: true, index: info.index, viewPosition: 0.5 })
    }, 80)
  }, [])

  const renderItem = useCallback(
    ({ item: entry }: { item: VisibleItem }) => (
      <TranscriptRow context={context} entry={entry} receipt={entry.item.id === lastOwnId ? receipt : undefined} />
    ),
    [context, lastOwnId, receipt]
  )

  return (
    <View style={{ flex: 1 }} testID={testID}>
      {header}

      <FlatList
        ListEmptyComponent={
          <Text color="textMuted" style={{ padding: theme.space.lg, textAlign: 'center' }}>
            {chatStrings.transcript.empty}
          </Text>
        }
        // Inverted, so the "header" renders at the visual bottom: the typing
        // bubble belongs there.
        ListHeaderComponent={typing ? <TypingIndicator /> : null}
        contentContainerStyle={[{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md }, contentStyle]}
        data={data}
        inverted
        keyExtractor={entry => entry.item.id}
        // Dragging the transcript down lowers the keyboard with the finger,
        // which is what every messenger does and what the inverted list makes
        // possible without a gesture handler.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: AWAY_THRESHOLD, minIndexForVisible: 0 }}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        onScroll={handleScroll}
        onScrollToIndexFailed={recoverScroll}
        ref={listRef}
        renderItem={renderItem}
        scrollEventThrottle={64}
        testID={`${testID}-scroll`}
      />

      {away ? (
        <View style={{ alignItems: 'center', bottom: theme.space.md, left: 0, position: 'absolute', right: 0 }}>
          <JumpToLatestPill count={newMessageCount} onPress={jump} />
        </View>
      ) : null}
    </View>
  )
})
