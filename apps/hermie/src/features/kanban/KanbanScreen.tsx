/**
 * Boards: the board list, one board's columns, and one card.
 *
 * One screen with early-return sub-screens, the shape the MCP, Crons and
 * Connectors pages use, and for the same reason: the compact and regular shells
 * own their own navigation and disagree about what "push" means.
 *
 * **Moving a card is a menu, on every layout.** The brief asked for a drag on
 * wide windows and a menu on phones; the menu is what is here, and the columns
 * lay out side by side on a wide window so a drag could be added later without
 * moving anything else. A half-working cross-column gesture would be worse than
 * a control that always works, and the menu is also the only form that can
 * REFUSE well — three of the eight columns are the dispatcher's and are simply
 * not offered, rather than being dead drop targets a reader keeps aiming at.
 *
 * Dragging a card up or down inside a column is not missing, it is meaningless:
 * there is no order on the wire. The server sorts by priority and age, so the
 * page says so instead of implying a rank it could not save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native'

import { useGateway } from '../../gateway'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { Button, InsetGroup, InsetRow, InsetValueRow, Screen, Text, TextField } from '../../ui/primitives'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { useTheme } from '../../ui/theme'
import { ScreenHeader } from '../cron/ScreenHeader'
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
  onSubmitCreate?: (input: { title: string; body?: string | null }) => Promise<void>
  onToggleArchived: () => void
  title: string
  wide: boolean
}) {
  const theme = useTheme()
  const [refreshing, setRefreshing] = useState(false)

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
          style={
            wide ? { flexDirection: 'row', gap: theme.space.md } : { flexDirection: 'column', gap: theme.space.xl }
          }
        >
          {board.columns.map(column => (
            <View key={column.name} style={wide ? { width: COLUMN_WIDTH } : undefined}>
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
            </View>
          ))}
        </View>
      )}

      {/* Said once, under the board, rather than as three dead drop targets. */}
      <Text color="textMuted" testID="kanban-locked-note" variant="meta">
        {kanbanStrings.locked}
      </Text>
      <Text color="textMuted" variant="meta">
        {kanbanStrings.noOrder}
      </Text>
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
          <ScrollView horizontal showsHorizontalScrollIndicator>
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
 * One card, with the move menu folded open in place.
 *
 * The menu lists only columns that will TAKE a card — the three the dispatcher
 * owns are filtered out upstream of here — so every option in it works.
 */
function CardRow({
  card,
  onMove,
  onOpen,
  targets
}: {
  card: Card
  onMove: (column: string) => void
  onOpen: () => void
  targets: string[]
}) {
  const theme = useTheme()
  const [menu, setMenu] = useState(false)

  return (
    <View>
      <Pressable
        accessibilityLabel={`${card.title}, ${columnLabel(card.status)}`}
        accessibilityRole="button"
        onPress={onOpen}
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
    </View>
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
