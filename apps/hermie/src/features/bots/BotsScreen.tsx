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
  type NativeSyntheticEvent,
  type PanResponderInstance
} from 'react-native'

import { snippetSegments, tidySnippet } from '@hermie/gateway-client'
import { hasOpenRequest, unreadBadgeLabel, unreadCountSince } from '@hermie/transcript'

import { useGateway } from '../../gateway'
import { gatewayStop } from '../../gateway/gateway-stop'
import { GatewayStoppedPanel } from '../../gateway/GatewayStoppedPanel'
import { chatGatewayFor } from '../../gateway/link'
import { strings } from '../../i18n/strings'
import { ContextMenuHost, HAS_NATIVE_CONTEXT_MENU } from '../../platform/context-menu'
import { setMenuBar } from '../../platform/desktop-shortcuts'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSafeAreaInsets } from '../../platform/safe-area'
import { isUnread, useBotsStore, type Bot } from '../../store/bots'
import { BotProfileSheet } from '../bot-profile'
import { MemoryBotsScreen } from '../memory'
import { archivedOf, foldersOf, useChatLayoutStore } from '../../store/chat-layout'
import type { Folder } from '../../store/folders'
import { isMuted, MUTE_FOREVER, muteUntil, mutedUntil as mutedUntilOf, type Mutes } from '../../store/mute'
import { useChatsStore } from '../../store/chats'
import { Appear } from '../../ui/Appear'
import { DragGrip } from '../../ui/DragGrip'
import { GlassSurface } from '../../ui/glass'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useFocusRing } from '../../ui/useFocusRing'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHover } from '../../ui/useHover'
import { useNumberedShortcuts, useShortcut } from '../../ui/useShortcut'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../../ui/tokens'
import { formatListTime } from '../../chat-ui'
import { useChatRuntime } from '../chats/ChatRuntime'
import { type MessageMatch, useMessageSearch } from '../search'
import { BotRow } from './BotRow'
import { NewBotFlow } from '../profiles/NewBotFlow'
import { KanbanScreen, kanbanStrings, useBoardsOpener } from '../kanban'
import { profileStrings } from '../profiles/strings'
import { ConnectionLine } from './ConnectionLine'
import { GatewayNameLine } from './GatewayNameLine'
import {
  clampToPinnedBand,
  committedRowIndex,
  dragAnchors,
  folderRowKey,
  folderRows,
  isSameRowPlace,
  parseRowKey,
  type DropTarget,
  type FolderCounts,
  type RowsInput
} from './folder-rows'
import { consumeRevealFolder, onRevealFolder } from './folder-reveal'
import { presenceOf, type Presence } from './presence'
import { folderMenuItems, parseFolderMenuAction, parseRowMenuAction, rowMenuItems } from './row-menu-items'
import { RowMenu } from './RowMenu'
import { SidebarFooter, type BotsSection, type TabKey } from './SidebarFooter'
import { SidebarRail } from './SidebarRail'
import { DragCell, DragCellProvider } from './DragCell'
import { LIFT_SCALE, useRowDrag } from './use-row-drag'

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
  /**
   * Open one of the other three destinations.
   *
   * `options.create` is the difference between "show me the crons" and "make
   * me a cron". The `+` in this screen's own header is labelled New cron and
   * used to do the first, which is a button that promises a thing and delivers
   * the page that thing lives on.
   */
  onOpenSection?: (section: BotsSection, options?: { create?: boolean }) => void
  /**
   * Open one bot's other conversations, from its profile sheet.
   *
   * Absent where the shell has nowhere to put the page, which drops the row on
   * that sheet rather than leaving it pointing at nothing.
   */
  onOpenConversations?: (botName: string) => void
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
  | { key: string; kind: 'folder'; folder: Folder; open: boolean; counts: FolderCounts }
  | { key: string; kind: 'folderEmpty'; id: string }
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

/** The part of a host component `measureListTop` needs; see its narrowing. */
interface Measurable {
  measureInWindow: (callback: (x: number, y: number) => void) => void
}

export function BotsScreen({
  currentTab = 'chats',
  onOpenBot,
  onOpenSection,
  onOpenConversations,
  onShowList,
  selectedBot,
  variant = 'screen'
}: BotsScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const runtime = useChatRuntime()
  // `signOut` is read with a guard rather than destructured plainly: the
  // narrow shells that render this list stub the provider, and the footer's
  // identity row is written to draw without a way out rather than to insist on
  // one.
  const { config, connection, gatewayId, http, status, signOut } = useGateway()
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
  const mutes = useChatLayoutStore(state => state.mutes)
  const pinned = useChatLayoutStore(state => state.pinned)
  const reconcile = useChatLayoutStore(state => state.reconcile)

  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  // Which divider was added by the button, so that one — and only that one —
  // opens with the keyboard in it. Cleared when edit mode ends, so leaving and
  // coming back does not steal focus for a section that already has a name.
  const [addedFolderId, setAddedFolderId] = useState<string | null>(null)
  /*
    The New-bot form. A sheet rather than a destination, because making a bot
    is a thing you do once and then leave — and the flow it wraps ends by
    OPENING the new bot's chat, so pushing a screen first would mean popping
    it again a moment later.
  */
  const [creatingBot, setCreatingBot] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** The bot whose profile sheet is open, by name. */
  const [profileFor, setProfileFor] = useState<string | null>(null)
  /* The memory browser REPLACES this screen, the way Settings' pages do. */
  const [memoryFor, setMemoryFor] = useState<string | null>(null)
  const [showBoards, setShowBoards] = useState(false)
  /*
    The (…) menu's way into the boards. This list IS the sidebar on a wide
    window — 300 to 340pt — so a board rendered in place here could never reach
    the 700pt its side-by-side layout needs. Where the shell offers a content
    column the board goes there instead; `showBoards` above is the phone's
    answer. See `features/kanban/boards-host.tsx`.
  */
  const openBoards = useBoardsOpener(() => setShowBoards(true))

  /*
    The profile sheet's connection. Built from the live socket rather than taken
    from the runtime, because `profiles.configure` and `profiles.set_asset` are
    plain gateway calls with nothing to do with a chat's session.
  */
  const profileGateway = useMemo(() => (connection ? chatGatewayFor(connection) : null), [connection])

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
  const moveFolder = useCallback((folderId: string, offset: number) => {
    useChatLayoutStore.getState().moveFolderBy(folderId, offset)
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
      const needsInput = chat ? hasOpenRequest(chat) : false

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

  const folders = useChatLayoutStore(state => state.folders)
  const collapsed = useChatLayoutStore(state => state.collapsed)
  const arrangement = useMemo(() => ({ entries, folders }), [entries, folders])
  const archivedNames = useMemo(() => archivedOf(arrangement, archivedSet), [arrangement, archivedSet])
  const folderList = useMemo(() => foldersOf(arrangement), [arrangement])

  /**
   * Everything the rows and the anchors are derived from, in one object.
   *
   * Built here rather than inside each memo because `folderRows` and
   * `dragAnchors` have to be looking at the SAME arrangement: rows the reader
   * can see and positions a drop can land on that disagreed by one folder would
   * be a drag that lands a row somewhere nobody pointed at.
   */
  const rowsInput = useMemo<RowsInput>(
    () => ({
      arrangement,
      archived: archivedSet,
      collapsed,
      mutes,
      pinned,
      now: Math.floor(Date.now() / 1000),
      countsFor: (name: string) => {
        const counts = unreadFor(name)

        return { unread: counts.count, needsInput: presence.get(name)?.state === 'needsInput' }
      }
    }),
    [arrangement, archivedSet, collapsed, mutes, pinned, presence, unreadFor]
  )

  const rows = useMemo(() => folderRows(rowsInput), [rowsInput])

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
    const shown = (name: string): Bot | null => {
      const bot = byName[name]

      return bot && matches(bot, query) ? bot : null
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]

      if (!row) {
        continue
      }

      if (row.kind === 'bot') {
        const bot = shown(row.name)

        if (bot) {
          out.push({ archived: false, bot, key: row.key, kind: 'bot' })
        }

        continue
      }

      if (row.kind === 'folderEmpty') {
        out.push({ id: row.folderId, key: row.key, kind: 'folderEmpty' })
        continue
      }

      if (row.kind !== 'folder') {
        continue
      }

      /*
        A search narrows the list on purpose, so a folder with nothing matching
        in it goes away rather than saying "no matches" once per folder and
        burying the matches. Edit mode is the exception: that is when somebody
        is arranging, and a folder that vanished while they were moving rows
        into it would be a folder they could not aim at.
      */
      const hits = row.open
        ? row.folder.bots.filter(name => !archivedSet[name] && shown(name))
        : row.folder.bots.filter(name => !archivedSet[name] && shown(name))

      if (narrowed && !editing && !hits.length) {
        // Skip the folder AND the rows it owns, which are the ones that follow.
        while (index + 1 < rows.length && rows[index + 1]?.kind !== 'folder') {
          index += 1
        }

        continue
      }

      out.push({ counts: row.counts, folder: row.folder, key: row.key, kind: 'folder', open: row.open })
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
  }, [archiveOpen, archivedNames, archivedSet, byName, editing, messageSearch, query, rows])

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
    // Muted chats are left out. The rail's badge is the one number a reader who
    // has hidden the list is going to react to, and a chat they told the app to
    // be quiet about has no business pulling them back to it. The row itself
    // still carries its own count, for when they do look.
    () => {
      const now = Math.floor(Date.now() / 1000)

      return visibleBots.reduce(
        (total, bot) => total + (isMuted(mutes, bot.name, now) ? 0 : unreadFor(bot.name).count),
        0
      )
    },
    [mutes, unreadFor, visibleBots]
  )

  /** One stable array for every row's menu; see `BotRow.menuFolders`. */
  /*
    Read out of the table HERE rather than inside the memos below, and then
    depended on by name.

    A memo that produces TEXT has to recompute when the language changes, and
    `folderList` can sit still for hours. Depending on the SENTENCE rather than
    on the locale says why in the dependency array itself, and it is the thing
    that actually changed — `useLocale()` in the deps would be a value the
    callback never reads, which is both a lint warning and a worse explanation.
  */
  const topGroupName = strings.layout.topGroup
  const unnamedFolderName = strings.layout.unnamedFolder

  const menuFolders = useMemo(
    () => [
      { id: null, name: topGroupName },
      ...folderList.map(folder => ({ id: folder.id, name: folder.name || unnamedFolderName }))
    ],
    [folderList, topGroupName, unnamedFolderName]
  )

  const listRef = useRef<FlatList<ListItem>>(null)
  /**
   * `onListTop`, held so `measureList` can report into it.
   *
   * The measurement is asked for by the hook and answered by this screen, and the
   * two halves are created in the same call — so one of them has to be reached
   * through a ref rather than through the closure.
   */
  const dragTop = useRef<((y: number) => void) | null>(null)
  const searchRef = useRef<TextInput>(null)
  const scrollOffset = useRef(0)

  /**
   * Where the list's top edge is, in the window.
   *
   * It cannot be read off a touch and it cannot be assumed: on the phone the list
   * sits under a search field, on the iPad under a floating header and beside the
   * rail, and in a Mac window under a title bar that is outside the app entirely.
   * `getNativeScrollRef` is the scroll view itself, which is the view the cells were
   * measured inside, so the two coordinate spaces meet exactly here.
   */
  const measureListTop = useCallback(() => {
    // `getNativeScrollRef` is typed as the union of everything a scrollable host
    // can be, and only one arm of it declares the measuring methods every host
    // component actually has. The narrowing says what is being relied on.
    const scroll = listRef.current?.getNativeScrollRef() as Measurable | null | undefined

    scroll?.measureInWindow((_x: number, y: number) => {
      dragTop.current?.(y)
    })
  }, [])

  /*
    Anchors come from the ARRANGEMENT rather than from the rendered items, and
    that is the one thing to be careful about here. With dividers the two were
    the same list filtered; with folders a position is a container and an index
    inside it, and the rendered list has rows that stand for no position at all
    (a folder's own header stands for two) and hides rows that still have one (a
    collapsed folder's children). Deriving the drop targets from what is drawn
    would put a row into whichever folder happened to be above the gap.
  */
  const anchors = useMemo(() => dragAnchors(rowsInput), [rowsInput])

  const drag = useRowDrag({
    anchors,
    // Long press means the native menu where there is one, and the fallback sheet
    // where there is not. Either way it is not free for the drag to take, so on
    // Android the handle in edit mode is the only way in.
    armEnabled: HAS_NATIVE_CONTEXT_MENU,
    /*
      A pinned row stays among the pinned rows, and an unpinned one below them.

      Applied to the SLOT rather than to the commit, which is what keeps the
      drop line the reader watches and the arrangement they end up with from
      being two different answers: the sort re-runs on every arrangement change,
      so a pinned row "dropped" below the band would spring back to the top and
      the gesture would look undone. See `clampToPinnedBand`.
    */
    clampSlot: useCallback(
      (rowKey: string, slot: number) => clampToPinnedBand(anchors, pinned, rowKey, slot),
      [anchors, pinned]
    ),
    // Past the last row is the end of the TOP LEVEL, never the end of whichever
    // folder happened to be last: dragging to the bottom is how a chat gets out
    // of the last folder.
    fallbackTarget: useMemo<DropTarget>(() => ({ folderId: null, index: entries.length }), [entries.length]),
    measureList: measureListTop,
    onAutoScroll: useCallback((delta: number) => {
      const next = Math.max(0, scrollOffset.current + delta)

      listRef.current?.scrollToOffset({ animated: false, offset: next })
    }, []),
    onCommit: useCallback(
      (rowKey: string, target: DropTarget) => {
        const row = parseRowKey(rowKey)

        if (!row) {
          return
        }

        // Dropping a row immediately before or immediately after itself is the
        // same arrangement, and committing it would churn the disk and the
        // gateway for nothing. The comparison is per CONTAINER: index 2 of the
        // top level and index 2 of a folder are different places.
        if (isSameRowPlace(arrangement, rowKey, target)) {
          return
        }

        const index = committedRowIndex(arrangement, rowKey, target)

        if (row.kind === 'folder') {
          /*
            A folder only ever lands at the TOP LEVEL, because folders do not
            nest: an arrangement is a top level and a set of folders holding
            chat names. `committedRowIndex` has already turned a target inside
            some other folder into the position that folder occupies, which is
            what "drop it next to that one" means — see `topLevelIndexOf`.
          */
          useChatLayoutStore.getState().dropFolder(row.id, index)

          return
        }

        useChatLayoutStore.getState().dropBot(row.name, target.folderId, index)
      },
      [arrangement]
    ),
    reduceMotion: theme.reduceMotion
  })

  dragTop.current = drag.onListTop

  /** The name of whatever is currently lifted, for the live region below. */
  const draggingLabel = useMemo(() => {
    const row = drag.draggingKey ? parseRowKey(drag.draggingKey) : null

    if (!row) {
      return null
    }

    if (row.kind === 'folder') {
      return folders.find(folder => folder.id === row.id)?.name || unnamedFolderName
    }

    return byName[row.name]?.displayName ?? row.name
  }, [byName, drag.draggingKey, folders, unnamedFolderName])

  /**
   * What every cell has to know, and nothing more.
   *
   * A new object here re-renders the cells, so it is memoized on the only two
   * things they read — which means a drag costs one re-render of the list's cells
   * when it starts and one when it ends, and none of the sixty in between.
   */
  const cellState = useMemo(
    () => ({ liftedKey: drag.liftedKey, measure: drag.measure }),
    [drag.liftedKey, drag.measure]
  )

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
  const renameFolder = useCallback((id: string) => {
    setEditing(true)
    setAddedFolderId(id)
  }, [])

  const onListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffset.current = event.nativeEvent.contentOffset.y
      drag.onListScroll(scrollOffset.current)
    },
    [drag]
  )

  /**
   * Scroll to the folder a widget tap named.
   *
   * The folder has already been OPENED by the shell that read the link — that is
   * a write to the arrangement and works whether or not this list exists — so
   * all that is left here is to put it in the window. Both halves are needed:
   * an open folder twelve rows down a list somebody has scrolled is a folder
   * they will not find.
   *
   * Two sources, exactly as `useHermieLink` has two. `consume` answers the cold
   * start, where the link was read during the first mount and this list did not
   * exist yet; the subscription answers a tap on an app that was already open.
   * A folder id that is not in the list any more scrolls nothing rather than
   * throwing — `scrollToIndex` on -1 is a crash on some versions.
   *
   * `items` is in the dependencies on purpose: on a cold start the list is
   * empty on the first pass and the roster arrives a moment later, so the
   * consumed id has to be re-applied once there is something to scroll to.
   */
  const revealed = useRef<string | null>(null)

  useEffect(() => {
    const reveal = (folderId: string): void => {
      const index = items.findIndex(item => item.kind === 'folder' && item.folder.id === folderId)

      if (index < 0) {
        // Remembered, not dropped: the roster is very often still loading on the
        // launch a widget tap produces, and the row appears a render later.
        revealed.current = folderId

        return
      }

      revealed.current = null
      listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0 })
    }

    const pending = revealed.current ?? consumeRevealFolder()

    if (pending) {
      reveal(pending)
    }

    return onRevealFolder(reveal)
  }, [items])

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
  const toggleSidebarItem = rail ? strings.menuBar.showSidebar : strings.menuBar.hideSidebar

  useEffect(() => {
    setMenuBar(
      { ...strings.menuBar, toggleSidebar: toggleSidebarItem },
      visibleBots.slice(0, 9).map(bot => bot.displayName)
    )
    // `toggleSidebarItem` stands in for `rail` as well as for the language: it
    // is the one value here that moves when either of them does, so a menu bar
    // built in English is replaced the moment the reader picks another
    // language rather than waiting for the roster to change.
  }, [toggleSidebarItem, visibleBots])

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

        case 'pinToggle':
          layout.togglePinned(name)

          return

        case 'folder':
          layout.moveToFolder(name, action.folderId)

          return

        case 'move':
          layout.moveBy(name, action.offset)

          return

        case 'archiveToggle':
          layout.setArchived(name, !layout.archived[name])

          return

        case 'editProfile':
          setProfileFor(name)

          return

        case 'mute':
          layout.setMute(name, muteUntil(action.duration, Math.floor(Date.now() / 1000)))

          return

        case 'unmute':
          layout.setMute(name, null)

          return

        case 'newFolder': {
          const id = layout.addFolderAround(name, '')

          // Straight into the field, and into edit mode to show it: a folder that
          // stays untitled is what put two headings next to each other.
          if (id) {
            setEditing(true)
            setAddedFolderId(id)
          }

          return
        }

        default:
          return
      }
    },
    [byName, openBot]
  )

  /** Open or close a folder. Local to this device; see `PersistedLayout`. */
  const toggleFolder = useCallback((id: string, open: boolean) => {
    useChatLayoutStore.getState().setFolderOpen(id, open)
  }, [])

  /**
   * A folder's own menu, which is the row menu's alphabet one level up.
   *
   * Mute is the one line that fans out: a folder has no mute of its own, it
   * just applies the chosen span to every chat inside it at once. Storing a
   * mute on the folder would be a second place a chat can be silent from, and
   * then a chat dragged out of a muted folder would be carrying a mute nobody
   * could see or lift.
   */
  const onFolderMenuSelect = useCallback((folderId: string, id: string) => {
    const action = parseFolderMenuAction(id)
    const layout = useChatLayoutStore.getState()
    const folder = layout.folders.find(entry => entry.id === folderId)

    if (!action || !folder) {
      return
    }

    switch (action.kind) {
      case 'colour':
        layout.setFolderColour(folderId, action.accent)

        return

      case 'delete':
        layout.removeFolder(folderId)

        return

      case 'newFolder':
        setAddedFolderId(layout.addFolder(''))
        setEditing(true)

        return

      case 'move':
        layout.moveFolderBy(folderId, action.offset)

        return

      case 'mute': {
        const until = muteUntil(action.duration, Math.floor(Date.now() / 1000))

        for (const name of folder.bots) {
          layout.setMute(name, until)
        }

        return
      }

      case 'unmute':
        for (const name of folder.bots) {
          layout.setMute(name, null)
        }

        return

      default:
        return
    }
  }, [])

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

  if (memoryFor) {
    return <MemoryBotsScreen initialProfile={memoryFor} onClose={() => setMemoryFor(null)} />
  }

  /*
    Boards REPLACES the chat list, which is what Memory above already does and
    for the same reason: this screen lives in a native stack on a phone and
    inside a panel with no navigator on a wide window, so pushing would only
    ever be right on one of them.
  */
  if (showBoards) {
    return <KanbanScreen backLabel={strings.bots.title} onClose={() => setShowBoards(false)} />
  }

  return (
    // The sidebar sits inside a panel the shell has already inset; the phone
    // screen is full-bleed and has to clear the notch and the home bar itself.
    <View style={sidebar ? { flex: 1 } : { flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
      <Head
        editing={editing}
        onToggleEdit={() => {
          setEditing(current => !current)
          setAddedFolderId(null)
        }}
        sidebar={sidebar}
        onBoards={openBoards}
        onNewBot={() => setCreatingBot(true)}
        {...(onOpenSection ? { onNewCron: () => onOpenSection('cron', { create: true }) } : {})}
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

      <DragCellProvider value={cellState}>
        <FlatList
          CellRendererComponent={DragCell}
          ref={attachList}
          ListEmptyComponent={
            <EmptyState error={rosterError} loading={loading} query={query} searching={Boolean(query.trim())} />
          }
          data={items}
          extraData={hasRows}
          keyExtractor={item => item.key}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onLayout={event => {
            drag.onListLayout(event.nativeEvent.layout.height)
            // A layout is the only moment the list's place in the window can have
            // changed without anybody touching it — a rotation, the sidebar opening,
            // a Mac window resized.
            measureListTop()
          }}
          onScroll={onListScroll}
          refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
          renderItem={({ item }) => {
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

            if (item.kind === 'folder') {
              const liftedFolder = drag.draggingKey === item.key

              return (
                /*
                  The same wrapper a chat row gets, and deliberately the same
                  one: the lift, the shadow and the neighbour offset are the
                  drag's, not the row's, so a folder that animated differently
                  from a chat would be a second implementation of the gesture
                  to keep in step with the first.
                */
                <Animated.View
                  {...drag.rowHandlers(item.key)}
                  style={
                    liftedFolder
                      ? {
                          elevation: 8,
                          shadowColor: '#000',
                          shadowOffset: { height: 6, width: 0 },
                          shadowOpacity: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
                          shadowRadius: 12,
                          transform: [
                            { translateY: drag.translateY },
                            { scale: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [1, LIFT_SCALE] }) }
                          ]
                        }
                      : { transform: [{ translateY: drag.offsetFor(item.key) }] }
                  }
                  testID={liftedFolder ? `folder-row-lifted-${item.folder.id}` : undefined}
                >
                  <FolderHeader
                    autoFocus={item.folder.id === addedFolderId}
                    counts={item.counts}
                    editing={editing}
                    folder={item.folder}
                    {...(editing ? { handleHandlers: drag.handleHandlers(item.key) } : {})}
                    onArm={drag.arm}
                    onDisarm={drag.disarm}
                    onMenuSelect={onFolderMenuSelect}
                    onMove={moveFolder}
                    onRename={renameFolder}
                    onToggle={toggleFolder}
                    open={item.open}
                  />
                </Animated.View>
              )
            }

            if (item.kind === 'folderEmpty') {
              return (
                <Animated.View style={{ transform: [{ translateY: drag.offsetFor(item.key) }] }}>
                  <FolderEmpty id={item.id} />
                </Animated.View>
              )
            }

            const state = presence.get(item.bot.name) ?? ARCHIVED_PRESENCE
            const { count, unread } = unreadFor(item.bot.name)
            const lifted = drag.draggingKey === item.key

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
               *
               * What it cannot carry is the z-order or the measurement: both belong to
               * the cell this wrapper sits inside, which is `DragCell`.
               */
              <Animated.View
                {...(item.archived ? {} : drag.rowHandlers(item.key))}
                /*
                 * Two states, one style: LIFTED reads off the drag's own `lift`
                 * value, everything else off its row offset. Neither is a boolean
                 * in a style object any more — a row that changed size in one frame
                 * was the tell that this was a transform applied rather than a row
                 * picked up.
                 */
                style={
                  lifted
                    ? {
                        elevation: 8,
                        shadowColor: '#000',
                        shadowOffset: { height: 6, width: 0 },
                        // Interpolated off the lift so the shadow arrives with the
                        // scale and leaves with it, rather than blinking on.
                        shadowOpacity: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
                        shadowRadius: 12,
                        transform: [
                          { translateY: drag.translateY },
                          { scale: drag.lift.interpolate({ inputRange: [0, 1], outputRange: [1, LIFT_SCALE] }) }
                        ]
                      }
                    : { transform: [{ translateY: drag.offsetFor(item.key) }] }
                }
                testID={lifted ? `bot-row-lifted-${item.bot.name}` : undefined}
              >
                <BotRow
                  accent={accents[item.bot.name] ?? 'default'}
                  archived={item.archived}
                  bot={item.bot}
                  compact={!sidebar}
                  editing={editing && !item.archived}
                  {...(editing && !item.archived ? { handleHandlers: drag.handleHandlers(item.key) } : {})}
                  menuFolders={menuFolders}
                  mutedUntil={mutedUntilOf(mutes, item.bot.name, Math.floor(Date.now() / 1000))}
                  pinned={Boolean(pinned[item.bot.name])}
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
          scrollEnabled={drag.draggingKey === null}
          scrollEventThrottle={16}
          style={{ flex: 1 }}
          testID="bots-list"
        />
      </DragCellProvider>

      {/*
        What is being dragged, said out loud.

        It names the ROW rather than the key: a folder is announced by its own
        name and a chat by its display name, because `folder:d3f` read out to
        somebody who cannot see the lift is worse than saying nothing.
      */}
      {draggingLabel ? (
        <Text accessibilityLiveRegion="polite" style={{ height: 0, opacity: 0 }}>
          {strings.layout.dragging(draggingLabel)}
        </Text>
      ) : null}

      {editing ? <EditBar onAddFolder={setAddedFolderId} /> : null}

      {onOpenSection ? (
        <SidebarFooter
          current={currentTab}
          onOpenSection={onOpenSection}
          {...(signOut ? { onSignOut: () => void signOut() } : {})}
        />
      ) : null}

      {menuFor ? (
        /*
          The same list the native menu draws, and the same handler it reports to.

          It used to build its own — which is how it came to offer a colour, an
          Archive and one line per section, and nothing that reorders. See
          `RowMenu`.
        */
        <RowMenu
          accent={accents[menuFor] ?? 'default'}
          botName={menuFor}
          displayName={byName[menuFor]?.displayName ?? menuFor}
          items={rowMenuItems({
            accent: accents[menuFor] ?? 'default',
            archived: Boolean(archivedSet[menuFor]),
            botName: menuFor,
            displayName: byName[menuFor]?.displayName ?? menuFor,
            movable: !archivedSet[menuFor],
            mutedUntil: mutedUntilOf(mutes, menuFor, Math.floor(Date.now() / 1000)),
            pinned: Boolean(pinned[menuFor]),
            folders: menuFolders,
            unread: unreadFor(menuFor).unread
          })}
          onClose={() => setMenuFor(null)}
          onSelect={id => onMenuSelect(menuFor, id)}
          visible
        />
      ) : null}

      {/*
        The profile editor, opened from the row menu's Edit profile.

        A sibling of the row menu rather than a page inside it: the menu is a
        list of intentions and this is a form, and `RowMenu` closes on every
        selection — including this one — so the two are never on screen at once.
      */}
      {profileFor && byName[profileFor] ? (
        <BotProfileSheet
          avatarUri={avatars[profileFor]}
          bot={byName[profileFor]}
          gateway={profileGateway}
          gatewayId={gatewayId}
          http={http}
          gatewayVersion={config?.version ?? ''}
          onClose={() => setProfileFor(null)}
          onOpenMemory={() => {
            // The sheet goes first, so the page is not a second modal over it.
            setProfileFor(null)
            setMemoryFor(profileFor)
          }}
          {...(onOpenConversations
            ? {
                onOpenConversations: () => {
                  // The sheet closes first: the page it opens is a full screen,
                  // and leaving a sheet behind it would put the reader back on
                  // this bot's profile when they press Back.
                  setProfileFor(null)
                  onOpenConversations(profileFor)
                }
              }
            : {})}
          onSaved={() => void runtime?.bots.refresh()}
          visible
        />
      ) : null}

      {/*
        `onOpened` is what makes this the chat list's entry point rather than
        Settings': a bot made here lands the reader in its conversation, which
        is the only reason they made it. The chat it opens is the canonical one,
        resolved the ordinary way — `NewBotFlow` never mints a session itself.
      */}
      <NewBotFlow onClose={() => setCreatingBot(false)} onOpened={bot => openBot(bot)} visible={creatingBot} />
    </View>
  )
}

/** The compact shell's Chats screen shows the stopped-gateway card in place of the list. */
export function BotsScreenOrSignedOut(props: BotsScreenProps) {
  const { config, lastError, status } = useGateway()

  // Every stop, not only a signed-out one: a gateway that refuses this address
  // has no roster to list either, and the list's "showing the last saved list"
  // reads as a delay rather than as a dead end.
  return gatewayStop({ config, error: lastError, status }) ? <GatewayStoppedPanel /> : <BotsScreen {...props} />
}

/**
 * The width at or above which the header's actions stay on one row.
 *
 * Four incompressible controls sit beside a `flex: 1` title — Boards, New bot,
 * `+`, Edit — and three of them are WORDS, which do not shrink. At the narrow
 * sidebar's 300pt the title had nothing left: "Chats" wrapped to one character
 * per line and "New bot…" truncated mid-word. Measured against the header's own
 * width rather than the window's or the platform's, because the thing that runs
 * out of room is this row: the same 300pt happens on an iPad in portrait, on a
 * Mac window dragged narrow, and in the gallery's mimic of the sidebar, and
 * `Platform.OS` answers none of them.
 *
 * 330 sits between the two widths that exist — `SIDEBAR_WIDTH_NARROW` at 300,
 * which must collapse, and `SIDEBAR_WIDTH` at 340, which comfortably does not.
 */
export const BOTS_HEAD_INLINE_MIN_WIDTH = 330

/**
 * The secondary actions, behind one `…` when the row cannot hold them.
 *
 * `+` deliberately stays out of it and stays visible: it is the one control here
 * that makes something rather than navigating, it is a glyph and therefore costs
 * a fixed 38pt whatever the width, and burying the primary action of a screen
 * inside an overflow menu to save room for a title is the wrong trade.
 *
 * Drawn the way every other floating menu in the app is drawn — an opaque glass
 * surface, absolutely positioned so that opening it lays nothing out, arriving
 * from above because that is where the button is. It is not `ContextMenuHost`:
 * that one is a long-press and secondary-click host backed by a native Mac view,
 * so on an iPad it would render no menu at all and the actions would simply be
 * gone.
 */
function HeadOverflowMenu({
  editing,
  onBoards,
  onNewBot,
  onToggleEdit
}: {
  editing: boolean
  onBoards?: () => void
  onNewBot?: () => void
  onToggleEdit: () => void
}) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)

  useEscapeKey(() => setOpen(false), open)

  const rows: { id: string; label: string; onPress: () => void }[] = [
    ...(onBoards ? [{ id: 'boards', label: kanbanStrings.menu, onPress: onBoards }] : []),
    ...(onNewBot ? [{ id: 'new-bot', label: profileStrings.settings.newBot, onPress: onNewBot }] : []),
    { id: 'edit', label: editing ? strings.layout.done : strings.layout.edit, onPress: onToggleEdit }
  ]

  return (
    <View>
      <Pressable
        accessibilityLabel={strings.bots.moreActions}
        accessibilityRole="button"
        // `aria-expanded`, not `accessibilityState`: react-native-web drops the
        // object spelling on the floor. See `accessibility-state.test.tsx`.
        aria-expanded={open}
        hitSlop={TAP_SLOP}
        onPress={() => setOpen(current => !current)}
        style={{ cursor: 'pointer' }}
        testID="bots-head-overflow"
      >
        <Icon color={theme.colors.accentText} name="ellipsis" size={ICON_SIZE.control} />
      </Pressable>

      <Appear
        rise={-6}
        style={{
          position: 'absolute',
          right: 0,
          // Clear of the button rather than measured off it: the row's height is
          // the 38pt control beside it, and a menu that overlapped the thing
          // that opened it would take its own next tap.
          top: theme.space.xl,
          zIndex: 2
        }}
        visible={open}
      >
        {/*
          `float`, which is the app's own name for a surface that hangs over
          content rather than holding a screen together, and which already
          carries the radius and the shadow that go with it.

          `opaque` for the reason `AttachMenu` gives: a text-heavy surface takes
          the solid rung under its wash, so its contrast is a fixed number
          rather than a function of whatever is behind it. Without it this menu
          floats over the chat list at the wash's own alpha, and the simulator
          showed "Edit" printed across the name of the chat underneath — two
          strings at the same weight in the same place.
        */}
        <GlassSurface contentStyle={{ minWidth: 168, paddingVertical: theme.space.xxs }} opaque variant="float">
          {rows.map(row => (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              key={row.id}
              onPress={() => {
                setOpen(false)
                row.onPress()
              }}
              style={{
                cursor: 'pointer',
                justifyContent: 'center',
                minHeight: CONTROL_MIN_HEIGHT,
                paddingHorizontal: theme.space.md
              }}
              testID={`bots-head-overflow-${row.id}`}
            >
              <Text color="accentText" style={{ fontWeight: '600' }} variant="preview">
                {row.label}
              </Text>
            </Pressable>
          ))}
        </GlassSurface>
      </Appear>
    </View>
  )
}

function Head({
  editing,
  onBoards,
  onNewBot,
  onNewCron,
  onToggleEdit,
  sidebar
}: {
  editing: boolean
  onBoards?: () => void
  onNewBot?: () => void
  onNewCron?: () => void
  onToggleEdit: () => void
  sidebar: boolean
}) {
  const theme = useTheme()
  /*
    `null` until the row has been laid out once, and the inline row is what it
    draws meanwhile.

    Deliberately optimistic: every width except the narrow sidebar's keeps the
    actions inline, so guessing that way means one arrangement on the common
    path and a single swap on the narrow one. Guessing the other way would flash
    a `…` into every phone header for a frame.
  */
  const [width, setWidth] = useState<number | null>(null)
  const inline = width === null || width >= BOTS_HEAD_INLINE_MIN_WIDTH

  return (
    <View
      onLayout={event => {
        const measured = event.nativeEvent.layout.width

        // Only on a real change: `onLayout` fires for every pass, and setting
        // state from each one is a render loop on a row that also holds a menu.
        setWidth(current => (current !== null && Math.abs(current - measured) < 1 ? current : measured))
      }}
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.md,
        paddingBottom: theme.space.md,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.panel,
        // The overflow menu is absolutely positioned inside this row and has to
        // be allowed to hang below it.
        zIndex: 1
      }}
      testID="bots-head"
    >
      <View style={{ flex: 1 }}>
        {/*
          One line, always. Without it the title is a `flex: 1` column next to
          four things that do not compress, and at the narrow sidebar's width
          "Chats" wrapped to one character per line — six rows of one letter.
          Eliding is the honest failure here: the word is the screen's name and
          a reader who sees "Cha…" has still been told which screen this is.
        */}
        <Text accessibilityRole="header" aria-level={1} numberOfLines={1} variant={sidebar ? 'titleWide' : 'title'}>
          {strings.bots.title}
        </Text>
        {/* Which gateway this list belongs to, and only once there is more
            than one of them to tell apart. */}
        <GatewayNameLine />
      </View>

      {/*
        Its own control rather than a second meaning for the `+`. That button
        says New cron and makes a cron; a menu behind it would take a
        one-tap action away from the thing it is for, and two `+` glyphs side by
        side would say nothing about which is which. This one is a word.
      */}
      {/*
        The chat list's way into the boards. A word rather than a glyph, for the
        same reason New bot is one: there is no mark that reads as "kanban", and
        the `+` beside it already means New cron.
      */}
      {inline && onBoards ? (
        <Pressable
          accessibilityLabel={kanbanStrings.menu}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onBoards}
          style={{ cursor: 'pointer' }}
          testID="bots-boards"
        >
          <Text color="accentText" style={{ fontWeight: '600' }} variant="preview">
            {kanbanStrings.menu}
          </Text>
        </Pressable>
      ) : null}

      {inline && onNewBot ? (
        <Pressable
          accessibilityLabel={profileStrings.settings.newBot}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onNewBot}
          style={{ cursor: 'pointer' }}
          testID="bots-new-bot"
        >
          <Text color="accentText" style={{ fontWeight: '600' }} variant="preview">
            {profileStrings.settings.newBot}
          </Text>
        </Pressable>
      ) : null}

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

      {inline ? null : (
        <HeadOverflowMenu
          editing={editing}
          onToggleEdit={onToggleEdit}
          {...(onBoards ? { onBoards } : {})}
          {...(onNewBot ? { onNewBot } : {})}
        />
      )}

      {inline ? (
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
      ) : null}
    </View>
  )
}

/*
  There is no drop LINE any more, and the objection that put one here is worth
  keeping rather than deleting.

  It said: a gap that opens up moves every row below it on every slot change,
  which on a list of forty is forty layout passes per centimetre of finger
  travel. That was true of a gap made of LAYOUT. The gap under the finger is now
  made of `transform: translateY` on the native driver (`use-row-drag.ts`), which
  triggers no layout at all and does not touch the JavaScript thread — and
  `rowShift` moves only the rows BETWEEN the lifted row's own place and the gap,
  so the count is the distance dragged rather than the length of the list.

  With the gap affordable, the line is redundant: every native list answers
  "where would this land" with the shape of the list, and a line as well is a
  second answer to a question already answered.
*/

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
  /*
    The ring belongs to the PILL, and that is the whole of the browser report.

    A browser rings the `<input>`, which here is a 20pt text line sitting inside
    a 44pt pill — so the focus indicator was a small square-cornered rectangle
    floating in the middle of the control, in the system's accent rather than
    the theme's. `useFocusRing` suppresses that one on the input and draws the
    app's own on this view; on iOS and Android both halves are no-ops.
  */
  const focus = useFocusRing()

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
        paddingHorizontal: theme.space.md,
        ...focus.ringStyle
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
        style={[
          {
            /*
              The input fills the pill's HEIGHT as well as its width.

              `alignSelf: 'stretch'` with the text centred in it, rather than a
              20pt line box parked in the middle of a 44pt control: on the web a
              form control is a real hit target, and a 20pt one meant the bottom
              and top thirds of the search field did nothing when clicked. On
              iOS and Android the row was always the target, so this changes
              only where a pointer may land.
            */
            alignSelf: 'stretch',
            color: theme.colors.text,
            flex: 1,
            fontSize: line.fontSize,
            lineHeight: line.lineHeight,
            paddingVertical: 0
          },
          focus.fieldProps.style
        ]}
        testID="bots-search"
        value={value}
        onBlur={focus.fieldProps.onBlur}
        onFocus={focus.fieldProps.onFocus}
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
/**
 * A folder's own row: a disclosure control, a name, and what is inside it.
 *
 * It replaces the named divider ADR-0012 drew, and it is a different KIND of
 * thing rather than the same thing restyled. A divider was a heading — it stood
 * above its rows and had no inside, so there was nothing to close, nothing to
 * count while it was closed and nowhere to drop a row onto. This row owns what
 * follows it: tapping it folds those rows away, and folded away they still have
 * to be accounted for, which is what the badge is.
 *
 * The badge appears ONLY while the folder is closed. Open, every row inside is
 * on screen carrying its own count, and a total above them would be the same
 * information twice.
 */
function FolderHeader({
  autoFocus,
  counts,
  editing,
  folder,
  handleHandlers,
  onArm,
  onDisarm,
  onMenuSelect,
  onMove,
  onRename,
  onToggle,
  open
}: {
  autoFocus?: boolean
  counts: FolderCounts
  editing: boolean
  folder: Folder
  /**
   * Edit mode only: the pan handlers the grip column carries.
   *
   * The same prop a chat row takes, from the same hook, keyed by this folder's
   * row key. A folder that had a grip of its own would be a second gesture to
   * keep in step with the first.
   */
  handleHandlers?: PanResponderInstance['panHandlers']
  /** Arm the drag for this folder's row key. The header's `onLongPress`. */
  onArm?: (rowKey: string) => void
  onDisarm?: () => void
  onMenuSelect: (folderId: string, id: string) => void
  /** Edit mode only: one position up or down among the top-level entries. */
  onMove?: (folderId: string, offset: number) => void
  /** Turns edit mode on with this folder's field focused; the menu's Rename. */
  onRename?: (id: string) => void
  onToggle: (id: string, open: boolean) => void
  open: boolean
}) {
  const theme = useTheme()
  const hover = useHover()
  const mutes = useChatLayoutStore(state => state.mutes)
  const swatch = theme.accent(folder.colour ?? 'default')

  const menu = useMemo(
    () =>
      folderMenuItems({
        colour: folder.colour ?? 'default',
        mutedUntil: folderMuteState(folder, mutes, Math.floor(Date.now() / 1000)),
        name: folder.name
      }),
    [folder, mutes]
  )

  const label = [
    folder.name || strings.layout.unnamedFolder,
    open || counts.unread === 0 ? '' : strings.layout.folderUnread(counts.unread),
    open || !counts.needsInput ? '' : strings.layout.folderNeedsInput
  ]
    .filter(Boolean)
    .join(', ')

  /* The same pair the chat rows carry, for the readers a grip does not serve. */
  const reorderable = editing && Boolean(onMove)

  const heading = (
    <Pressable
      {...(reorderable
        ? {
            accessibilityActions: [
              { name: 'moveUp', label: strings.layout.moveUp },
              { name: 'moveDown', label: strings.layout.moveDown }
            ],
            onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
              if (event.nativeEvent.actionName === 'moveUp') {
                onMove?.(folder.id, -1)
              } else if (event.nativeEvent.actionName === 'moveDown') {
                onMove?.(folder.id, 1)
              }
            }
          }
        : {})}
      accessibilityHint={open ? strings.layout.collapseFolder(folder.name) : strings.layout.expandFolder(folder.name)}
      accessibilityLabel={label}
      accessibilityRole="button"
      aria-expanded={open}
      delayLongPress={300}
      /*
        The same split a chat row makes, for the same reason: where the platform
        draws a context menu a long press already means that, so this arms the
        drag and the two separate by themselves — hold still for the menu, hold
        and move for the drag. Where there is no native menu the long press is
        left alone and the grip in edit mode is the way in.
      */
      onLongPress={() => (HAS_NATIVE_CONTEXT_MENU ? onArm?.(folderRowKey(folder.id)) : undefined)}
      onPress={() => onToggle(folder.id, !open)}
      onPressOut={onDisarm}
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
      testID={`folder-${folder.id}`}
      {...hover.props}
    >
      {/*
        The grip, in edit mode, exactly where a chat row's is.

        A `View` and not a `Pressable`, for the reason `BotRow` gives: a
        pressable would claim the touch before the pan responder saw it. It is
        the first thing in the row so the two columns of grips line up, which is
        what makes "hold this and move it" read as one affordance for both kinds
        of row rather than two.
      */}
      {editing && handleHandlers ? (
        <DragGrip
          accessibilityLabel={strings.layout.dragHint}
          handlers={handleHandlers}
          testID={`folder-drag-handle-${folder.id}`}
        />
      ) : null}

      {/* Decorative: the row's own expanded state is what a screen reader reads,
          and `Icon` keeps itself out of the tree so it cannot say it twice. */}
      <Icon color={swatch.fill} name={open ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.marker} />

      {editing ? (
        <TextInput
          accessibilityHint={strings.layout.editFolderHint}
          accessibilityLabel={strings.layout.folderName}
          // A folder that has just been added is focused straight into: the
          // whole reason it exists is that it needs a name.
          autoFocus={autoFocus === true}
          autoCapitalize="words"
          onChangeText={next => useChatLayoutStore.getState().renameFolder(folder.id, next)}
          // The PLACEHOLDER, never the value. Seeding the field is what left
          // "New sectionFinance" on a real device.
          placeholder={strings.layout.folderName}
          placeholderTextColor={theme.colors.textFaint}
          returnKeyType="done"
          selectTextOnFocus
          style={{
            backgroundColor: theme.tintSunk,
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
          testID={`folder-name-${folder.id}`}
          value={folder.name}
        />
      ) : (
        <Text color="text" style={{ flex: 1, fontWeight: '600' }} variant="preview">
          {folder.name || strings.layout.unnamedFolder}
        </Text>
      )}

      {/* Closed only. Open, every row inside says its own number. */}
      {!open && counts.needsInput ? (
        <View
          style={{
            backgroundColor: theme.presence.needsInput,
            borderRadius: 5,
            height: 10,
            width: 10
          }}
          testID={`folder-needs-input-${folder.id}`}
        />
      ) : null}

      {!open && counts.unread > 0 ? (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: swatch.fill,
            borderRadius: 11,
            minWidth: 22,
            paddingHorizontal: 6,
            paddingVertical: 2
          }}
          testID={`folder-unread-${folder.id}`}
        >
          <Text color="onAccent" variant="meta">
            {unreadBadgeLabel(counts.unread)}
          </Text>
        </View>
      ) : null}

      {editing ? (
        <Pressable
          accessibilityLabel={strings.layout.removeFolder(folder.name)}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={() => useChatLayoutStore.getState().removeFolder(folder.id)}
          style={({ pressed }) => ({
            cursor: 'pointer',
            borderColor: theme.hairline,
            borderRadius: theme.radii.pill,
            borderWidth: 1,
            opacity: pressed ? 0.6 : 1,
            paddingHorizontal: theme.space.md,
            paddingVertical: 6
          })}
          testID={`folder-remove-${folder.id}`}
        >
          <Text color="dangerText" variant="meta">
            {strings.layout.remove}
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  )

  return (
    <ContextMenuHost
      items={menu}
      menuTitle={folder.name || strings.layout.unnamedFolder}
      onSelect={selected => {
        if (selected === 'rename') {
          onRename?.(folder.id)

          return
        }

        onMenuSelect(folder.id, selected)
      }}
      testID={`folder-menu-${folder.id}`}
    >
      {heading}
    </ContextMenuHost>
  )
}

/**
 * An open folder with nothing in it.
 *
 * It exists so a folder somebody has just emptied still has a body to drop a
 * chat back into — without it there is no gap of its own between the header and
 * whatever follows, and a folder becomes a one-way trip.
 */
function FolderEmpty({ id }: { id: string }) {
  const theme = useTheme()

  return (
    <View
      style={{
        justifyContent: 'center',
        minHeight: 38,
        paddingBottom: theme.space.sm,
        paddingHorizontal: theme.space.lg
      }}
      testID={`folder-empty-${id}`}
    >
      <Text color="textFaint" variant="meta">
        {strings.layout.folderEmpty}
      </Text>
    </View>
  )
}

/**
 * When a whole folder is silent until, or `null` when any chat in it is not.
 *
 * The menu asks one question — should this offer Mute or Unmute — and a folder
 * that is half muted has to answer "not muted", because the useful action there
 * is to silence the rest rather than to un-silence the few. `MUTE_FOREVER`
 * wins over a deadline for the same reason a deadline wins over nothing: the
 * label has to describe the state a reader would still be in.
 */
function folderMuteState(folder: Folder, mutes: Mutes, now: number): number | null {
  if (!folder.bots.length) {
    return null
  }

  let soonest: number | null = null

  for (const name of folder.bots) {
    if (!isMuted(mutes, name, now)) {
      return null
    }

    const until = mutes[name] as number

    if (until === MUTE_FOREVER) {
      continue
    }

    soonest = soonest === null || until < soonest ? until : soonest
  }

  // Every chat is muted; `null` here would mean "not muted", so a folder that is
  // muted forever reports the deadline that never comes.
  return soonest ?? MUTE_FOREVER
}

function ArchiveHeader({ count, onToggle, open }: { count: number; onToggle: () => void; open: boolean }) {
  const theme = useTheme()
  const hover = useHover()

  return (
    <Pressable
      accessibilityRole="button"
      aria-expanded={open}
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

function EditBar({ onAddFolder }: { onAddFolder: (id: string) => void }) {
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
        onPress={() => onAddFolder(useChatLayoutStore.getState().addFolder(''))}
        style={{ cursor: 'pointer' }}
        testID="add-folder"
      >
        <Text color="accentText" style={{ fontWeight: '600' }} variant="meta">
          {strings.layout.newFolder}
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
