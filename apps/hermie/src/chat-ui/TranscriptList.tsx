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
 * exchange must leave the viewport exactly where it was. At the bottom of an
 * inverted list that is free — offset 0 is the newest row and an older row
 * growing happens further down the content, where the reader is not.
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
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle
} from 'react-native'

import { traceBlankRow, traceItems, traceRow, traceScroll, TRACING } from '../dev/trace-scroll'
import type { MarkdownImageSource } from '../markdown'
import { copyToClipboard } from '../platform/clipboard'
import { ContextMenuHost } from '../platform/context-menu'
import { applyDirectTouchPan } from '../platform/pointer-drag'
import { GlassSurface } from '../ui/glass'
import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { BUBBLE_GAP, DM_LINE_GAP } from '../ui/tokens'
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
import { useLedgerWidth } from './primitives/Bubble'
import { BubbleColumn } from './primitives/BubbleColumn'
import { Chip } from './primitives/Chip'
import { ExpandedProvider, useExpanded } from './expanded'
import { rollupDmRuns, type DmRowRole } from './dm-rollup'
import { clipInline } from './format'
import { messageMenuItems, parseMessageMenuAction } from './message-menu'
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
  /**
   * Whether THIS card's job name resolves to exactly one cron.
   *
   * A card carries a name, and a name is not an identity — two profiles may hold
   * a cron called the same thing. The host is the only one that can resolve it,
   * so it answers per card and an unresolvable one draws no action rather than a
   * link that opens the wrong cron. Absent means "always", for a host that has
   * nothing to disambiguate.
   */
  canOpenCron?: (jobName: string) => boolean
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
  const maxWidth = useLedgerWidth()

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
      style={{ borderColor: theme.accent().fill, maxWidth }}
      testID={`request-${item.id}`}
      variant="card"
    >
      <Text variant="name">{title}</Text>
      <Text color="textMuted" numberOfLines={2} variant="preview">
        {approval ? (item as ApprovalItem).command : ((item as ClarifyItem).questions[0]?.question ?? '')}
      </Text>
      {onOpen ? (
        // Content width, not card width. The card is capped at the ledger's, and
        // on a wide window that cap is 640pt — an `Answer` running all of it
        // reads as the card's own footer rather than as one control in it.
        // `Button` has no width of its own, so the caller states it, the way
        // `AttachMenu` and `ClarifySheet` do.
        <Button
          onPress={() => onOpen(item)}
          style={{ alignSelf: 'flex-start' }}
          testID={`request-open-${item.id}`}
          title={chatStrings.transcript.answer}
        />
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
      {...(context.onOpenCron && (context.canOpenCron?.(item.jobName) ?? true)
        ? { onOpenCron: () => context.onOpenCron?.(item.jobName) }
        : {})}
      {...(context.onRunCron ? { onRunNow: () => context.onRunCron?.(item.jobName) } : {})}
      onToggle={toggle}
      testID={`cron-delivery-${item.id}`}
      {...(item.ts !== undefined ? { ts: item.ts } : {})}
    />
  )
}

/**
 * Does this row put anything on the screen at all?
 *
 * The wrapper that carries the gap is rendered for EVERY row, including the ones
 * that draw nothing, so the gap has to know. A run of five dispatches swallowed
 * by a collapsed roll-up is one line by the time the reader sees it, and it used
 * to cost one turn gap per swallowed row — fifty points of nothing between the
 * roll-up and the next bubble.
 *
 * `cron_delivery` is the one kind whose card ignores `hidden-placeholder` and
 * draws either way, so the first rule does not cover it.
 */
function rowDraws(entry: VisibleItem, dmRole: DmRowRole | undefined, runExpanded: boolean): boolean {
  if (entry.presentation === 'hidden-placeholder' && entry.item.kind !== 'cron_delivery') {
    return false
  }

  return dmRole?.role !== 'rollupMember' || runExpanded
}

/**
 * One outgoing DM row, which may be swallowed by a roll-up.
 *
 * A member of a collapsed run renders NOTHING — not a hidden view, nothing at all
 * — so the run really is one line tall until it is opened. `TranscriptRowFrame`
 * asks the same question a second time, because the gap around a row that draws
 * nothing must go with it.
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
      // Expanded, the summary sits above the run's own first line, and §6.6's
      // nine points separate them exactly as they separate the lines below.
      <View style={runExpanded ? { gap: DM_LINE_GAP } : undefined}>
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

/** The gap a row opens above itself. Speech rhythm, or §6.6's ledger one. */
function gapAbove(layout: RowLayout): number {
  // A date stamp owns the boundary it opens: it carries the author-change gap
  // above it and 4pt below, and a row margin stacked on top of that is 48pt of
  // nothing between two days.
  if (layout.dateStamp) {
    return 0
  }

  return layout.grouped ? BUBBLE_GAP.grouped : layout.ledgerRun ? DM_LINE_GAP : BUBBLE_GAP.separate
}

/**
 * One row, and the gap above it.
 *
 * A component rather than inline JSX inside `renderItem`, because whether there
 * is a gap is a question about whether there is a ROW, and a collapsed roll-up's
 * membership is disclosure state that only a hook can read.
 *
 * `marginTop` on an INVERTED list is not the mistake it looks like. A cell
 * carries the list's inversion a second time, so what is inside one still reads
 * top to bottom on screen; only the order of the cells is reversed. The gap
 * above a row is therefore the row's own margin, which is what lets it say
 * whether it continues the run above it.
 */
/**
 * The two `onLayout` hooks the scroll trace needs, and nothing when it is off.
 *
 * Both are spread props rather than always-present callbacks on purpose: an
 * `onLayout` on every row is a measurement callback per row per layout pass, and a
 * virtualised transcript is the one place in the app where that is a real cost. With
 * the flag down this returns two frozen empty objects, so the rows render exactly as
 * they did before the trace existed.
 *
 * The WRAPPER height is the row's contribution to the content, gap included. The
 * CONTENT height is what the row actually drew. A wrapper with height over content
 * with none is a blank row — the sixty points of nothing the owner photographed.
 */
function useRowTrace(key: string): { wrapper: object; content: object } {
  const wrapper = useRef(0)

  return useMemo(() => {
    if (!TRACING) {
      return { content: {}, wrapper: {} }
    }

    return {
      content: {
        onLayout: (event: LayoutChangeEvent) => traceBlankRow(key, wrapper.current, event.nativeEvent.layout.height)
      },
      wrapper: {
        onLayout: (event: LayoutChangeEvent) => {
          wrapper.current = event.nativeEvent.layout.height
          traceRow(key, wrapper.current)
        }
      }
    }
  }, [key])
}

function TranscriptRowFrame({ entry, context, receipt, layout, dmRole }: RowProps) {
  const runId = dmRole?.role === 'rollupMember' ? dmRole.runId : ''
  const runExpanded = useRollupExpanded(runId)
  const menu = useMessageMenu(entry.item, context)
  const trace = useRowTrace(`${entry.item.kind}-${entry.item.id}`)

  if (!rowDraws(entry, dmRole, runExpanded)) {
    return null
  }

  return (
    <View {...trace.wrapper} style={{ marginTop: gapAbove(layout) }} testID={`transcript-row-${entry.item.id}`}>
      {/*
        The stamp comes FIRST, above the row it heads.

        A cell carries the list's inversion a second time, so what is inside one
        reads top to bottom on screen and only the ORDER OF CELLS is reversed —
        see docs/platform-notes.md. This used to sit after the row, on the belief
        that the inversion applied here too, which put every date stamp under the
        first message of its day instead of over it.
      */}
      {layout.dateStamp ? <DateSeparator label={layout.dateStamp} /> : null}

      {/*
        The whole row is the menu's target, not the bubble inside it. A secondary
        click on the metadata line under a reply, or on the gap beside a short one,
        means the same message — and UIKit lifts the target into the menu's preview,
        so a target that was only the text would lift only the text.
      */}
      <ContextMenuHost
        items={menu.items}
        menuTitle={chatStrings.menu.message}
        onSelect={menu.select}
        testID={`transcript-menu-${entry.item.id}`}
      >
        <View {...trace.content}>
          <TranscriptRow
            context={context}
            {...(dmRole ? { dmRole } : {})}
            entry={entry}
            layout={layout}
            {...(receipt ? { receipt } : {})}
          />
        </View>
      </ContextMenuHost>
    </View>
  )
}

/**
 * The message's own menu, and what a selection from it does.
 *
 * `hasDetails` is narrower than it looks, and deliberately so: the only disclosure
 * the shared `expanded` store OWNS for a plain item id is the cron card's. A tool
 * card keeps its own `useState` — with a third state, "the reader has not decided",
 * that a boolean set cannot express — and a roll-up is keyed by run rather than by
 * item. So Show details is offered where it is actually connected, and the other two
 * keep their chevrons. Wiring those into the shared store is its own change.
 */
function useMessageMenu(
  item: TranscriptItem,
  context: TranscriptContext
): { items: ReturnType<typeof messageMenuItems>; select: (id: string) => void } {
  const [expanded, toggleExpanded] = useExpanded(item.id)
  const hasDetails = item.kind === 'cron_delivery'

  const items = useMemo(
    () =>
      messageMenuItems({
        canOpenBot: Boolean(context.onOpenBot),
        detailsOpen: expanded,
        hasDetails,
        item
      }),
    // `item.version` is the engine's change key, so a streamed reply rebuilds the
    // menu's Copy lines and its links without deep-comparing the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.onOpenBot, expanded, hasDetails, item, item.version]
  )

  const select = useCallback(
    (id: string) => {
      const action = parseMessageMenuAction(id, item)

      switch (action?.kind) {
        case 'copyText':
        case 'copyMarkdown':
          copyToClipboard(action.text)

          return

        case 'copyLink':
          copyToClipboard(action.href)

          return

        case 'openBot':
          context.onOpenBot?.(action.handle)

          return

        case 'toggleDetails':
          toggleExpanded()

          return

        default:
          return
      }
    },
    [context, item, toggleExpanded]
  )

  return { items, select }
}

const AWAY_THRESHOLD = 32

/**
 * The ceiling on a programmatic jump. `onMomentumScrollEnd` normally arrives
 * first and clears the guard; this is what stops a jump that never reports
 * finishing — a list already at offset 0 emits no momentum at all — from freezing
 * the pill for good.
 */
const JUMP_SETTLE_MS = 600

/**
 * How long the reader's place is held after they open a disclosure.
 *
 * Long enough for the growth, the relayout it causes and the scroll event that
 * reports it; short enough that the reader's own next drag is never fought. A
 * drag releases the hold outright, so this is only the ceiling.
 */
const HOLD_SETTLE_MS = 400

/**
 * Sub-point drift is rounding, not a jump. The same half-point threshold UIKit
 * itself uses in `_adjustForMaintainVisibleContentPosition`.
 */
const HOLD_SLOP = 0.5

/**
 * The anchor held while the reader is scrolled away. One object, so toggling it
 * on does not hand the scroll view a new identity on every render.
 */
const AWAY_ANCHOR = { minIndexForVisible: 0 } as const

/**
 * Where the list has to be put back after a disclosure grew, or `undefined` when
 * there is nothing to correct.
 *
 * Exported because this is the only part of "Show more keeps its place" that a
 * test renderer can watch. The rest is a scroll view moving, and the requirement
 * itself is a NUMBER: the offset delta across the expansion is zero. An inverted
 * list gets that for free on paper — the growing cell's origin does not move, so
 * it grows upward with its `Show more` pinned to the cell's screen bottom — but
 * "on paper" is exactly what the owner's phone disagreed with, and a guarantee
 * that rests on a layout pass nobody controls is not a guarantee. So the place is
 * recorded when the finger goes down and restored if anything moves it.
 */
export function holdCorrection(held: number | undefined, offset: number): number | undefined {
  if (held === undefined || Math.abs(offset - held) <= HOLD_SLOP) {
    return undefined
  }

  return held
}

/** A stable empty array, so the context memo does not churn on every render. */
const EMPTY_HANDLES: readonly string[] = []

/** One shared object, so a row with no layout of its own still memoizes. */
const FALLBACK_LAYOUT: RowLayout = { grouped: false, ledgerRun: false, tail: true }

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
    return <TranscriptListBody {...props} listRef={ref} />
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

  /**
   * On a Mac, a mouse drag across the transcript must select text rather than
   * scroll it. This is the surface the owner was dragging on when he asked, and
   * the list already holds the ref the fix needs — see `platform/pointer-drag`.
   * A no-op on every other platform.
   */
  useEffect(() => {
    applyDirectTouchPan(listRef.current)
  }, [])

  const context = useMemo<TranscriptContext>(
    () => ({
      accent: handlers.accent,
      images: handlers.images,
      onLinkPress: handlers.onLinkPress,
      canOpenCron: handlers.canOpenCron,
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
      handlers.canOpenCron,
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

  if (TRACING) {
    // In the render body rather than in an effect, so the line lands BEFORE the
    // layout it describes rather than after it. A trace whose lines are in the
    // wrong order is worse than no trace: the whole question is what changed
    // height between two offsets.
    traceItems(
      `${items.length} rows, newest=${data[0]?.item.kind}:${data[0]?.item.id}${
        data[0]?.item.kind === 'assistant' && data[0].item.streaming ? ' streaming' : ''
      }`
    )
  }

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

  /**
   * The reader's place across a disclosure opening.
   *
   * `offsetNow` is the last offset the scroll view reported; `holdingTo` is that
   * number frozen at the moment a `Show more` (or a tool card, or a roll-up) was
   * tapped. While it is frozen, any offset that differs is put back — which is
   * the whole of "the expansion stays under the finger", including at the bottom
   * of the inverted list where a growth that overshoots lands the reader at the
   * newest message instead of at the paragraph they were reading.
   */
  const offsetNow = useRef(0)
  const holdingTo = useRef<number | undefined>(undefined)
  const holding = useRef<ReturnType<typeof setTimeout> | null>(null)

  const releaseHold = useCallback(() => {
    if (holding.current) {
      clearTimeout(holding.current)
      holding.current = null
    }

    holdingTo.current = undefined
  }, [])

  const holdPlace = useCallback(() => {
    if (holding.current) {
      clearTimeout(holding.current)
    }

    holdingTo.current = offsetNow.current
    holding.current = setTimeout(() => {
      holding.current = null
      holdingTo.current = undefined
    }, HOLD_SETTLE_MS)
  }, [])

  useEffect(() => releaseHold, [releaseHold])

  const endJump = useCallback(() => {
    if (jumping.current) {
      clearTimeout(jumping.current)
      jumping.current = null
    }
  }, [])

  useEffect(() => endJump, [endJump])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent

    traceScroll(contentOffset.y, contentSize.height, layoutMeasurement.height)

    offsetNow.current = contentOffset.y

    // A disclosure is growing: put the list back where the finger left it, and
    // say nothing about `away` — the offset it would read is the one being undone.
    const correction = holdCorrection(holdingTo.current, contentOffset.y)

    if (correction !== undefined) {
      listRef.current?.scrollToOffset({ animated: false, offset: correction })

      return
    }

    if (jumping.current) {
      return
    }

    // Inverted list: offset 0 IS the bottom of the conversation.
    setAway(contentOffset.y > AWAY_THRESHOLD)
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

  /**
   * A drag is the reader deciding where to be, which outranks any hold. Same
   * callback as the one that ends a programmatic jump, for the same reason.
   */
  const beginDrag = useCallback(() => {
    releaseHold()
    endJump()
  }, [endJump, releaseHold])

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
    ({ item: entry }: { item: VisibleItem }) => (
      <TranscriptRowFrame
        context={context}
        {...(dmRoles[entry.item.id] ? { dmRole: dmRoles[entry.item.id] } : {})}
        entry={entry}
        layout={layout[entry.item.id] ?? FALLBACK_LAYOUT}
        {...(entry.item.id === lastOwnId && receipt ? { receipt } : {})}
      />
    ),
    [context, dmRoles, lastOwnId, layout, receipt]
  )

  return (
    /*
      The disclosure state is provided HERE rather than around the whole
      component, because the list is what holds the reader's place across an
      expansion and `holdPlace` only exists inside this body.
    */
    <ExpandedProvider onToggle={holdPlace}>
      {/*
        The transcript IS the chat column, so it is the thing that knows how wide
        a bubble may be. See `BubbleColumn`.
      */}
      <BubbleColumn style={{ flex: 1 }} testID={testID}>
        {header}

        <FlatList
          ListEmptyComponent={
            <Text color="textMuted" style={{ padding: theme.space.lg, textAlign: 'center' }}>
              {chatStrings.transcript.empty}
            </Text>
          }
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
          /*
           * Held ONLY while the reader is away from the bottom, and that is the
           * whole of the reported jump.
           *
           * `maintainVisibleContentPosition` anchors on a VIEW: iOS records the
           * frame of the first subview whose bottom edge is past the current offset,
           * and afterwards moves `contentOffset` by however far that view's origin
           * moved (`RCTScrollViewComponentView`). At the bottom of an INVERTED list
           * every new row — the message just sent, the reply's first bubble, a tool
           * row, the bubble after it — is inserted BEFORE that view in content
           * order, so the anchor moves down by exactly the new row's height and the
           * list corrects for a shift the reader never saw. With
           * `autoscrollToTopThreshold` set, the same branch then animates back to
           * zero: the chat jumps up and scrolls itself back down, which is the bug
           * as it was reported.
           *
           * Measured on an iPhone 17 Pro against the fake gateway with
           * `--hermieTraceScroll`; a 70pt outgoing bubble moved the offset from 0 to
           * 94 (the row plus its gap) and it took ~290ms to crawl back:
           *
           *     [row]    +38626 user-o:7000 h=70.0 (new)
           *     [scroll] +38626 offset=94.0  content=968.0
           *     [scroll] +38654 offset=90.3  content=951.0   ← animating back
           *     [scroll] +38921 offset=0.0   content=951.0
           *
           * A constant-height `ListHeaderComponent` was tried as the anchor and
           * CANNOT be one: `VirtualizedList` adds one to `minIndexForVisible`
           * whenever a header exists ("Adjust index to account for
           * ListHeaderComponent"), so the native loop starts at the first CELL and
           * never looks at the header. There is no value of `minIndexForVisible`
           * that reaches it — which is why the header is gone rather than tuned.
           *
           * Off at the bottom nothing has to be corrected: an inverted list already
           * keeps offset 0 pinned to the newest row while the content grows above
           * it. Away from the bottom the anchor is a genuinely visible row and the
           * correction is what the reader wants — a message arriving under them must
           * not shove the paragraph they are reading up the screen. So the prop is
           * on exactly where it earns its keep, and `autoscrollToTopThreshold` is
           * gone with it: it only ever fires within `AWAY_THRESHOLD` of the bottom,
           * which is where this is now off.
           */
          maintainVisibleContentPosition={away ? AWAY_ANCHOR : undefined}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          onMomentumScrollEnd={endJump}
          onScroll={handleScroll}
          onScrollBeginDrag={beginDrag}
          onScrollToIndexFailed={recoverScroll}
          ref={listRef}
          renderItem={renderItem}
          // A frame apart while tracing: a correction and the animated scroll back
          // to the bottom are two events inside 300ms, and at 64ms the first of
          // them is the one that gets dropped.
          scrollEventThrottle={TRACING ? 16 : 64}
          testID={`${testID}-scroll`}
        />

        {/*
        The typing bubble, PINNED below the list rather than carried inside it.

        Its height is the whole problem: anything whose height comes and goes at the
        bottom of an inverted list moves the first cell's origin, which is the view
        `maintainVisibleContentPosition` anchors on while the reader is scrolled
        away. Out here the list's content does not change at all when a turn starts
        — only the list's own frame does, and a frame change moves no subview
        origin.

        It is the same shape as the agents bar, which is pinned above the list for
        the same kind of reason. Left-aligned and inset to match the content
        container's own padding, so it lands exactly where an incoming bubble would
        (§6.2). It stands down the moment a streaming reply exists, because that
        reply's own bubble holds the dots.
      */}
        <View
          style={
            typing && !streamingTail
              ? { paddingBottom: theme.space.md, paddingHorizontal: theme.space.md, paddingTop: BUBBLE_GAP.separate }
              : undefined
          }
          testID={`${testID}-typing-slot`}
        >
          {typing && !streamingTail ? <TypingIndicator /> : null}
        </View>

        {away ? (
          <View style={{ alignItems: 'center', bottom: theme.space.md, left: 0, position: 'absolute', right: 0 }}>
            <JumpToLatestPill count={newMessageCount} onPress={jump} />
          </View>
        ) : null}
      </BubbleColumn>
    </ExpandedProvider>
  )
}
