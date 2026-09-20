/**
 * The chat list — the first thing the app shows, and the owner's own
 * arrangement of it.
 *
 * Two halves that are easy to confuse. The ROSTER is the gateway's: which bots
 * exist, what they last said, whether they are running. The LAYOUT is this
 * device's: the order, the named dividers, what is archived, what colour each
 * chat carries (ADR-0012). The roster decides which rows can exist; the layout
 * decides where they sit. `reconcile` is the one place the two meet.
 *
 * Three pieces of state are deliberately NOT roster fields and cannot be:
 *
 *  - "working" has two sources, and needs both. `session.active_list` is polled
 *    while this list is mounted, because an unwatched roster has nothing to
 *    animate; it answers for the whole gateway process and carries no profile,
 *    so the roster controller attributes each busy row to a bot by session id.
 *    The chat's own streaming `turn.active` is the second source: it is true the
 *    moment a turn is sent, for that bot alone, without waiting for a poll.
 *  - "needs input" comes from the open approvals and clarifies the chat store
 *    already holds, so it survives a roster refresh and is true even for a
 *    question that arrived while this screen was not on top.
 *  - "unread" is a timestamp comparison against a per-bot watermark.
 *
 * The same component is the wide layout's sidebar and the phone's Chats screen.
 * The only difference is density and the title size — the tab strip and the
 * gateway card are in both, because both mockup frames show them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, TextInput, View } from 'react-native'

import { unreadCountSince } from '@hermie/transcript'

import { useGateway } from '../../gateway'
import { SignedOutPanel } from '../../gateway/SignedOutPanel'
import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSafeAreaInsets } from '../../platform/safe-area'
import { isUnread, useBotsStore, type Bot } from '../../store/bots'
import { archivedOf, dividersOf, sectionsOf, useChatLayoutStore } from '../../store/chat-layout'
import { useChatsStore } from '../../store/chats'
import { GlassSurface } from '../../ui/glass'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP, type AccentName } from '../../ui/tokens'
import { useChatRuntime } from '../chats/ChatRuntime'
import { BotRow } from './BotRow'
import { ConnectionLine } from './ConnectionLine'
import { CHAT_FILTERS, matchesFilter, presenceOf, type ChatFilter, type Presence } from './presence'
import { RowMenu } from './RowMenu'
import { SidebarFooter, type BotsSection, type TabKey } from './SidebarFooter'

export type { BotsSection }

export interface BotsScreenProps {
  /** Compact shell: navigate. Regular shell: select in place. */
  onOpenBot?: (bot: Bot) => void
  selectedBot?: string | undefined
  onOpenSection?: (section: BotsSection) => void
  /** Which footer tab reads as current; the wide shell drives this from its overlay. */
  currentTab?: TabKey
  variant?: 'screen' | 'sidebar'
}

/**
 * An archived bot is shown as offline whatever the roster says. It is excluded
 * from the polls and the counts, so any other bead would be a stale claim.
 * Shared rather than built per render, so `BotRow`'s memo holds.
 */
const ARCHIVED_PRESENCE: Presence = { state: 'offline' }

type ListItem =
  | { key: string; kind: 'divider'; id: string | null; name: string }
  | { key: string; kind: 'sectionEmpty'; id: string }
  | { key: string; kind: 'bot'; bot: Bot; archived: boolean }
  | { key: string; kind: 'archiveHeader'; count: number }

/** Name or description, case-insensitively — what a reader would type. */
function matches(bot: Bot, query: string): boolean {
  if (!query) {
    return true
  }

  const needle = query.trim().toLowerCase()

  return (
    bot.displayName.toLowerCase().includes(needle) ||
    bot.name.toLowerCase().includes(needle) ||
    bot.description.toLowerCase().includes(needle)
  )
}

export function BotsScreen({
  currentTab = 'chats',
  onOpenBot,
  onOpenSection,
  selectedBot,
  variant = 'screen'
}: BotsScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const runtime = useChatRuntime()
  const { status } = useGateway()
  const bots = useBotsStore(state => state.bots)
  const byName = useBotsStore(state => state.byName)
  const running = useBotsStore(state => state.running)
  const lastSeen = useBotsStore(state => state.lastSeen)
  const avatars = useBotsStore(state => state.avatars)
  const loading = useBotsStore(state => state.loading)
  const error = useBotsStore(state => state.error)
  const chats = useChatsStore(state => state.chats)

  const entries = useChatLayoutStore(state => state.entries)
  const archivedSet = useChatLayoutStore(state => state.archived)
  const accents = useChatLayoutStore(state => state.accents)
  const reconcile = useChatLayoutStore(state => state.reconcile)

  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ChatFilter>('all')
  const [editing, setEditing] = useState(false)
  // Which divider was added by the button, so that one — and only that one —
  // opens with the keyboard in it. Cleared when edit mode ends, so leaving and
  // coming back does not steal focus for a section that already has a name.
  const [addedDividerId, setAddedDividerId] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const sidebar = variant === 'sidebar'
  const signedOut = status === 'needs_signin'

  // Stable identities, so that `BotRow`'s memo survives a roster refresh. A
  // fresh arrow per render would re-render forty rows because one of them
  // changed, which is the whole cost the memo is there to avoid.
  const openBot = useCallback((bot: Bot) => onOpenBot?.(bot), [onOpenBot])
  const moveBot = useCallback((name: string, offset: number) => {
    useChatLayoutStore.getState().moveBy(name, offset)
  }, [])

  useEffect(() => {
    // Running state is polled only while this list is mounted; an unwatched
    // roster has nothing to animate.
    return runtime?.bots.watchRunning()
  }, [runtime])

  useEffect(() => {
    reconcile(bots.map(bot => bot.name))
  }, [bots, reconcile])

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await runtime?.bots.refresh()
    } catch {
      // The store already holds the message; the list keeps what it had.
    } finally {
      setRefreshing(false)
    }
  }, [runtime])

  /**
   * One pass over the roster for every derived thing a row needs.
   *
   * Computed here rather than per row so that the filter chips can filter on
   * presence: a chip that hides everything except "Working" has to know which
   * rows those are before it renders any of them.
   */
  const presence = useMemo(() => {
    const map = new Map<string, Presence>()

    for (const bot of bots) {
      const chat = chats[bot.name]
      const needsInput = chat
        ? chat.order.some(id => {
            const item = chat.items[id]

            return (item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'open'
          })
        : false

      map.set(
        bot.name,
        presenceOf({
          gatewayReady: status === 'ready',
          needsInput,
          sessionAttached: Boolean(bot.canonical?.id),
          working: Boolean(running[bot.name]) || (chat?.turn.active ?? false),
          ...(bot.canonical?.lastActive ? { lastActive: bot.canonical.lastActive } : {})
        })
      )
    }

    return map
  }, [bots, chats, running, status])

  const unreadFor = useCallback(
    (name: string) => {
      const chat = chats[name]
      const count = chat ? unreadCountSince(chat, lastSeen[name] ?? 0) : 0

      return { count, unread: isUnread({ byName, lastSeen }, name) || count > 0 }
    },
    [byName, chats, lastSeen]
  )

  const sections = useMemo(() => sectionsOf(entries, archivedSet), [entries, archivedSet])
  const archivedNames = useMemo(() => archivedOf(entries, archivedSet), [entries, archivedSet])
  const dividers = useMemo(() => dividersOf(entries), [entries])

  /**
   * The list, flattened.
   *
   * Archived bots are excluded from the filters and from the unread totals —
   * archiving a bot is how you stop it counting — so they are appended after
   * the filter has run rather than passed through it.
   *
   * **An empty named section keeps its heading and gets a row of its own.** It
   * used to be dropped unless the list was in edit mode, which had two costs: a
   * section the owner had made vanished as soon as its last chat moved out, so
   * there was nothing left to move a chat back INTO; and in edit mode two
   * headings then landed back to back with only a heading's own padding between
   * them, which reads as one run-on line rather than as two sections. A heading
   * plus an explicit empty row cannot do either.
   *
   * A search or a filter is the exception: those narrow the list on purpose,
   * and answering "no matches" once per section would bury the matches.
   */
  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = []
    const narrowed = Boolean(query.trim()) || filter !== 'all'

    for (const section of sections) {
      const visible = section.bots
        .map(name => byName[name])
        .filter((bot): bot is Bot => Boolean(bot))
        .filter(bot => matches(bot, query))
        .filter(bot => {
          const state = presence.get(bot.name)

          return state ? matchesFilter(filter, state, unreadFor(bot.name).unread) : false
        })

      // The unsectioned top group has no heading, so an empty one is nothing.
      if (!section.divider) {
        for (const bot of visible) {
          out.push({ archived: false, bot, key: `bot:${bot.name}`, kind: 'bot' })
        }

        continue
      }

      if (!visible.length && narrowed && !editing) {
        continue
      }

      out.push({
        id: section.divider.id,
        key: `divider:${section.divider.id}`,
        kind: 'divider',
        name: section.divider.name
      })

      if (!visible.length) {
        out.push({ id: section.divider.id, key: `empty:${section.divider.id}`, kind: 'sectionEmpty' })
      }

      for (const bot of visible) {
        out.push({ archived: false, bot, key: `bot:${bot.name}`, kind: 'bot' })
      }
    }

    if (archivedNames.length) {
      out.push({ count: archivedNames.length, key: 'archive', kind: 'archiveHeader' })

      if (archiveOpen) {
        for (const name of archivedNames) {
          const bot = byName[name]

          if (bot) {
            out.push({ archived: true, bot, key: `archived:${name}`, kind: 'bot' })
          }
        }
      }
    }

    return out
  }, [archiveOpen, archivedNames, byName, editing, filter, presence, query, sections, unreadFor])

  const hasRows = items.some(item => item.kind === 'bot')

  // A chat-level failure must not compete with the signed-out card: a dead
  // session is not a roster problem and showing both makes neither readable.
  const rosterError = signedOut ? null : error

  return (
    // The sidebar sits inside a panel the shell has already inset; the phone
    // screen is full-bleed and has to clear the notch and the home bar itself.
    <View style={sidebar ? { flex: 1 } : { flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
      <Head
        editing={editing}
        onToggleEdit={() => {
          setEditing(current => !current)
          setAddedDividerId(null)
        }}
        sidebar={sidebar}
        {...(onOpenSection ? { onNewCron: () => onOpenSection('cron') } : {})}
      />

      {/*
        One connection line, on every layout, under the title. It draws nothing
        while the connection is healthy — see `ConnectionLine`.
      */}
      <ConnectionLine />

      <SearchField onChangeText={setQuery} value={query} />

      <Filters current={filter} onChange={setFilter} />

      {signedOut ? (
        <Text
          color="warnText"
          style={{ paddingBottom: theme.space.sm, paddingHorizontal: theme.space.lg }}
          variant="meta"
        >
          {strings.signedOut.listNote}
        </Text>
      ) : null}

      <FlatList
        ref={directTouchPanRef}
        ListEmptyComponent={
          <EmptyState
            error={rosterError}
            filtered={filter !== 'all'}
            loading={loading}
            query={query}
            searching={Boolean(query.trim())}
          />
        }
        data={items}
        extraData={hasRows}
        keyExtractor={item => item.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
        renderItem={({ item }) => {
          if (item.kind === 'archiveHeader') {
            return (
              <ArchiveHeader count={item.count} onToggle={() => setArchiveOpen(open => !open)} open={archiveOpen} />
            )
          }

          if (item.kind === 'divider') {
            return <Divider autoFocus={item.id === addedDividerId} editing={editing} id={item.id} name={item.name} />
          }

          if (item.kind === 'sectionEmpty') {
            return <SectionEmpty id={item.id} />
          }

          const state = presence.get(item.bot.name) ?? ARCHIVED_PRESENCE
          const { count, unread } = unreadFor(item.bot.name)

          return (
            <BotRow
              accent={accents[item.bot.name] ?? 'default'}
              bot={item.bot}
              compact={!sidebar}
              editing={editing && !item.archived}
              onMove={moveBot}
              onOpenMenu={setMenuFor}
              onPress={openBot}
              presence={item.archived ? ARCHIVED_PRESENCE : state}
              selected={item.bot.name === selectedBot}
              unread={item.archived ? false : unread}
              unreadCount={item.archived ? 0 : count}
              {...(avatars[item.bot.name] ? { avatarUri: avatars[item.bot.name] } : {})}
            />
          )
        }}
        style={{ flex: 1 }}
        testID="bots-list"
      />

      {editing ? <EditBar onAddDivider={setAddedDividerId} /> : null}

      {onOpenSection ? <SidebarFooter current={currentTab} onOpenSection={onOpenSection} /> : null}

      {menuFor ? (
        <RowMenu
          accent={accents[menuFor] ?? 'default'}
          archived={Boolean(archivedSet[menuFor])}
          botName={menuFor}
          displayName={byName[menuFor]?.displayName ?? menuFor}
          onClose={() => setMenuFor(null)}
          onMoveToSection={id => useChatLayoutStore.getState().moveToSection(menuFor, id)}
          onSetAccent={(accent: AccentName) => useChatLayoutStore.getState().setAccent(menuFor, accent)}
          onSetArchived={archived => useChatLayoutStore.getState().setArchived(menuFor, archived)}
          sections={[
            { id: null, name: strings.layout.topGroup },
            ...dividers.map(divider => ({ id: divider.id, name: divider.name }))
          ]}
          visible
        />
      ) : null}
    </View>
  )
}

/** The compact shell's Chats screen shows the signed-out card in place of the list. */
export function BotsScreenOrSignedOut(props: BotsScreenProps) {
  const { status } = useGateway()

  return status === 'needs_signin' ? <SignedOutPanel /> : <BotsScreen {...props} />
}

function Head({
  editing,
  onNewCron,
  onToggleEdit,
  sidebar
}: {
  editing: boolean
  onNewCron?: () => void
  onToggleEdit: () => void
  sidebar: boolean
}) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.md,
        paddingBottom: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.panel
      }}
    >
      <Text style={{ flex: 1 }} variant={sidebar ? 'titleWide' : 'title'}>
        {strings.bots.title}
      </Text>

      {onNewCron ? (
        <Pressable
          accessibilityLabel={strings.bots.newCron}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onNewCron}
          testID="bots-new-cron"
        >
          <GlassSurface
            contentStyle={{ alignItems: 'center', height: 38, justifyContent: 'center', width: 38 }}
            variant="control"
          >
            <Text color="textMuted" style={{ fontSize: 18 }}>
              {'⊕'}
            </Text>
          </GlassSurface>
        </Pressable>
      ) : null}

      <Pressable accessibilityRole="button" hitSlop={TAP_SLOP} onPress={onToggleEdit} testID="bots-edit">
        <Text color="accentText" style={{ fontWeight: '600' }} variant="preview">
          {editing ? strings.layout.done : strings.layout.edit}
        </Text>
      </Pressable>
    </View>
  )
}

function SearchField({ onChangeText, value }: { onChangeText: (value: string) => void; value: string }) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: theme.tintSunk,
        borderColor: theme.hairlineSoft,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.space.sm,
        marginBottom: theme.space.md,
        marginHorizontal: theme.space.lg,
        paddingHorizontal: theme.space.md
      }}
    >
      <Text color="textFaint">{'⌕'}</Text>
      <TextInput
        accessibilityLabel={strings.bots.search}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={onChangeText}
        placeholder={strings.bots.search}
        placeholderTextColor={theme.colors.textFaint}
        style={{
          color: theme.colors.text,
          flex: 1,
          fontSize: 15,
          minHeight: CONTROL_MIN_HEIGHT
        }}
        testID="bots-search"
        value={value}
      />
    </View>
  )
}

function Filters({ current, onChange }: { current: ChatFilter; onChange: (filter: ChatFilter) => void }) {
  const theme = useTheme()

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 6,
        paddingBottom: theme.space.md,
        paddingHorizontal: theme.space.lg
      }}
    >
      {CHAT_FILTERS.map(filter => {
        const selected = filter === current

        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={filter}
            onPress={() => onChange(filter)}
            style={{
              backgroundColor: selected ? theme.colors.accent : theme.tintSunk,
              borderColor: selected ? 'transparent' : theme.hairlineSoft,
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              paddingHorizontal: theme.space.md,
              paddingVertical: 6
            }}
            testID={`filter-${filter}`}
          >
            <Text color={selected ? 'onAccent' : 'textMuted'} style={{ fontWeight: '600' }} variant="meta">
              {strings.bots.filters[filter]}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * A named section break.
 *
 * In edit mode the name becomes editable in place rather than opening a rename
 * dialog: the field is already the thing being renamed, and a dialog would be a
 * second modal on a screen that already has one for the row menu.
 */
function Divider({
  editing,
  id,
  name,
  autoFocus
}: {
  editing: boolean
  id: string | null
  name: string
  autoFocus?: boolean
}) {
  const theme = useTheme()

  if (!id) {
    return null
  }

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        paddingBottom: 6,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.lg
      }}
      testID={`divider-${id}`}
    >
      {editing ? (
        <TextInput
          accessibilityHint={strings.layout.editDividerHint}
          accessibilityLabel={strings.layout.dividerName}
          // A divider that has just been added is focused straight into: the
          // whole reason it exists is that it needs a name, and a section that
          // stays untitled is what put two headings next to each other.
          autoFocus={autoFocus === true}
          autoCapitalize="words"
          onChangeText={next => useChatLayoutStore.getState().renameDivider(id, next)}
          // The PLACEHOLDER, never the value. Seeding the field is what left
          // "New sectionFinance" on a real device.
          placeholder={strings.layout.dividerName}
          placeholderTextColor={theme.colors.textFaint}
          returnKeyType="done"
          selectTextOnFocus
          style={{
            backgroundColor: theme.tintSunk,
            // A hairline is what says "this is a field": a sunk tint alone is
            // nearly invisible on the light panel, so the one editable thing in
            // edit mode did not look editable.
            borderColor: theme.hairline,
            borderRadius: theme.radii.inset,
            borderWidth: 1,
            color: theme.colors.text,
            flex: 1,
            fontSize: 15,
            minHeight: 34,
            paddingHorizontal: theme.space.sm,
            paddingVertical: 6
          }}
          testID={`divider-name-${id}`}
          value={name}
        />
      ) : (
        <>
          <Text color="textFaint" variant="micro">
            {(name || strings.layout.unnamedSection).toUpperCase()}
          </Text>
          <View style={{ backgroundColor: theme.hairlineSoft, flex: 1, height: 1 }} />
        </>
      )}

      {editing ? (
        <Pressable
          accessibilityLabel={strings.layout.removeSection(name)}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={() => useChatLayoutStore.getState().removeDivider(id)}
          style={({ pressed }) => ({
            // A bordered chip rather than a bare word: Remove sat as plain text
            // beside a field that also looked like plain text, so neither of the
            // two things edit mode is FOR looked like a control.
            borderColor: theme.hairline,
            borderRadius: theme.radii.pill,
            borderWidth: 1,
            opacity: pressed ? 0.6 : 1,
            paddingHorizontal: theme.space.md,
            paddingVertical: 6
          })}
          testID={`divider-remove-${id}`}
        >
          <Text color="dangerText" variant="meta">
            {strings.layout.remove}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/**
 * A named section with nothing in it.
 *
 * It exists so the heading above it has a body, however empty: two headings
 * whose rows have all moved away would otherwise meet with nothing between
 * them, and read as one line.
 */
function SectionEmpty({ id }: { id: string }) {
  const theme = useTheme()

  return (
    <View
      style={{
        justifyContent: 'center',
        minHeight: 38,
        paddingBottom: theme.space.sm,
        paddingHorizontal: theme.space.lg
      }}
      testID={`section-empty-${id}`}
    >
      <Text color="textFaint" variant="meta">
        {strings.layout.sectionEmpty}
      </Text>
    </View>
  )
}

function ArchiveHeader({ count, onToggle, open }: { count: number; onToggle: () => void; open: boolean }) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        marginHorizontal: theme.space.sm,
        marginTop: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.md
      }}
      testID="archived-row"
    >
      {/* Decorative: the row's own expanded state is what a screen reader reads. */}
      <Text
        accessibilityElementsHidden
        color="textMuted"
        importantForAccessibility="no-hide-descendants"
        style={{ fontSize: 13 }}
      >
        {open ? '⌄' : '›'}
      </Text>
      <Text color="textMuted" style={{ fontWeight: '600' }} variant="preview">
        {strings.layout.archived(count)}
      </Text>
    </Pressable>
  )
}

function EditBar({ onAddDivider }: { onAddDivider: (id: string) => void }) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: theme.tintSunk,
        borderColor: theme.hairlineSoft,
        borderRadius: theme.radii.card,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.space.sm,
        marginHorizontal: theme.space.md,
        marginTop: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      testID="edit-bar"
    >
      <Text color="textMuted" style={{ flex: 1 }} variant="meta">
        {strings.layout.editHint}
      </Text>

      <Pressable
        accessibilityRole="button"
        hitSlop={TAP_SLOP}
        // Empty rather than pre-filled with "New section": the field is focused
        // straight into, and a seeded name means the first thing typed is
        // APPENDED to a word nobody asked for.
        onPress={() => onAddDivider(useChatLayoutStore.getState().addDivider(''))}
        testID="add-divider"
      >
        <Text color="accentText" style={{ fontWeight: '600' }} variant="meta">
          {strings.layout.addDivider}
        </Text>
      </Pressable>
    </View>
  )
}

function EmptyState({
  error,
  filtered,
  loading,
  query,
  searching
}: {
  error: string | null
  filtered: boolean
  loading: boolean
  query: string
  searching: boolean
}) {
  const theme = useTheme()

  const message = error
    ? strings.bots.failed(error)
    : searching
      ? strings.bots.noMatches(query.trim())
      : filtered
        ? strings.bots.noneMatchFilter
        : loading
          ? strings.bots.loading
          : strings.bots.empty

  return (
    <View style={{ gap: theme.space.sm, padding: theme.space.lg }}>
      <Text color={error ? 'dangerText' : 'textMuted'} testID="bots-empty">
        {message}
      </Text>
    </View>
  )
}
