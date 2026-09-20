/**
 * The transcript itself.
 *
 * An INVERTED `FlatList`: the newest item is index 0, which is what makes "stick
 * to the bottom while streaming" free — the bottom is offset 0, and a list that is
 * already at 0 stays there when content grows. Together with
 * `maintainVisibleContentPosition` it also means a page of older history landing at
 * the far end does not shove the reader up the screen.
 *
 * Rows are memoized on `(id, version, presentation, receipt, layout)`. The engine
 * bumps `version` on every mutation, so that tuple is an exact change key: during
 * a streaming turn only the assistant row re-renders, and inside it only the last
 * Markdown block.
 *
 * Three whole-list facts are computed here rather than in the rows, because a row
 * cannot see its neighbours:
 *
 *  - **Grouping** (`grouping.ts`) — which bubbles continue a run, which one is
 *    last and therefore carries the tail, and where a date stamp goes.
 *  - **Bot-to-bot roll-ups** (`dm-rollup.ts`) — more than three consecutive
 *    outgoing DMs collapse into one summary.
 *  - **Disclosure state** (`expanded.tsx`) — every fold, card and roll-up keeps
 *    its open/closed flag in one set keyed by item id. In a virtualised list a
 *    row's own `useState` is a bug with a delay on it: scroll an opened card out
 *    of the window and `FlatList` unmounts it, so scrolling back re-mounts it
 *    collapsed. Nothing the reader did.
 *
 * Nothing here scrolls in response to a disclosure opening. That is not an
 * omission, it is the requirement: expanding a tool row, a cron card or a DM
 * exchange must leave the viewport exactly where it was. `minIndexForVisible: 0`
 * anchors the list on the NEWEST item, so an older row growing changes nothing
 * about where the bottom is.
 *
 * The agents bar is a pinned sibling rather than a list header. The design board
 * pins it under the chat header, and a header inside an inverted list would scroll
 * away with the oldest message.
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
import {
  FlatList,
  Platform,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle
} from 'react-native'

import type { MarkdownImageSource } from '../markdown'
import { GlassSurface } from '../ui/glass'
import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AssistantBubble } from './AssistantBubble'
import { BotDmInBubble } from './BotDmInBubble'
import { BotDmOutLine } from './BotDmOutLine'
import { BotDmRollup, useRollupExpanded } from './BotDmRollup'
import { CronDeliveryCard } from './CronDeliveryCard'
import { DateSeparator } from './DateSeparator'
import { JumpToLatestPill } from './JumpToLatestPill'
import { NoticePill } from './NoticePill'
import { StatusRow } from './StatusRow'
import { SubagentGroupCard } from './SubagentGroupCard'
import { ToolCard } from './ToolCard'
import { TypingIndicator } from './TypingIndicator'
import { UserBubble } from './UserBubble'
import { BubbleColumn } from './primitives/BubbleColumn'
import { Chip } from './primitives/Chip'
import { ExpandedProvider, useExpanded } from './expanded'
import { rollupDmRuns, type DmRowRole } from './dm-rollup'
import { clipInline } from './format'
import { layoutRows, type RowLayout } from './grouping'
import { chatStrings } from './strings'
import type {
  ApprovalItem,
  ClarifyItem,
  CronDeliveryItem,
  Presentation,
  Receipt,
  Subagent,
  TranscriptItem,
  VisibleItem
} from './types'

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
   * Handles whose chat is live and mid-turn right now, so a pending dispatch can
   * say "@writer is writing…". A set rather than a flag per card: the screen knows
   * this once, the cards read it many times.
   */
  typingHandles?: readonly string[]
  /**
   * Open another bot's chat.
   *
   * Reached from ONE place now: the `Open @writer's chat` link inside an expanded
   * bot-to-bot exchange. Tapping a DM line itself expands it in place (§6.6), so
   * the counterpart query the old card passed is gone — the reader is not being
   * sent somewhere to see a message they are already looking at.
   */
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  onRetry?: (itemId: string) => void
  onOpenTranscript?: (subagentId: string) => void
  /** Re-opens the sheet for a question still sitting in the transcript. */
  onOpenRequest?: (item: ApprovalItem | ClarifyItem) => void
  onLinkPress?: (href: string) => void
  /** The cron card's two actions, where the host can provide them. */
  onOpenCron?: (jobName: string) => void
  onRunCron?: (jobName: string) => void
  /** The chat's outgoing bubble gradient, from `useChatAccent`. */
  accent?: { top: string; bottom: string }
  /**
   * Where a gateway-relative Markdown image resolves, and what its request
   * carries. Must be a stable object; it is part of the row memo's key.
   */
  images?: MarkdownImageSource
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
  /** Receipt on the last own bubble's metadata line. */
  receipt?: Receipt
  contentStyle?: ViewStyle
  testID?: string
}

/** What a screen may ask the list to do; see `scrollToItem`. */
export interface TranscriptListHandle {
  /**
   * Bring one item into view.
   *
   * This is how Activity's "open chat at message" deep link lands on the row it
   * names rather than at the bottom of the chat. Returns false when that item is
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
  layout: RowLayout
  dmRole?: DmRowRole
}

/**
 * The receipt an answered question leaves behind.
 *
 * `Allowed once · rm -rf ./build` — the decision AND what it was about, on one
 * line, truncated so a long command cannot push the decision off the row. A
 * question the user answered somewhere else says so instead; a withdrawn one says
 * that.
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
  // place the question was asked. "Answered: once" alone said nothing about WHAT
  // was allowed, which is the only part worth keeping afterwards.
  if (item.state !== 'open') {
    return (
      <Chip
        centered
        label={outcomeLabel(item)}
        testID={`request-${item.id}`}
        tone={
          item.state === 'answered' && item.kind === 'approval' && item.answer === 'deny' ? 'dangerText' : 'textFaint'
        }
      />
    )
  }

  return (
    <GlassSurface
      contentStyle={{ gap: theme.space.sm, padding: theme.space.md }}
      style={{ borderColor: theme.accent().fill }}
      testID={`request-${item.id}`}
      variant="card"
    >
      <Text variant="name">{title}</Text>
      <Text color="textMuted" numberOfLines={2} variant="preview">
        {approval ? (item as ApprovalItem).command : ((item as ClarifyItem).questions[0]?.question ?? '')}
      </Text>
      {onOpen ? (
        <Button onPress={() => onOpen(item)} testID={`request-open-${item.id}`} title={chatStrings.transcript.answer} />
      ) : null}
    </GlassSurface>
  )
}

function groupChildren(item: TranscriptItem, subagents: Record<string, Subagent>): Subagent[] {
  if (item.kind !== 'subagent_group') {
    return []
  }

  return item.rootIds.map(id => subagents[id]).filter((child): child is Subagent => Boolean(child))
}

/** The cron card, wired to the shared disclosure store. */
function CronRow({ item, context }: { item: CronDeliveryItem; context: TranscriptContext }) {
  const [expanded, toggle] = useExpanded(item.id)

  return (
    <CronDeliveryCard
      body={item.body}
      expanded={expanded}
      // The projection flags a name that came back as the redactor's placeholder.
      // Titling a card with `[REDACTED - redaction failed]` would read as the job's
      // actual name, so the card says nothing about the name instead.
      name={item.nameRedacted ? chatStrings.cron.unnamed : item.jobName}
      onLinkPress={context.onLinkPress}
      {...(context.onOpenCron ? { onOpenCron: () => context.onOpenCron?.(item.jobName) } : {})}
      {...(context.onRunCron ? { onRunNow: () => context.onRunCron?.(item.jobName) } : {})}
      onToggle={toggle}
      testID={`cron-delivery-${item.id}`}
      {...(item.ts !== undefined ? { ts: item.ts } : {})}
    />
  )
}

/**
 * One outgoing DM row, which may be swallowed by a roll-up.
 *
 * A member of a collapsed run renders NOTHING — not a hidden view, nothing at all
 * — so the run really is one line tall until it is opened.
 */
function DmOutRow({ entry, context, role }: { entry: VisibleItem; context: TranscriptContext; role?: DmRowRole }) {
  const runId = role?.role === 'rollupMember' ? role.runId : role?.role === 'rollupHead' ? role.run.id : ''
  const runExpanded = useRollupExpanded(runId)
  const item = entry.item

  if (item.kind !== 'bot_dm_out') {
    return null
  }

  const line = (
    <BotDmOutLine
      item={item}
      onLinkPress={context.onLinkPress}
      {...(context.onOpenBot ? { onOpenBot: context.onOpenBot } : {})}
      presentation={entry.presentation}
      targetTyping={context.typingHandles?.includes(item.targetHandle) ?? false}
    />
  )

  if (role?.role === 'rollupHead') {
    return (
      <View>
        <BotDmRollup run={role.run} />
        {runExpanded ? line : null}
      </View>
    )
  }

  if (role?.role === 'rollupMember') {
    return runExpanded ? line : null
  }

  return line
}

function RowView({ entry, context, receipt, layout, dmRole }: RowProps) {
  const { item, presentation } = entry

  switch (item.kind) {
    case 'user':
      return (
        <UserBubble
          {...(context.accent ? { accent: context.accent } : {})}
          grouped={layout.grouped}
          item={item}
          onLinkPress={context.onLinkPress}
          presentation={presentation}
          receipt={receipt}
          tail={layout.tail}
        />
      )

    case 'bot_dm_in':
      return (
        <BotDmInBubble
          // §6.6: an inbound bot message gains "↩ answered" once this bot has
          // replied. `answersOurDispatch` is the engine's own attribution pass
          // (`attributeBotReplies`), so the marker is not guessed at here.
          answered={item.answersOurDispatch ?? false}
          grouped={layout.grouped}
          item={item}
          onLinkPress={context.onLinkPress}
          {...(context.onOpenBot ? { onOpenBot: context.onOpenBot } : {})}
          presentation={presentation}
          selfHandle={context.selfHandle}
          tail={layout.tail}
        />
      )

    case 'assistant':
      return (
        <AssistantBubble
          grouped={layout.grouped}
          item={item}
          {...(context.images ? { images: context.images } : {})}
          onLinkPress={context.onLinkPress}
          onRetry={context.onRetry ? () => context.onRetry?.(item.id) : undefined}
          presentation={presentation}
          showFooter={presentation === 'full' && !item.streaming}
          tail={layout.tail}
        />
      )

    case 'tool':
      return <ToolCard item={item} presentation={presentation} />

    case 'bot_dm_out':
      return <DmOutRow context={context} entry={entry} role={dmRole} />

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

    // A cron delivery is a machine event, not the owner's own bubble — which is
    // exactly what it used to render as. See ADR-0013 for why the projection has
    // to guess at all.
    case 'cron_delivery':
      return <CronRow context={context} item={item} />

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
    previous.layout === next.layout &&
    previous.dmRole === next.dmRole &&
    previous.context === next.context
)

const AWAY_THRESHOLD = 32

/**
 * The ceiling on a programmatic jump. `onMomentumScrollEnd` normally arrives
 * first and clears the guard; this is what stops a jump that never reports
 * finishing — a list already at offset 0 emits no momentum at all — from freezing
 * the pill for good.
 */
const JUMP_SETTLE_MS = 600

/** A stable empty array, so the context memo does not churn on every render. */
const EMPTY_HANDLES: readonly string[] = []

/**
 * Keep the previous object for every key whose value has not changed.
 *
 * A shallow compare one level down. A row layout is three scalars, so it settles
 * exactly; a roll-up HEAD carries a freshly built run object and therefore never
 * settles, which is deliberate — there is at most one head per run of dispatches,
 * and deep-comparing its item array to save one re-render would cost more than the
 * re-render does.
 */
function useStable<T extends object>(next: Record<string, T>): Record<string, T> {
  const previous = useRef<Record<string, T>>({})

  return useMemo(() => {
    const merged: Record<string, T> = {}

    for (const [key, value] of Object.entries(next)) {
      const before = previous.current[key]

      merged[key] = before && shallowEqual(before, value) ? before : value
    }

    previous.current = merged

    return merged
  }, [next])
}

function shallowEqual(a: object, b: object): boolean {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)

  if (keys.length !== Object.keys(right).length) {
    return false
  }

  return keys.every(key => left[key] === right[key])
}

export const TranscriptList = forwardRef<TranscriptListHandle, TranscriptListProps>(
  function TranscriptList(props, ref) {
    return (
      <ExpandedProvider>
        <TranscriptListBody {...props} listRef={ref} />
      </ExpandedProvider>
    )
  }
)

function TranscriptListBody({
  items,
  header,
  typing = false,
  newMessageCount = 0,
  onScrolledAwayFromBottom,
  onEndReached,
  receipt,
  contentStyle,
  testID = 'transcript-list',
  listRef: forwarded,
  ...handlers
}: TranscriptListProps & { listRef: React.ForwardedRef<TranscriptListHandle> }) {
  const theme = useTheme()
  const listRef = useRef<FlatList<VisibleItem>>(null)
  const [away, setAway] = useState(false)

  const context = useMemo<TranscriptContext>(
    () => ({
      accent: handlers.accent,
      images: handlers.images,
      onLinkPress: handlers.onLinkPress,
      onOpenBot: handlers.onOpenBot,
      onOpenCron: handlers.onOpenCron,
      onOpenRequest: handlers.onOpenRequest,
      onOpenTranscript: handlers.onOpenTranscript,
      onRetry: handlers.onRetry,
      onRunCron: handlers.onRunCron,
      selfHandle: handlers.selfHandle,
      subagents: handlers.subagents ?? {},
      typingHandles: handlers.typingHandles ?? EMPTY_HANDLES
    }),
    [
      handlers.accent,
      handlers.images,
      handlers.onLinkPress,
      handlers.onOpenBot,
      handlers.onOpenCron,
      handlers.onOpenRequest,
      handlers.onOpenTranscript,
      handlers.onRetry,
      handlers.onRunCron,
      handlers.selfHandle,
      handlers.subagents,
      handlers.typingHandles
    ]
  )

  /**
   * Whole-list facts, computed in READING order and then reversed for the list.
   *
   * Both are STABILISED, not just memoized, and that distinction is the whole
   * point. A streaming delta produces a new `items` array, so both passes run
   * again and hand every row a freshly allocated layout object — which is a
   * different prop identity, which breaks `TranscriptRow`'s memo, which re-renders
   * every settled bubble on every token. Reusing the previous object wherever the
   * VALUE has not changed is what keeps `__tests__/chat-ui/transcript-memo` honest.
   */
  const layout = useStable(useMemo(() => layoutRows(items), [items]))
  const dmRoles = useStable(useMemo(() => rollupDmRuns(items), [items]))

  // Inverted: newest first.
  const data = useMemo(() => [...items].reverse(), [items])

  const lastOwnId = useMemo(() => {
    for (const entry of data) {
      if (entry.item.kind === 'user' && !entry.item.unknownAuthor) {
        return entry.item.id
      }
    }

    return undefined
  }, [data])

  /**
   * A streaming reply already on screen holds its own dots (§6.2), so the
   * standalone typing bubble must stand down the moment one exists. Drawing both
   * is what produced a bubble of dots under an empty grey rectangle.
   */
  const streamingTail = data[0]?.item.kind === 'assistant' && data[0].item.streaming

  /**
   * A jump the LIST started, not the reader.
   *
   * `scrollToOffset({ animated: true })` emits a scroll event per frame on the way
   * down, and the first few are still far from the bottom — so the pill that was
   * just tapped reappeared for a moment mid-flight. Events are ignored until the
   * animation has landed.
   */
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null)

  const endJump = useCallback(() => {
    if (jumping.current) {
      clearTimeout(jumping.current)
      jumping.current = null
    }
  }, [])

  useEffect(() => endJump, [endJump])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (jumping.current) {
      return
    }

    // Inverted list: offset 0 IS the bottom of the conversation.
    setAway(event.nativeEvent.contentOffset.y > AWAY_THRESHOLD)
  }, [])

  /**
   * Tell the screen about it in an EFFECT, not from inside the state updater.
   *
   * React runs an updater during the render phase, so calling the parent's setter
   * from there is "cannot update a component while rendering a different
   * component" — which React reports as an error and which really can drop the
   * update on the floor.
   */
  const notifyAway = useRef(onScrolledAwayFromBottom)

  notifyAway.current = onScrolledAwayFromBottom

  useEffect(() => {
    notifyAway.current?.(away)
  }, [away])

  const jump = useCallback(() => {
    if (jumping.current) {
      clearTimeout(jumping.current)
    }

    jumping.current = setTimeout(() => {
      jumping.current = null
    }, JUMP_SETTLE_MS)

    listRef.current?.scrollToOffset({ animated: true, offset: 0 })
    setAway(false)
  }, [])

  useImperativeHandle(
    forwarded,
    () => ({
      scrollToItem(itemId) {
        const index = data.findIndex(entry => entry.item.id === itemId)

        if (index < 0) {
          return false
        }

        // `viewPosition: 0.5` centres the row: a message scrolled to the very edge
        // of the screen reads as "the end of the chat", which is the one thing
        // this is meant to disprove.
        listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 })

        return true
      },
      scrollToLatest: jump
    }),
    [data, jump]
  )

  /**
   * `scrollToIndex` on a virtualised list can fail: the row's height is not
   * measured yet, so the list does not know where it is. The documented recovery
   * is to scroll to the best guess, let a frame render, and try once more — not to
   * leave the reader where they were with nothing having moved.
   */
  const recoverScroll = useCallback((info: { index: number; averageItemLength: number }) => {
    listRef.current?.scrollToOffset({ animated: false, offset: info.averageItemLength * info.index })

    setTimeout(() => {
      listRef.current?.scrollToIndex({ animated: true, index: info.index, viewPosition: 0.5 })
    }, 80)
  }, [])

  const renderItem = useCallback(
    ({ item: entry }: { item: VisibleItem }) => {
      const rowLayout = layout[entry.item.id] ?? { grouped: false, tail: true }

      return (
        <View
          // Grouped bubbles sit tight; a change of speaker opens the gap. The
          // margin is on the row rather than inside the bubble so a date stamp
          // lands between two runs rather than inside one.
          style={{ marginTop: rowLayout.grouped ? theme.space.xs - 1 : theme.space.sm + 2 }}
        >
          {/* Inverted, so a stamp ABOVE a row renders after it. */}
          <TranscriptRow
            context={context}
            {...(dmRoles[entry.item.id] ? { dmRole: dmRoles[entry.item.id] } : {})}
            entry={entry}
            layout={rowLayout}
            receipt={entry.item.id === lastOwnId ? receipt : undefined}
          />
          {rowLayout.dateStamp ? <DateSeparator label={rowLayout.dateStamp} /> : null}
        </View>
      )
    },
    [context, dmRoles, lastOwnId, layout, receipt, theme.space]
  )

  return (
    // The transcript IS the chat column, so it is the thing that knows how wide
    // a bubble may be. See `BubbleColumn`.
    <BubbleColumn style={{ flex: 1 }} testID={testID}>
      {header}

      <FlatList
        ListEmptyComponent={
          <Text color="textMuted" style={{ padding: theme.space.lg, textAlign: 'center' }}>
            {chatStrings.transcript.empty}
          </Text>
        }
        // Inverted, so the "header" renders at the visual bottom: the typing
        // bubble belongs there — but only while no streaming reply is on screen,
        // because that reply's own bubble holds the dots.
        ListHeaderComponent={typing && !streamingTail ? <TypingIndicator /> : null}
        contentContainerStyle={[{ paddingHorizontal: theme.space.md, paddingVertical: theme.space.md }, contentStyle]}
        data={data}
        inverted
        keyExtractor={entry => entry.item.id}
        // Dragging the transcript down lowers the keyboard with the finger, which
        // is what every messenger does and what the inverted list makes possible
        // without a gesture handler. Android has no interactive dismissal — the
        // value is ignored there and the keyboard simply stays up — so it drops
        // the keyboard when the drag starts instead.
        keyboardDismissMode={Platform.select({ ios: 'interactive', default: 'on-drag' })}
        keyboardShouldPersistTaps="handled"
        // `minIndexForVisible: 0` anchors on the NEWEST item, which is what makes
        // "expanding a card never moves the viewport" true: an older row growing
        // does not change where the bottom is.
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: AWAY_THRESHOLD, minIndexForVisible: 0 }}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        onMomentumScrollEnd={endJump}
        onScroll={handleScroll}
        onScrollBeginDrag={endJump}
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
    </BubbleColumn>
  )
}
