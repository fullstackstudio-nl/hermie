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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'

import { snippetSegments, tidySnippet } from '@hermie/gateway-client'
import { unreadCountSince } from '@hermie/transcript'

import { useGateway } from '../../gateway'
import { SignedOutPanel } from '../../gateway/SignedOutPanel'
import { strings } from '../../i18n/strings'
import { ContextMenuHost, HAS_NATIVE_CONTEXT_MENU } from '../../platform/context-menu'
import { setMenuBar } from '../../platform/desktop-shortcuts'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSafeAreaInsets } from '../../platform/safe-area'
import { isUnread, useBotsStore, type Bot } from '../../store/bots'
import { archivedOf, dividersOf, sectionsOf, useChatLayoutStore } from '../../store/chat-layout'
import { useChatsStore } from '../../store/chats'
import { GlassSurface } from '../../ui/glass'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useHover } from '../../ui/useHover'
import { useNumberedShortcuts, useShortcut } from '../../ui/useShortcut'
import { CONTROL_MIN_HEIGHT, TAP_SLOP, type AccentName } from '../../ui/tokens'
import { formatListTime } from '../../chat-ui'
import { useChatRuntime } from '../chats/ChatRuntime'
import { type MessageMatch, useMessageSearch } from '../search'
import { BotRow } from './BotRow'
import { ConnectionLine } from './ConnectionLine'
import { dragAnchors, entryIndexByKey } from './drag-order'
import { presenceOf, type Presence } from './presence'
import { parseRowMenuAction } from './row-menu-items'
import { RowMenu } from './RowMenu'
import { SidebarFooter, type BotsSection, type TabKey } from './SidebarFooter'
import { SidebarRail } from './SidebarRail'
import { useRowDrag } from './use-row-drag'

export type { BotsSection }

/** What a tap on a row asks the shell for, beyond the bot itself. */
export interface OpenBotOptions {
  /**
   * Words to land on rather than the bottom of the chat.
   *
   * It is TEXT and not a row id because the gateway's search cannot name a row
   * — see `features/search/find-in-chat.ts`. The chat screen looks for it in
   * what it has loaded and says so when it is not there.
   */
  findText?: string
}

export interface BotsScreenProps {
  /** Compact shell: navigate. Regular shell: select in place. */
  onOpenBot?: (bot: Bot, options?: OpenBotOptions) => void
  selectedBot?: string | undefined
  onOpenSection?: (section: BotsSection) => void
  /** Which footer tab reads as current; the wide shell drives this from its overlay. */
  currentTab?: TabKey
  /**
   * `rail` is the collapsed wide layout: the same component, the same state, the
   * slim column instead of the list.
   *
   * It is a variant rather than a component of its own because ⌘1…9, ⌘↑/↓ and the
   * Mac menu bar's nine named chats all hang off state only this component derives.
   * Swapping it out to draw a rail would take those with the rows — see
   * `SidebarRail`'s own note.
   */
  variant?: 'screen' | 'sidebar' | 'rail'
  /** Rail only: ask the shell for the list back. */
  onShowList?: () => void
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
  | { key: string; kind: 'noNameMatch'; query: string }
  | { key: string; kind: 'messagesHeader'; searching: boolean; count: number }
  | { key: string; kind: 'message'; match: MessageMatch; bot: Bot }

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
  onShowList,
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
  const [editing, setEditing] = useState(false)
  // Which divider was added by the button, so that one — and only that one —
  // opens with the keyboard in it. Cleared when edit mode ends, so leaving and
  // coming back does not steal focus for a section that already has a name.
  const [addedDividerId, setAddedDividerId] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  /**
   * The gateway half of the search.
   *
   * Names are matched on this device and are instant; messages are a fan-out
   * over the gateway behind a 300 ms debounce, so they land under the rows they
   * belong beneath rather than reordering a list somebody is already reading.
   */
  const messageSearch = useMessageSearch(query)

  const rail = variant === 'rail'
  const sidebar = variant === 'sidebar'
  const signedOut = status === 'needs_signin'

  // Stable identities, so that `BotRow`'s memo survives a roster refresh. A
  // fresh arrow per render would re-render forty rows because one of them
  // changed, which is the whole cost the memo is there to avoid.
  // The options argument is omitted rather than passed as `undefined` when there
  // are none: a tap on a row is the same call it has always been, and every
  // shell's handler can keep reading its second parameter as "somebody asked for
  // something extra".
  const openBot = useCallback(
    (bot: Bot, options?: OpenBotOptions) => (options ? onOpenBot?.(bot, options) : onOpenBot?.(bot)),
    [onOpenBot]
  )
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
   * A search is the exception: it narrows the list on purpose, and answering
   * "no matches" once per section would bury the matches.
   */
  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = []
    const narrowed = Boolean(query.trim())

    for (const section of sections) {
      const visible = section.bots
        .map(name => byName[name])
        .filter((bot): bot is Bot => Boolean(bot))
        .filter(bot => matches(bot, query))

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

    /*
     * The message matches, last.
     *
     * Below every row the local filter produced, because a name match is
     * instant and certain and a message match is neither: it is one round trip
     * per bot behind a debounce, and putting it above would shuffle the list
     * under a finger that was already reaching for a row.
     *
     * The block is keyed on the query these results ANSWER rather than on the
     * field's current value, so a stale section cannot survive a new query by
     * looking similar enough to be reused.
     */
    if (narrowed) {
      /*
       * "No conversation matches" used to be the list's EMPTY component, and a
       * list with a message section in it is never empty. So the line moves
       * into the list, where it can sit above the matches rather than being
       * switched off by them.
       */
      if (!out.some(item => item.kind === 'bot')) {
        out.push({ key: 'no-name-match', kind: 'noNameMatch', query: query.trim() })
      }
    }

    if (narrowed && messageSearch.query === query.trim()) {
      out.push({
        count: messageSearch.matches.length,
        key: 'messages',
        kind: 'messagesHeader',
        searching: messageSearch.searching
      })

      for (const match of messageSearch.matches) {
        const bot = byName[match.bot]

        if (bot) {
          out.push({ bot, key: `message:${match.bot}`, kind: 'message', match })
        }
      }
    }

    return out
  }, [archiveOpen, archivedNames, byName, editing, messageSearch, query, sections])

  const hasRows = items.some(item => item.kind === 'bot')

  /**
   * The visible chats, in the order the reader sees them.
   *
   * ⌘1…9 and ⌘↑/↓ count in THIS order rather than in the roster's or the
   * arrangement's, because it is the only one the reader can see — a search or a
   * filter narrows the list, and a shortcut that skipped a hidden row would land
   * somewhere nobody pointed at. It is also what the Mac's menu bar names.
   */
  const visibleBots = useMemo(
    () => items.filter(item => item.kind === 'bot' && !item.archived).map(item => (item as { bot: Bot }).bot),
    [items]
  )

  /**
   * Unread messages across the visible chats, for the rail's badge.
   *
   * The one fact a hidden list would otherwise swallow: the rows are gone, so every
   * bead and every per-row badge is gone with them, and a message arriving while the
   * sidebar is collapsed would leave nothing at all on screen to say so.
   */
  const unreadTotal = useMemo(
    () => visibleBots.reduce((total, bot) => total + unreadFor(bot.name).count, 0),
    [unreadFor, visibleBots]
  )

  /** One stable array for every row's menu; see `BotRow.menuSections`. */
  const menuSections = useMemo(
    () => [{ id: null, name: strings.layout.topGroup }, ...dividers.map(d => ({ id: d.id, name: d.name }))],
    [dividers]
  )

  const listRef = useRef<FlatList<ListItem>>(null)
  const searchRef = useRef<TextInput>(null)
  const scrollOffset = useRef(0)

  const entryIndexes = useMemo(() => entryIndexByKey(entries), [entries])
  const anchors = useMemo(() => dragAnchors(items, entryIndexes), [entryIndexes, items])

  const drag = useRowDrag({
    anchors,
    // Long press means the native menu where there is one, and the fallback sheet
    // where there is not. Either way it is not free for the drag to take, so on
    // Android the handle in edit mode is the only way in.
    armEnabled: HAS_NATIVE_CONTEXT_MENU,
    entryCount: entries.length,
    onAutoScroll: useCallback((delta: number) => {
      const next = Math.max(0, scrollOffset.current + delta)

      listRef.current?.scrollToOffset({ animated: false, offset: next })
    }, []),
    onCommit: useCallback((name: string, index: number) => {
      useChatLayoutStore.getState().moveToIndex(name, index)
    }, [])
  })

  const openIndex = useCallback(
    (index: number) => {
      const bot = visibleBots[index]

      if (bot) {
        openBot(bot)
      }
    },
    [openBot, visibleBots]
  )

  // ⌘K on the rail has no field to land in, so it asks for the list back instead —
  // which is where the field is. Silently focusing a ref that is null would be a
  // shortcut that reports success and does nothing.
  useShortcut('search', () => (rail ? onShowList?.() : searchRef.current?.focus()))
  useNumberedShortcuts(openIndex)

  /**
   * ⌘↑ / ⌘↓ and ⌃Tab, relative to the row that is open.
   *
   * With nothing open the first press lands on the first chat rather than on the
   * last: a reader who has just started the app and reaches for "next" means the
   * top of the list.
   */
  const step = useCallback(
    (offset: number) => {
      const at = visibleBots.findIndex(bot => bot.name === selectedBot)

      openIndex(at === -1 ? 0 : Math.max(0, Math.min(visibleBots.length - 1, at + offset)))
    },
    [openIndex, selectedBot, visibleBots]
  )

  useShortcut('nextChat', () => step(1))
  useShortcut('previousChat', () => step(-1))

  /**
   * One ref, two readers. The list is held so a drag can auto-scroll it, and
   * `applyDirectTouchPan` still has to see the same view — a Mac must not pan this
   * list under a pointer either (`platform/pointer-drag`). `useCallback`, because a
   * fresh callback ref per render is a detach and a re-attach per render.
   */
  const attachList = useCallback((view: FlatList<ListItem> | null) => {
    listRef.current = view
    directTouchPanRef(view)
  }, [])

  /** Rename from a divider's own menu: edit mode on, and the caret in that field. */
  const renameDivider = useCallback((id: string) => {
    setEditing(true)
    setAddedDividerId(id)
  }, [])

  const onListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffset.current = event.nativeEvent.contentOffset.y
      drag.onListScroll(scrollOffset.current)
    },
    [drag]
  )

  /**
   * Hand the Mac's menu bar the same nine chats ⌘1…9 reaches, with the app's own
   * wording. A no-op on every other platform — see `platform/desktop-shortcuts`.
   *
   * The sidebar item's wording is resolved HERE because `variant` is the answer: a
   * rail is a hidden list and a sidebar is a showing one, so the menu says the
   * thing the keystroke will do without anybody measuring a window. On the phone's
   * Chats screen the item is still sent and still does nothing — the same as ⌘W on
   * a bare list, and a phone has no menu bar to read it in.
   */
  useEffect(() => {
    setMenuBar(
      { ...strings.menuBar, toggleSidebar: rail ? strings.menuBar.showSidebar : strings.menuBar.hideSidebar },
      visibleBots.slice(0, 9).map(bot => bot.displayName)
    )
  }, [rail, visibleBots])

  /**
   * One selection from either menu.
   *
   * The native menu and the fallback sheet report the same ids (`row-menu-items`),
   * so this is the only handler for both and there is no second table of what a row
   * can do sitting beside the first one.
   */
  const onMenuSelect = useCallback(
    (name: string, id: string) => {
      const action = parseRowMenuAction(id)
      const layout = useChatLayoutStore.getState()

      switch (action?.kind) {
        case 'open': {
          const bot = byName[name]

          if (bot) {
            openBot(bot)
          }

          return
        }

        case 'markRead':
          useBotsStore.getState().markSeen(name, byName[name]?.canonical?.lastActive)

          return

        case 'accent':
          layout.setAccent(name, action.accent)

          return

        case 'section':
          layout.moveToSection(name, action.dividerId)

          return

        case 'move':
          layout.moveBy(name, action.offset)

          return

        case 'archiveToggle':
          layout.setArchived(name, !layout.archived[name])

          return

        case 'dividerAbove': {
          const id = layout.addDividerAbove(name, '')

          // Straight into the field, and into edit mode to show it: a section that
          // stays untitled is what put two headings next to each other.
          if (id) {
            setEditing(true)
            setAddedDividerId(id)
          }

          return
        }

        default:
          return
      }
    },
    [byName, openBot]
  )

  // A chat-level failure must not compete with the signed-out card: a dead
  // session is not a roster problem and showing both makes neither readable.
  const rosterError = signedOut ? null : error

  /*
   * The collapsed sidebar, after every hook above has run.
   *
   * Placed here rather than at the top of the component on purpose: the roster
   * poll, the layout reconcile, the numbered shortcuts and the menu bar are all
   * registered above, and they are exactly what a rail must not switch off. An
   * early return before them would be the bug this variant exists to avoid.
   */
  if (rail) {
    return (
      <SidebarRail
        current={currentTab}
        unread={unreadTotal}
        {...(onOpenSection ? { onOpenSection } : {})}
        {...(onShowList ? { onShowList } : {})}
      />
    )
  }

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

      <SearchField
        inputRef={searchRef}
        onChangeText={setQuery}
        // Return in the search field opens the first match, which is what Return in
        // a search field does everywhere. It is the visible order, so it is the same
        // row ⌘1 would open.
        onSubmit={() => openIndex(0)}
        value={query}
      />

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
        ref={attachList}
        ListEmptyComponent={
          <EmptyState error={rosterError} loading={loading} query={query} searching={Boolean(query.trim())} />
        }
        data={items}
        extraData={hasRows}
        keyExtractor={item => item.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onLayout={event => drag.onListLayout(event.nativeEvent.layout.height)}
        onScroll={onListScroll}
        refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
        renderItem={({ item }) => {
          const line = drag.dropKey === item.key ? <DropLine /> : null

          if (item.kind === 'archiveHeader') {
            return (
              <ArchiveHeader count={item.count} onToggle={() => setArchiveOpen(open => !open)} open={archiveOpen} />
            )
          }

          if (item.kind === 'noNameMatch') {
            return (
              <Text
                color="textMuted"
                style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md }}
                testID="bots-empty"
              >
                {strings.bots.noMatches(item.query)}
              </Text>
            )
          }

          if (item.kind === 'messagesHeader') {
            return <MessagesHeader count={item.count} searching={item.searching} />
          }

          if (item.kind === 'message') {
            return (
              <MessageHit
                bot={item.bot}
                match={item.match}
                onPress={() => openBot(item.bot, { findText: query.trim() })}
              />
            )
          }

          if (item.kind === 'divider') {
            return (
              <View onLayout={drag.measure(item.key)}>
                {line}
                <Divider
                  autoFocus={item.id === addedDividerId}
                  editing={editing}
                  id={item.id}
                  name={item.name}
                  onRename={renameDivider}
                />
              </View>
            )
          }

          if (item.kind === 'sectionEmpty') {
            return (
              <View onLayout={drag.measure(item.key)}>
                {line}
                <SectionEmpty id={item.id} />
              </View>
            )
          }

          const state = presence.get(item.bot.name) ?? ARCHIVED_PRESENCE
          const { count, unread } = unreadFor(item.bot.name)
          const lifted = drag.draggingName === item.bot.name

          return (
            /*
             * The wrapper carries three things a row cannot carry itself: the
             * measurement the drop arithmetic needs, the pan responder that claims
             * the gesture once a long press has armed it, and the lift.
             *
             * The lift is a TRANSFORM on the row in place rather than a separate drag
             * layer. A portal would let the row leave the list, which nothing here
             * needs — the drop targets are all inside it — and it would cost a second
             * copy of the row to keep in sync with the first.
             */
            <Animated.View
              onLayout={drag.measure(item.key)}
              {...(item.archived ? {} : drag.rowHandlers(item.bot.name))}
              style={
                lifted
                  ? {
                      elevation: 8,
                      shadowColor: '#000',
                      shadowOffset: { height: 6, width: 0 },
                      shadowOpacity: 0.28,
                      shadowRadius: 12,
                      transform: [{ translateY: drag.translateY }, { scale: 1.02 }],
                      zIndex: 2
                    }
                  : undefined
              }
              testID={lifted ? `bot-row-lifted-${item.bot.name}` : undefined}
            >
              {line}
              <BotRow
                accent={accents[item.bot.name] ?? 'default'}
                archived={item.archived}
                bot={item.bot}
                compact={!sidebar}
                editing={editing && !item.archived}
                {...(editing && !item.archived ? { handleHandlers: drag.handleHandlers(item.bot.name) } : {})}
                menuSections={menuSections}
                onArm={drag.arm}
                onDisarm={drag.disarm}
                onMenuSelect={onMenuSelect}
                onMove={moveBot}
                onOpenMenu={setMenuFor}
                onPress={openBot}
                presence={item.archived ? ARCHIVED_PRESENCE : state}
                selected={item.bot.name === selectedBot}
                unread={item.archived ? false : unread}
                unreadCount={item.archived ? 0 : count}
                {...(avatars[item.bot.name] ? { avatarUri: avatars[item.bot.name] } : {})}
              />
            </Animated.View>
          )
        }}
        // While a row is lifted the list must not also pan: the auto-scroll at the
        // edges is what moves it, and two scrollers would fight over one finger.
        scrollEnabled={drag.draggingName === null}
        scrollEventThrottle={16}
        style={{ flex: 1 }}
        testID="bots-list"
      />

      {drag.draggingName ? (
        <Text accessibilityLiveRegion="polite" style={{ height: 0, opacity: 0 }}>
          {strings.layout.dragging(byName[drag.draggingName]?.displayName ?? drag.draggingName)}
        </Text>
      ) : null}

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
          style={{ cursor: 'pointer' }}
          testID="bots-new-cron"
        >
          <GlassSurface
            contentStyle={{ alignItems: 'center', height: 38, justifyContent: 'center', width: 38 }}
            variant="control"
          >
            <Icon color={theme.colors.textMuted} name="plus" size={ICON_SIZE.control} />
          </GlassSurface>
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        hitSlop={TAP_SLOP}
        onPress={onToggleEdit}
        style={{ cursor: 'pointer' }}
        testID="bots-edit"
      >
        <Text color="accentText" style={{ fontWeight: '600' }} variant="preview">
          {editing ? strings.layout.done : strings.layout.edit}
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * Where a dragged row would land.
 *
 * Two points of the accent, full width of the row's own inset. A line rather than a
 * gap that opens up: a gap moves every row below it on every slot change, which on a
 * list of forty is forty layout passes per centimetre of finger travel.
 */
function DropLine() {
  const theme = useTheme()

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        backgroundColor: theme.colors.accent,
        borderRadius: 1,
        height: 2,
        marginHorizontal: theme.space.md
      }}
      testID="drop-line"
    />
  )
}

/**
 * The search field, and the rule for any field with a leading icon.
 *
 * The icon and the placeholder have to sit on ONE centre line, and getting there
 * takes three things that all have to be said out loud:
 *
 *  - **The icon's SLOT is the text line's height, not the mark's size.** An
 *    `Icon size={15}` with no slot is a 15pt box; the text line beside it is 20pt.
 *    Two boxes of different heights, both centred in a 44pt row, centre at the same
 *    y — but only while nothing else moves either of them, which is what the next
 *    two points are about. Giving the icon the line's own box makes the alignment a
 *    property of the pair rather than a coincidence of the row.
 *  - **The line height is explicit.** Without it the field's text box is whatever
 *    the platform's font metrics make it, which is not the 20pt the icon was sized
 *    against and differs between iOS and Android.
 *  - **`paddingVertical: 0`.** iOS adds a vertical inset of its own to a
 *    `TextInput` on top of whatever the style asks for. That inset is not symmetric,
 *    and it is the whole reason the placeholder sat a point or two below the
 *    magnifier: the icon was centred and the text was centred-plus-an-inset. The
 *    44pt tap target moves to the ROW, where it belongs — it is a property of the
 *    control, not of the text inside it.
 */
function SearchField({
  inputRef,
  onChangeText,
  onSubmit,
  value
}: {
  inputRef: React.RefObject<TextInput | null>
  onChangeText: (value: string) => void
  onSubmit: () => void
  value: string
}) {
  const theme = useTheme()
  // One token for the size AND its leading, so the icon's slot and the text's line
  // box cannot be derived from two different numbers.
  const line = theme.type.preview

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
        minHeight: CONTROL_MIN_HEIGHT,
        paddingHorizontal: theme.space.md
      }}
      testID="bots-search-field"
    >
      <Icon
        color={theme.colors.textFaint}
        name="search"
        size={ICON_SIZE.inline}
        slot={line.lineHeight}
        testID="bots-search-icon"
      />
      <TextInput
        accessibilityLabel={strings.bots.search}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={strings.bots.search}
        placeholderTextColor={theme.colors.textFaint}
        ref={inputRef}
        returnKeyType="go"
        style={{
          color: theme.colors.text,
          flex: 1,
          fontSize: line.fontSize,
          lineHeight: line.lineHeight,
          paddingVertical: 0
        }}
        testID="bots-search"
        value={value}
      />
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
  autoFocus,
  onRename
}: {
  editing: boolean
  id: string | null
  name: string
  autoFocus?: boolean
  /** Turns edit mode on with this heading's field focused; the menu's Rename. */
  onRename?: (id: string) => void
}) {
  const theme = useTheme()

  const menu = useMemo(
    () =>
      id
        ? [
            { id: 'rename', title: strings.layout.rename, systemImage: 'pencil' },
            { id: 'remove', title: strings.layout.remove, systemImage: 'trash', destructive: true }
          ]
        : [],
    [id]
  )

  if (!id) {
    return null
  }

  const heading = (
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
            cursor: 'pointer',
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

  return (
    <ContextMenuHost
      items={menu}
      menuTitle={name || strings.layout.unnamedSection}
      onSelect={selected => {
        if (selected === 'rename') {
          onRename?.(id)

          return
        }

        useChatLayoutStore.getState().removeDivider(id)
      }}
      testID={`divider-menu-${id}`}
    >
      {heading}
    </ContextMenuHost>
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
  const hover = useHover()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={{
        alignItems: 'center',
        backgroundColor: hover.hovered ? theme.glass.row.solid : 'transparent',
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        flexDirection: 'row',
        gap: theme.space.sm,
        marginHorizontal: theme.space.sm,
        marginTop: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.md
      }}
      testID="archived-row"
      {...hover.props}
    >
      {/* Decorative: the row's own expanded state is what a screen reader reads,
          and `Icon` keeps itself out of the tree so it cannot say it twice. */}
      <Icon color={theme.colors.textMuted} name={open ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.marker} />
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
        style={{ cursor: 'pointer' }}
        testID="add-divider"
      >
        <Text color="accentText" style={{ fontWeight: '600' }} variant="meta">
          {strings.layout.addDivider}
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * The heading over the message matches.
 *
 * It counts CHATS, and the hint under it says why: the gateway collapses every
 * hit in a conversation onto one result, so the number of rows here is the
 * number of chats that contain the words, not the number of times they appear.
 * Writing "3 messages" over it would be a count nobody could verify by opening
 * them.
 */
function MessagesHeader({ count, searching }: { count: number; searching: boolean }) {
  const theme = useTheme()

  return (
    <View
      style={{
        gap: 2,
        paddingBottom: theme.space.sm,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.lg
      }}
      testID="message-matches-header"
    >
      <Text color="textMuted" style={{ fontWeight: '600', letterSpacing: 0.6 }} variant="meta">
        {strings.bots.messagesHeader}
      </Text>

      <Text color="textFaint" variant="meta">
        {searching
          ? strings.bots.messagesSearching
          : count === 0
            ? strings.bots.messagesNone
            : strings.bots.messagesHint}
      </Text>
    </View>
  )
}

/**
 * One chat whose transcript contains the words.
 *
 * The snippet is the gateway's own, markers and all: `>>>` and `<<<` wrap what
 * FTS5 matched, which is not always what was typed — a prefix term matches a
 * longer word — so the emphasis is worth carrying rather than re-deriving here
 * and getting subtly wrong.
 */
function MessageHit({ bot, match, onPress }: { bot: Bot; match: MessageMatch; onPress: () => void }) {
  const theme = useTheme()
  const hover = useHover()
  const segments = useMemo(() => snippetSegments(tidySnippet(match.snippet)), [match.snippet])

  return (
    <Pressable
      accessibilityLabel={strings.bots.messageOpen(bot.displayName)}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: hover.hovered ? theme.glass.row.solid : 'transparent',
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        gap: 2,
        marginHorizontal: theme.space.sm,
        opacity: pressed ? 0.7 : 1,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.md
      })}
      testID={`message-match-${bot.name}`}
      {...hover.props}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, fontWeight: '600' }} variant="preview">
          {bot.displayName}
        </Text>

        {match.at === undefined ? null : (
          <Text color="textFaint" variant="meta">
            {formatListTime(match.at)}
          </Text>
        )}
      </View>

      <Text color="textMuted" numberOfLines={2} variant="preview">
        {segments.map((segment, index) => (
          <Text
            color={segment.match ? 'accentText' : 'textMuted'}
            key={index}
            style={segment.match ? { fontWeight: '600' } : undefined}
            variant="preview"
          >
            {segment.text}
          </Text>
        ))}
      </Text>
    </Pressable>
  )
}

function EmptyState({
  error,
  loading,
  query,
  searching
}: {
  error: string | null
  loading: boolean
  query: string
  searching: boolean
}) {
  const theme = useTheme()

  const message = error
    ? strings.bots.failed(error)
    : searching
      ? strings.bots.noMatches(query.trim())
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
