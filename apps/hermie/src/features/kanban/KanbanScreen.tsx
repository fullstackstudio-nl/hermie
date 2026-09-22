/**
 * Boards: the board list, one board's columns, and one card.
 *
 * One screen with early-return sub-screens, the shape the MCP, Crons and
 * Connectors pages use, and for the same reason: the compact and regular shells
 * own their own navigation and disagree about what "push" means.
 *
 * **Moving a card is a menu on every layout, and a DRAG as well where the
 * columns are side by side.** The menu came first and it stays first: it is
 * the only form that works on a phone, under VoiceOver and from a keyboard,
 * and it is the only form that can refuse well — the three columns the
 * dispatcher owns are simply not listed. The drag is the wide-window
 * convenience on top of it. It refuses the same three columns, using the same
 * `canDropInto` the menu filters with, and it shows them as non-targets from
 * the moment a card lifts rather than letting a reader aim at one and find
 * out.
 *
 * Dragging a card up or down inside a column is not missing, it is meaningless:
 * there is no order on the wire. The server sorts by priority and age, so the
 * page says so instead of implying a rank it could not save — and the drop
 * resolves to a COLUMN and nothing finer, which is `card-drag.ts`'s whole
 * argument.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native'

import { useGateway } from '../../gateway'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { Button, InsetGroup, InsetRow, InsetValueRow, Screen, Text, TextField } from '../../ui/primitives'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { useTheme } from '../../ui/theme'
import { ScreenHeader } from '../cron/ScreenHeader'
import { CARD_LIFT_SCALE, useCardDrag, type CardDrag } from './use-card-drag'
import type { ColumnDragState, ColumnTarget } from './card-drag'
import {
  KANBAN_BASE,
  KanbanController,
  KanbanRefused,
  KanbanUnavailable,
  boardQuery,
  debounceNudge,
  type BoardSummary,
  type BoardView,
  type Card,
  type CardDetail
} from './kanban-controller'
import { kanbanStrings } from './strings'

/** A window at least this wide lays the columns out side by side. */
const WIDE_BOARD_PX = 700

/** How wide one column is on the side-by-side layout. */
const COLUMN_WIDTH = 260

export interface KanbanScreenProps {
  onClose: () => void
  /** What the back button on the board list says, since two doors lead here. */
  backLabel?: string
}

const columnLabel = (name: string): string => kanbanStrings.columns[name] ?? name

export function KanbanScreen({ onClose, backLabel = kanbanStrings.back }: KanbanScreenProps) {
  const theme = useTheme()
  const { http } = useGateway()
  const { width } = useWindowDimensions()

  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [board, setBoard] = useState<BoardView | null>(null)
  const [openCard, setOpenCard] = useState<string | null>(null)
  const [detail, setDetail] = useState<CardDetail | null>(null)
  const [archived, setArchived] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [absent, setAbsent] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /*
    One debounced nudge for the whole screen. Every write asks the dispatcher to
    look now rather than on its 60-second tick, and a burst of edits should cost
    one nudge rather than one each.
  */
  const controller = useMemo(() => {
    if (!http) {
      return null
    }

    /*
      `POST /dispatch` asks the dispatcher to look NOW. Upstream's own tick is
      60 seconds, so without this a card made on a phone can sit idle for a
      minute; the tick is lock-guarded and costs about a millisecond when there
      is nothing to do, so over-nudging is free and a failure is a non-event.
    */
    const nudge = debounceNudge(board => {
      void http.post(`${KANBAN_BASE}/dispatch${boardQuery(board)}`, {}).catch(() => undefined)
    })

    return new KanbanController(http, { onNudge: nudge })
  }, [http])

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof KanbanUnavailable) {
      setAbsent(true)
    } else {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const loadBoards = useCallback(async () => {
    if (!controller) {
      return
    }

    try {
      setBoards(await controller.boards())
      setError(null)
      setAbsent(false)
    } catch (cause) {
      fail(cause)
    }
  }, [controller, fail])

  const loadBoard = useCallback(async () => {
    if (!controller || !slug) {
      return
    }

    try {
      setBoard(await controller.board(slug, { includeArchived: archived }))
      setError(null)
    } catch (cause) {
      fail(cause)
    }
  }, [controller, slug, archived, fail])

  const loadCard = useCallback(async () => {
    if (!controller || !slug || !openCard) {
      return
    }

    try {
      setDetail(await controller.card(slug, openCard))
    } catch (cause) {
      fail(cause)
    }
  }, [controller, slug, openCard, fail])

  useEffect(() => {
    void loadBoards()
  }, [loadBoards])

  useEffect(() => {
    void loadBoard()
  }, [loadBoard])

  useEffect(() => {
    void loadCard()
  }, [loadCard])

  const back = useCallback(() => {
    if (openCard) {
      setOpenCard(null)
      setDetail(null)
    } else if (slug) {
      setSlug(null)
      setBoard(null)
    }

    setNotice(null)
  }, [openCard, slug])

  useEscapeKey(back, Boolean(slug || openCard))
  useHardwareBack(back, Boolean(slug || openCard))

  const move = (card: Card, column: string) => {
    if (!controller || !slug) {
      return
    }

    setNotice(null)
    void controller
      .move(slug, card.id, column)
      .then(result => {
        /*
          The applied column is not always the requested one — a card leaving
          `running` is re-routed by the server — so the notice says which one
          actually happened rather than echoing the request back.
        */
        setNotice(
          result.applied === column
            ? kanbanStrings.moved(columnLabel(column))
            : kanbanStrings.movedElsewhere(columnLabel(column), columnLabel(result.applied))
        )

        return Promise.all([loadBoard(), loadCard()])
      })
      .catch((cause: unknown) => {
        // The server's own sentence names the blocking cards; nothing here can.
        setNotice(cause instanceof KanbanRefused ? kanbanStrings.moveRefused(cause.detail) : String(cause))
      })
  }

  if (absent) {
    return (
      <Screen edgeToEdgeTop padded={false}>
        <ScreenHeader back={backLabel} onBack={onClose} title={kanbanStrings.title} />
        <Pad>
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {kanbanStrings.absentHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted" testID="kanban-absent">
                {kanbanStrings.absent}
              </Text>
            </InsetRow>
            <InsetRow>
              <Text testID="kanban-command" variant="code">
                {kanbanStrings.absentCommand}
              </Text>
            </InsetRow>
          </InsetGroup>
        </Pad>
      </Screen>
    )
  }

  if (openCard && detail && slug && controller) {
    return (
      <CardScreen
        card={detail}
        onArchive={() => {
          void controller
            .archive(slug, openCard)
            .then(() => {
              setNotice(kanbanStrings.card.archived)
              setOpenCard(null)
              setDetail(null)

              return loadBoard()
            })
            .catch(fail)
        }}
        onBack={back}
        onComment={text => controller.comment(slug, openCard, text).then(loadCard)}
        onMove={column => move(detail.card, column)}
        onSave={patch => controller.edit(slug, openCard, patch).then(loadCard)}
      />
    )
  }

  if (slug) {
    return (
      <BoardScreen
        archived={archived}
        board={board}
        error={error}
        notice={notice}
        onBack={back}
        onCreate={column => setCreating(column)}
        onMove={move}
        onOpen={id => setOpenCard(id)}
        onRefresh={loadBoard}
        /*
          A drop the app refused, said in the same place a refusal from the
          server is said. The reader let go on a column the dispatcher owns;
          nothing was sent, because upstream raises on `running` before it
          looks at anything else and a 400 the app can predict is a round trip
          spent on a sentence the column already knew.
        */
        onRefused={column => setNotice(kanbanStrings.lockedTarget(columnLabel(column)))}
        onToggleArchived={() => setArchived(current => !current)}
        title={boards?.find(entry => entry.slug === slug)?.name ?? slug}
        wide={width >= WIDE_BOARD_PX}
        {...(creating !== null && controller
          ? {
              creating,
              onCancelCreate: () => setCreating(null),
              onSubmitCreate: async input => {
                await controller.create(slug, { ...input, column: creating })
                setCreating(null)
                await loadBoard()
              }
            }
          : {})}
      />
    )
  }

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader back={backLabel} onBack={onClose} subtitle={kanbanStrings.subtitle} title={kanbanStrings.title} />

      <ScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true)
              void loadBoards().finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
          />
        }
      >
        {error ? (
          <Text color="dangerText" testID="kanban-error">
            {kanbanStrings.failed(error)}
          </Text>
        ) : boards === null ? (
          <Text color="textMuted">{kanbanStrings.loading}</Text>
        ) : boards.length === 0 ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {kanbanStrings.emptyHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted" testID="kanban-empty">
                {kanbanStrings.empty}
              </Text>
            </InsetRow>
          </InsetGroup>
        ) : (
          <InsetGroup>
            {boards.map(entry => (
              <Pressable
                accessibilityLabel={`${entry.name}, ${kanbanStrings.boardCards(entry.total)}`}
                accessibilityRole="button"
                key={entry.slug}
                onPress={() => setSlug(entry.slug)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
                  gap: theme.space.xxs,
                  paddingHorizontal: theme.space.md,
                  paddingVertical: theme.space.sm
                })}
                testID={`kanban-board-${entry.slug}`}
              >
                <Text>{entry.name}</Text>
                <Text color="textMuted" variant="meta">
                  {kanbanStrings.boardCards(entry.total)}
                  {entry.description ? ` · ${entry.description}` : ''}
                </Text>
              </Pressable>
            ))}
          </InsetGroup>
        )}
      </ScrollView>
    </Screen>
  )
}

function Pad({ children }: { children: React.ReactNode }) {
  const theme = useTheme()

  return (
    <ScrollView
      contentContainerStyle={{
        alignSelf: 'center',
        gap: theme.space.xl,
        maxWidth: FORM_MAX_WIDTH,
        padding: theme.space.lg,
        width: '100%'
      }}
      ref={directTouchPanRef}
    >
      {children}
    </ScrollView>
  )
}

function BoardScreen({
  archived,
  board,
  creating,
  error,
  notice,
  onBack,
  onCancelCreate,
  onCreate,
  onMove,
  onOpen,
  onRefresh,
  onRefused,
  onSubmitCreate,
  onToggleArchived,
  title,
  wide
}: {
  archived: boolean
  board: BoardView | null
  creating?: string
  error: string | null
  notice: string | null
  onBack: () => void
  onCancelCreate?: () => void
  onCreate: (column: string) => void
  onMove: (card: Card, column: string) => void
  onOpen: (id: string) => void
  onRefresh: () => Promise<void>
  onRefused: (column: string) => void
  onSubmitCreate?: (input: { title: string; body?: string | null }) => Promise<void>
  onToggleArchived: () => void
  title: string
  wide: boolean
}) {
  const theme = useTheme()
  const [refreshing, setRefreshing] = useState(false)

  /*
    The horizontal scroller, and the row of columns inside it.

    Two separate handles because they answer two different questions: the
    scroller is what an edge drag scrolls, and the ROW is the coordinate space
    every column measured itself in. Measuring the scroller instead would be
    out by however far the board is scrolled, which is the one error a drop
    cannot survive.
  */
  const scroller = useRef<ScrollView | null>(null)
  const columnRow = useRef<View | null>(null)
  const scrolledTo = useRef(0)

  const columnTargets: ColumnTarget[] = useMemo(
    () => (board?.columns ?? []).map(column => ({ droppable: column.droppable, name: column.name })),
    [board]
  )

  const cardsById = useMemo(() => {
    const index = new Map<string, Card>()

    for (const column of board?.columns ?? []) {
      for (const card of column.cards) {
        index.set(card.id, card)
      }
    }

    return index
  }, [board])

  /*
    Where a fresh measurement is posted.

    An indirection rather than `drag.onRowLeft` written straight into the
    option, because that option is built to construct `drag` and naming it
    there reads as a cycle even though the callback only ever runs later.
  */
  const reportRowLeft = useRef<(x: number) => void>(() => undefined)

  const drag = useCardDrag({
    enabled: wide,
    measureRow: () => {
      // `measureInWindow` rather than an `onLayout`: the row's x inside its
      // scroll view is not where it is on screen, and a sidebar, a rotation or
      // a resized window all move the difference.
      columnRow.current?.measureInWindow(x => reportRowLeft.current(x))
    },
    onAutoScroll: delta => {
      scrolledTo.current = Math.max(0, scrolledTo.current + delta)
      scroller.current?.scrollTo({ animated: false, x: scrolledTo.current })
    },
    onDrop: (cardId, resolution) => {
      const card = cardsById.get(cardId)

      if (!card) {
        return
      }

      if (resolution.kind === 'refused') {
        onRefused(resolution.column)

        return
      }

      if (resolution.kind === 'move') {
        onMove(card, resolution.column)
      }
    },
    reduceMotion: theme.reduceMotion,
    targets: columnTargets
  })

  reportRowLeft.current = drag.onRowLeft

  if (creating !== undefined && onSubmitCreate && onCancelCreate) {
    return <CreateCard column={creating} onCancel={onCancelCreate} onSubmit={onSubmitCreate} />
  }

  const targets = (board?.columns ?? []).filter(column => column.droppable).map(column => column.name)

  const body = (
    <>
      {error ? (
        <Text color="dangerText" testID="kanban-board-error">
          {kanbanStrings.failed(error)}
        </Text>
      ) : null}

      {notice ? (
        <Text color="textMuted" testID="kanban-notice" variant="meta">
          {notice}
        </Text>
      ) : null}

      {board === null ? (
        <Text color="textMuted">{kanbanStrings.board.loading}</Text>
      ) : (
        <View
          onLayout={() => {
            // The row has been laid out somewhere new. Re-read its left edge so
            // that a drag armed before the next layout still resolves correctly.
            columnRow.current?.measureInWindow(x => drag.onRowLeft(x))
          }}
          ref={columnRow}
          style={
            wide ? { flexDirection: 'row', gap: theme.space.md } : { flexDirection: 'column', gap: theme.space.xl }
          }
        >
          {board.columns.map(column => {
            const state = wide ? drag.stateFor({ droppable: column.droppable, name: column.name }) : 'idle'

            return (
              <ColumnBand
                key={column.name}
                onMeasure={box => drag.measureColumn(column.name, box)}
                state={state}
                wide={wide}
              >
                <InsetGroup header={`${columnLabel(column.name)} · ${column.cards.length}`}>
                  {column.cards.length === 0 ? (
                    <InsetRow>
                      <Text color="textMuted" variant="meta">
                        {kanbanStrings.board.columnEmpty}
                      </Text>
                    </InsetRow>
                  ) : (
                    column.cards.map(card => (
                      <CardRow
                        card={card}
                        drag={wide ? drag : null}
                        key={card.id}
                        onMove={next => onMove(card, next)}
                        onOpen={() => onOpen(card.id)}
                        targets={targets.filter(name => name !== card.status)}
                      />
                    ))
                  )}
                  {column.droppable ? (
                    <InsetRow>
                      <Button
                        onPress={() => onCreate(column.name)}
                        testID={`kanban-new-${column.name}`}
                        title={kanbanStrings.board.newCard}
                        variant="secondary"
                      />
                    </InsetRow>
                  ) : null}
                </InsetGroup>
              </ColumnBand>
            )
          })}
        </View>
      )}

      {/* Said once, under the board, rather than as three dead drop targets. */}
      <Text color="textMuted" testID="kanban-locked-note" variant="meta">
        {kanbanStrings.locked}
      </Text>
      <Text color="textMuted" variant="meta">
        {kanbanStrings.noOrder}
      </Text>
      {/* Only where the gesture exists. A stacked board has the menu and nothing else. */}
      {wide ? (
        <Text color="textMuted" testID="kanban-drag-hint" variant="meta">
          {kanbanStrings.dragHint}
        </Text>
      ) : null}
    </>
  )

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader
        action={
          <Pressable
            accessibilityLabel={archived ? kanbanStrings.board.hideArchived : kanbanStrings.board.showArchived}
            accessibilityRole="button"
            onPress={onToggleArchived}
            testID="kanban-archived-toggle"
          >
            <Text color="accentText" variant="preview">
              {archived ? kanbanStrings.board.hideArchived : kanbanStrings.board.showArchived}
            </Text>
          </Pressable>
        }
        back={kanbanStrings.board.back}
        onBack={onBack}
        title={title}
      />

      <ScrollView
        contentContainerStyle={{
          alignSelf: wide ? 'flex-start' : 'center',
          gap: theme.space.lg,
          maxWidth: wide ? undefined : FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true)
              void onRefresh().finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
          />
        }
      >
        {/* A wide board scrolls sideways; a phone stacks the columns. */}
        {wide ? (
          <ScrollView
            horizontal
            onLayout={event => drag.onViewportWidth(event.nativeEvent.layout.width)}
            onScroll={event => {
              scrolledTo.current = event.nativeEvent.contentOffset.x
              drag.onScroll(event.nativeEvent.contentOffset.x)
            }}
            ref={scroller}
            // Every frame, because a lifted card is positioned against this
            // number: a throttled one leaves the card lagging the board it is
            // being dragged over.
            scrollEventThrottle={16}
            showsHorizontalScrollIndicator
          >
            <View style={{ gap: theme.space.lg }}>{body}</View>
          </ScrollView>
        ) : (
          body
        )}
      </ScrollView>
    </Screen>
  )
}

/**
 * One column's band, which is the thing a card is dropped ON.
 *
 * A wrapper rather than a style on the column itself, for two reasons. It is
 * the view whose `onLayout` reports the band — a direct child of the row, so
 * its `x` is already in the coordinates `card-drag.ts` wants — and it is where
 * a column says, for the length of a drag, whether it is a place this card can
 * go. The three the dispatcher owns dim and say so from the moment the card
 * lifts, which is the drag's version of the menu simply not listing them.
 */
function ColumnBand({
  children,
  onMeasure,
  state,
  wide
}: {
  children: React.ReactNode
  onMeasure: (box: { x: number; width: number }) => void
  state: ColumnDragState
  wide: boolean
}) {
  const theme = useTheme()
  const accent = theme.accent()

  return (
    <View
      onLayout={event => onMeasure({ width: event.nativeEvent.layout.width, x: event.nativeEvent.layout.x })}
      style={[
        wide ? { width: COLUMN_WIDTH } : undefined,
        // A ring rather than a fill: the cards inside carry their own surfaces,
        // and a wash under them would read as a selected column rather than as
        // a target.
        {
          borderColor: state === 'target' ? accent.fill : 'transparent',
          borderRadius: theme.radii.lg,
          borderWidth: 2,
          // The band's own padding stays zero so the columns do not shift
          // sideways when a drag begins; the ring is drawn on the margin the
          // gap already provides.
          margin: -2,
          opacity: state === 'refused' ? 0.45 : 1,
          padding: 2
        }
      ]}
      testID={`kanban-column-${state}`}
    >
      {children}
    </View>
  )
}

/**
 * One card, with the move menu folded open in place.
 *
 * The menu lists only columns that will TAKE a card — the three the dispatcher
 * owns are filtered out upstream of here — so every option in it works. It is
 * present on every layout and it is what VoiceOver and a keyboard use: the
 * drag is an addition for a window wide enough to show the columns at once,
 * never a replacement.
 */
function CardRow({
  card,
  drag,
  onMove,
  onOpen,
  targets
}: {
  card: Card
  /** Null where this layout does not drag, which is every narrow window. */
  drag: CardDrag | null
  onMove: (column: string) => void
  onOpen: () => void
  targets: string[]
}) {
  const theme = useTheme()
  const [menu, setMenu] = useState(false)

  const lifted = drag?.draggingId === card.id

  return (
    <Animated.View
      // Only the lifted card is raised and only while it is lifted: a `zIndex`
      // on every card would order them against each other for nothing, and the
      // cell that has to be on top is the one being carried.
      style={
        lifted && drag
          ? {
              elevation: 8,
              shadowColor: '#000',
              shadowOffset: { height: 6, width: 0 },
              shadowOpacity: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] }),
              shadowRadius: 14,
              transform: [
                { translateX: drag.translate.x },
                { translateY: drag.translate.y },
                { scale: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [1, CARD_LIFT_SCALE] }) }
              ],
              zIndex: 10
            }
          : undefined
      }
      {...(drag ? drag.cardHandlers(card.id, card.status) : {})}
    >
      <Pressable
        accessibilityHint={drag ? kanbanStrings.dragLabel : undefined}
        accessibilityLabel={`${card.title}, ${columnLabel(card.status)}`}
        accessibilityRole="button"
        delayLongPress={300}
        onLongPress={drag ? () => drag.arm(card.id, card.status) : undefined}
        onPress={onOpen}
        onPressOut={drag ? drag.disarm : undefined}
        style={({ pressed }) => ({
          backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
          gap: theme.space.xxs,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm
        })}
        testID={`kanban-card-${card.id}`}
      >
        <Text numberOfLines={2}>{card.title}</Text>
        {card.assignee || card.commentCount ? (
          <Text color="textMuted" variant="meta">
            {[card.assignee, card.commentCount ? `${card.commentCount} 💬` : null].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </Pressable>

      <Pressable
        accessibilityLabel={kanbanStrings.move}
        accessibilityRole="button"
        onPress={() => setMenu(open => !open)}
        style={{ paddingBottom: theme.space.xs, paddingHorizontal: theme.space.md }}
        testID={`kanban-move-${card.id}`}
      >
        <Text color="accentText" variant="meta">
          {kanbanStrings.move}
        </Text>
      </Pressable>

      {menu ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.space.xs,
            paddingHorizontal: theme.space.md,
            paddingBottom: theme.space.sm
          }}
        >
          {targets.map(column => (
            <Pressable
              accessibilityLabel={columnLabel(column)}
              accessibilityRole="button"
              key={column}
              onPress={() => {
                setMenu(false)
                onMove(column)
              }}
              style={{
                backgroundColor: theme.tintSunk,
                borderColor: theme.hairlineSoft,
                borderRadius: theme.radii.inset,
                borderWidth: 1,
                paddingHorizontal: theme.space.md,
                paddingVertical: theme.space.xs
              }}
              testID={`kanban-move-${card.id}-${column}`}
            >
              <Text variant="meta">{columnLabel(column)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Animated.View>
  )
}

function CreateCard({
  column,
  onCancel,
  onSubmit
}: {
  column: string
  onCancel: () => void
  onSubmit: (input: { title: string; body?: string | null }) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader
        back={kanbanStrings.board.back}
        onBack={onCancel}
        subtitle={columnLabel(column)}
        title={kanbanStrings.create.title}
      />

      <Pad>
        <TextField
          label={kanbanStrings.create.titleField}
          onChangeText={setTitle}
          placeholder={kanbanStrings.create.titlePlaceholder}
          testID="kanban-create-title"
          value={title}
        />
        <TextField
          label={kanbanStrings.create.bodyField}
          multiline
          onChangeText={setBody}
          testID="kanban-create-body"
          value={body}
        />

        {error ? (
          <Text color="dangerText" testID="kanban-create-error">
            {error}
          </Text>
        ) : null}

        <Button
          busy={busy}
          onPress={() => {
            if (!title.trim()) {
              setError(kanbanStrings.create.needsTitle)

              return
            }

            setBusy(true)
            setError(null)
            void onSubmit({ title: title.trim(), body: body.trim() || null })
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false))
          }}
          testID="kanban-create-submit"
          title={busy ? kanbanStrings.create.submitting : kanbanStrings.create.submit}
        />
      </Pad>
    </Screen>
  )
}

function CardScreen({
  card,
  onArchive,
  onBack,
  onComment,
  onMove,
  onSave
}: {
  card: CardDetail
  onArchive: () => void
  onBack: () => void
  onComment: (text: string) => Promise<unknown>
  onMove: (column: string) => void
  onSave: (patch: { title?: string; body?: string | null }) => Promise<unknown>
}) {
  const theme = useTheme()
  const [title, setTitle] = useState(card.card.title)
  const [body, setBody] = useState(card.card.body ?? '')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader
        back={kanbanStrings.card.back}
        onBack={onBack}
        subtitle={columnLabel(card.card.status)}
        title={card.card.title}
      />

      <Pad>
        <TextField label={kanbanStrings.card.title} onChangeText={setTitle} testID="kanban-card-title" value={title} />
        <TextField
          label={kanbanStrings.card.body}
          multiline
          onChangeText={setBody}
          testID="kanban-card-body"
          value={body}
        />

        <Button
          busy={busy}
          onPress={() => {
            setBusy(true)
            void onSave({ title: title.trim(), body: body.trim() || null })
              .then(() => setNotice(kanbanStrings.card.saved))
              .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false))
          }}
          testID="kanban-card-save"
          title={busy ? kanbanStrings.card.saving : kanbanStrings.card.save}
        />

        <InsetGroup>
          <InsetValueRow label={kanbanStrings.card.column} value={columnLabel(card.card.status)} />
          <InsetValueRow label={kanbanStrings.card.assignee} value={card.card.assignee ?? '—'} />
          <InsetValueRow label={kanbanStrings.card.priority} value={String(card.card.priority)} />
        </InsetGroup>

        {card.card.latestSummary ? (
          <InsetGroup header={kanbanStrings.card.summary}>
            <InsetRow>
              <Text variant="meta">{card.card.latestSummary}</Text>
            </InsetRow>
          </InsetGroup>
        ) : null}

        {/* Move is here too, so a card opened from a column can leave it. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }}>
          {['triage', 'todo', 'ready', 'blocked', 'done']
            .filter(column => column !== card.card.status)
            .map(column => (
              <Pressable
                accessibilityLabel={columnLabel(column)}
                accessibilityRole="button"
                key={column}
                onPress={() => onMove(column)}
                style={{
                  backgroundColor: theme.tintSunk,
                  borderColor: theme.hairlineSoft,
                  borderRadius: theme.radii.inset,
                  borderWidth: 1,
                  paddingHorizontal: theme.space.md,
                  paddingVertical: theme.space.xs
                }}
                testID={`kanban-card-move-${column}`}
              >
                <Text variant="meta">{columnLabel(column)}</Text>
              </Pressable>
            ))}
        </View>

        <InsetGroup header={kanbanStrings.comments.header}>
          {card.comments.length === 0 ? (
            <InsetRow>
              <Text color="textMuted" variant="meta">
                {kanbanStrings.comments.none}
              </Text>
            </InsetRow>
          ) : (
            card.comments.map(entry => (
              <InsetRow key={entry.id}>
                <View style={{ gap: theme.space.xxs }}>
                  <Text color="textMuted" variant="meta">
                    {entry.author}
                  </Text>
                  <Text>{entry.body}</Text>
                </View>
              </InsetRow>
            ))
          )}
        </InsetGroup>

        <TextField
          label={kanbanStrings.comments.add}
          multiline
          onChangeText={setComment}
          placeholder={kanbanStrings.comments.placeholder}
          testID="kanban-comment-field"
          value={comment}
        />
        <Button
          onPress={() => {
            if (!comment.trim()) {
              return
            }

            const text = comment.trim()
            setComment('')
            void onComment(text).catch((cause: unknown) =>
              setNotice(cause instanceof Error ? cause.message : String(cause))
            )
          }}
          testID="kanban-comment-submit"
          title={kanbanStrings.comments.add}
          variant="secondary"
        />

        {notice ? (
          <Text color="textMuted" testID="kanban-card-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        <InsetGroup
          footer={
            <Text color="textMuted" variant="meta">
              {kanbanStrings.card.archiveHint}
            </Text>
          }
        >
          <InsetRow>
            <Button
              onPress={onArchive}
              testID="kanban-card-archive"
              title={kanbanStrings.card.archive}
              variant="secondary"
            />
          </InsetRow>
        </InsetGroup>
      </Pad>
    </Screen>
  )
}
