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
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { chatStrings } from './strings'
import type { ApprovalItem, ClarifyItem, Presentation, Receipt, Subagent, TranscriptItem, VisibleItem } from './types'

export interface TranscriptContext {
  selfHandle?: string
  subagents?: Record<string, Subagent>
  onOpenBot?: (handle: string) => void
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

interface RowProps {
  entry: VisibleItem
  context: TranscriptContext
  receipt?: Receipt
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

  if (item.state !== 'open') {
    return (
      <Chip
        centered
        label={
          item.state === 'answered'
            ? chatStrings.approval.answered(('answer' in item && item.answer) || chatStrings.transcript.answered)
            : chatStrings.approval.answeredElsewhere
        }
        testID={`request-${item.id}`}
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
      return <BotDmOutCard item={item} onOpenBot={context.onOpenBot} presentation={presentation} />

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

export function TranscriptList({
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
}: TranscriptListProps) {
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
      subagents: handlers.subagents ?? {}
    }),
    [
      handlers.onLinkPress,
      handlers.onOpenBot,
      handlers.onOpenRequest,
      handlers.onOpenTranscript,
      handlers.onRetry,
      handlers.selfHandle,
      handlers.subagents
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

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Inverted list: offset 0 IS the bottom of the conversation.
      const next = event.nativeEvent.contentOffset.y > AWAY_THRESHOLD

      setAway(current => {
        if (current !== next) {
          onScrolledAwayFromBottom?.(next)
        }

        return next
      })
    },
    [onScrolledAwayFromBottom]
  )

  const jump = useCallback(() => {
    listRef.current?.scrollToOffset({ animated: true, offset: 0 })
    setAway(false)
    onScrolledAwayFromBottom?.(false)
  }, [onScrolledAwayFromBottom])

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
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: AWAY_THRESHOLD, minIndexForVisible: 0 }}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        onScroll={handleScroll}
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
}
