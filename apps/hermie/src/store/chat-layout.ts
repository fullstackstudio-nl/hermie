/**
 * How the chat list is arranged — and that is ALL it is.
 *
 * The order of the rows, the FOLDERS they are grouped into, which bots are
 * archived, what colour each chat carries and whether the list is showing at all
 * on the wide layout are the owner's arrangement of their own list.
 *
 * The arrangement itself — the top-level order, the folders and the one-folder
 * invariant — lives in `store/folders.ts` as a value and the functions that move
 * it. This file is what gives it a lifetime, a disk and a gateway.
 *
 * ADR-0012 kept all of it on the device, because the only gateway scope then in
 * view was `config.set` — global settings that Hermes Desktop and the TUI read
 * too, so a divider called "Finance" created on a phone would have rearranged
 * both. ADR-0016 found the scope that does fit: `ui_meta`, per profile, per
 * top-level key, read by nothing but Hermie. So this store is still the thing
 * the UI paints from and still the thing that works with no gateway at all —
 * and `store/ui-meta-bridge.ts` mirrors it, without this file knowing. The one
 * field that stays purely local is `sidebarCollapsed`; see `applyRemote`.
 *
 * Two consequences worth stating, because they are the ones a reader will hit:
 *
 *  - The layout is keyed by GATEWAY. "Change gateway" therefore starts with an
 *    empty arrangement — a different machine's bots are a different list — and
 *    "Sign out" keeps it, because the address survives and so does the list it
 *    described. Neither case needs any clean-up code; the key does the work.
 *  - The roster is the source of truth for WHICH bots exist. The layout only
 *    ever says where they sit, so a bot that disappears from the gateway is
 *    dropped from the arrangement lazily, on the next reconcile, without
 *    disturbing anything around it.
 */
import { create } from 'zustand'

import { keyValueStore } from '../platform/key-value-store'
import { ACCENTS, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH, type AccentName } from '../ui/tokens'
import {
  addFolder,
  botsInOrder,
  moveBotTo,
  moveBotToFolder,
  moveFolderTo,
  newFolderId,
  readArrangement,
  reconcileBots,
  removeFolder,
  renameFolder,
  setFolderColour,
  type Arrangement,
  type Folder,
  type LayoutEntry
} from './folders'
import { isMuted, mutesOf, withoutExpired, type Mutes } from './mute'

export const CHAT_LAYOUT_KEY = 'hermie.chats.layout'

export type { Arrangement, Folder, LayoutEntry } from './folders'

export interface PersistedLayout {
  /** The top level, in order: folders by id and loose chats. */
  entries: LayoutEntry[]
  /** Each folder's name, colour and contents. */
  folders?: Folder[]
  /**
   * Folder ids the reader has closed, on THIS device.
   *
   * Local like `sidebarCollapsed`, and for the same reason: which groups are
   * open is about the window in front of somebody, not about how their list is
   * arranged. A Mac with everything folded away must not fold a phone's list,
   * and the phone has the room to keep them open.
   */
  collapsed?: string[]
  archived: string[]
  /**
   * Chats held at the top of whatever container they sit in.
   *
   * A list rather than a map, like `archived` beside it and for the same reason:
   * the value is always "yes", so a map would be a set of keys pointing at
   * `true` and cost a byte a chat to say nothing.
   */
  pinned?: string[]
  /**
   * Chats the reader opens as their OWN conversation rather than the shared
   * Bot Chat (ADR-0007, amended). A list of bot names, like `archived` and
   * `pinned` beside it, because the value is always "yes".
   */
  myChats?: string[]
  accents: Record<string, AccentName>
  /** Bot name -> the second its silence lapses, or 0 for forever. */
  mutes?: Mutes
  /**
   * Whether the owner has hidden the list on the wide layout.
   *
   * ABSENT is a third value and it is the one that matters: it means nobody has
   * asked for either, so the window's own width decides (`resolveSidebarCollapsed`
   * below). Stored as a boolean once the owner touches the control, and stored
   * HERE rather than in the settings store because the question it answers is
   * "how is this gateway's chat list arranged", which is what ADR-0012 scopes to
   * a gateway: the arrangement survives Sign out, because the address and the list
   * it described both survive, and starts empty after Change gateway, because a
   * different machine's bots are a different list. A settings-store copy would
   * survive Change gateway too, which is the one thing it must not do.
   */
  sidebarCollapsed?: boolean
}

type LayoutsOnDisk = Record<string, PersistedLayout>

export interface ChatLayoutState {
  /** The gateway this arrangement belongs to; null before the first load. */
  gatewayKey: string | null
  entries: LayoutEntry[]
  folders: Folder[]
  /** Folder ids closed on this device. Never synced; see `PersistedLayout`. */
  collapsed: Record<string, true>
  archived: Record<string, true>
  /**
   * Which chats are held at the top of their container.
   *
   * In the ARRANGEMENT slice rather than on each bot's own profile, beside the
   * order and the folders it belongs with: a pin does not describe the bot, it
   * describes where the reader keeps it — which is the same thing `entries` and
   * `folders` describe, and the same reason they are all in one section.
   *
   * It is a display SORT and never a move. The arrangement underneath is
   * untouched, so unpinning a chat puts it back exactly where it was rather than
   * wherever the top of the list has drifted to since. That is the whole reason
   * this is a separate key instead of `moveBotTo(0)`.
   */
  pinned: Record<string, true>
  /**
   * Which bots this reader talks to in a chat of their own.
   *
   * In the app-wide section rather than on each bot's profile, beside `mutes`
   * and for the same reason: it is a fact about the READER, not about the bot.
   * Two people sharing a gateway do not share a choice about whose transcript
   * they are in — that is the entire point of the feature.
   */
  myChats: Record<string, true>
  accents: Record<string, AccentName>
  /**
   * Which chats are silent, and until when.
   *
   * Unlike `archived` and `accents` this is about the READER rather than about
   * the bot, so it rides in the app-wide section beside the order and the theme
   * rather than on the bot's own profile: two people sharing a gateway do not
   * share a bedtime.
   */
  mutes: Mutes
  /**
   * The owner's explicit choice about the wide layout's sidebar, or `undefined`
   * while they have not made one. Read through `resolveSidebarCollapsed`, never
   * directly: on its own it does not say what the shell should draw.
   */
  sidebarCollapsed?: boolean
  /** False until the disk read finishes; the list paints the roster order meanwhile. */
  loaded: boolean

  load: (gatewayKey: string) => Promise<void>
  reconcile: (botNames: readonly string[]) => void
  /** One position up or down within whatever container the bot is in. */
  moveBy: (botName: string, offset: number) => void
  /** Put a chat at the end of a folder; `null` is the loose top level. */
  moveToFolder: (botName: string, folderId: string | null) => void
  /** Commit a drag: `index` is read against the target container as it is. */
  dropBot: (botName: string, folderId: string | null, index: number) => void
  /** Commit a drag of a folder itself, to `index` of the top level. */
  dropFolder: (folderId: string, index: number) => void
  /**
   * One step up or down among the TOP-LEVEL entries.
   *
   * The folder twin of `moveBy`, and it exists for the same readers: the grip
   * is a gesture, and a keyboard and a screen reader need a way to reorder that
   * is not one. A step counts every top-level entry — folders and loose chats
   * alike — because that is what "up" means to somebody looking at the rows.
   */
  moveFolderBy: (folderId: string, offset: number) => void
  /** A new, empty folder at the end. Answers its id, for the rename field. */
  addFolder: (name: string) => string
  /** A new folder holding just this chat, so the row you asked from starts it. */
  addFolderAround: (botName: string, name: string) => string
  renameFolder: (id: string, name: string) => void
  setFolderColour: (id: string, colour: AccentName) => void
  /** Drop a folder; its bots come back to the top level where it stood. */
  removeFolder: (id: string) => void
  /** Open or close a folder on this device. */
  setFolderOpen: (id: string, open: boolean) => void
  setArchived: (botName: string, archived: boolean) => void
  /** Hold this chat at the top of its container, or let it go. */
  setPinned: (botName: string, pinned: boolean) => void
  /** The row menu's and the popover's one-press form of the above. */
  togglePinned: (botName: string) => void
  /** Open this bot as the reader's own chat, or back to the shared one. */
  setMyChat: (botName: string, mine: boolean) => void
  setAccent: (botName: string, accent: AccentName) => void
  /** Silence one chat until `until` seconds, `0` for forever, `null` to stop. */
  setMute: (botName: string, until: number | null) => void
  /**
   * Forget the mutes that have lapsed.
   *
   * An optimisation, never a correctness step: every reader already compares
   * the deadline against the clock, so a mute nobody has swept is a mute that
   * has already stopped working. This keeps the section from accumulating
   * deadlines from last spring. A no-op when nothing expired, so it can be
   * called on every foreground without sending the section again.
   */
  dropExpiredMutes: (now: number) => void
  /** Record an explicit Hide/Show. There is no "back to automatic" — see the type. */
  setSidebarCollapsed: (collapsed: boolean) => void
  /**
   * Replace the parts ADR-0016 syncs with the gateway's copy.
   *
   * `sidebarCollapsed` is deliberately NOT in here. It is about the WINDOW the
   * reader is looking at — a phone has no sidebar and a Mac window has one at a
   * different width — so a desktop hiding its list must not collapse a tablet's.
   * It stays what ADR-0012 made it: local to the device.
   *
   * The arrival is persisted like any other change, because the device's own copy
   * is what the UI paints from and a copy that only lived in memory would be gone
   * on the next launch.
   */
  applyRemote: (patch: {
    arrangement?: Arrangement
    archived?: string[]
    pinned?: string[]
    myChats?: string[]
    accents?: Record<string, AccentName>
    mutes?: Mutes
  }) => void
  reset: () => void
}

const INITIAL = {
  gatewayKey: null as string | null,
  entries: [] as LayoutEntry[],
  folders: [] as Folder[],
  collapsed: {} as Record<string, true>,
  archived: {} as Record<string, true>,
  pinned: {} as Record<string, true>,
  myChats: {} as Record<string, true>,
  accents: {} as Record<string, AccentName>,
  mutes: {} as Mutes,
  sidebarCollapsed: undefined as boolean | undefined,
  loaded: false
}

let writeQueue: Promise<void> = Promise.resolve()

/**
 * Persist one gateway's arrangement, leaving every other gateway's alone.
 *
 * Read-modify-write rather than a key per gateway: the alternative needs a
 * second index to know which keys exist, and losing that index orphans every
 * arrangement it pointed at.
 */
function persist(gatewayKey: string, layout: PersistedLayout): void {
  writeQueue = writeQueue
    .then(async () => {
      const all = (await keyValueStore.getJson<LayoutsOnDisk>(CHAT_LAYOUT_KEY)) ?? {}

      await keyValueStore.setJson(CHAT_LAYOUT_KEY, { ...all, [gatewayKey]: layout })
    })
    .catch(() => {
      // A lost arrangement costs the owner their ordering, not their data. It is
      // not worth an error in front of someone who was only dragging a row.
    })
}

/** Read a stored blob defensively: an older build may have written anything. */
function asLayout(value: unknown): PersistedLayout {
  const raw = (value ?? {}) as Partial<PersistedLayout>
  // `readArrangement` also migrates: a blob written before folders carries
  // `divider` entries inline, and each one becomes a folder holding the chats
  // below it up to the next divider.
  const arrangement = readArrangement(raw.entries, raw.folders)
  const accents: Record<string, AccentName> = {}

  for (const [bot, accent] of Object.entries(raw.accents ?? {})) {
    if (typeof accent === 'string' && accent in ACCENTS) {
      accents[bot] = accent as AccentName
    }
  }

  return {
    entries: arrangement.entries,
    folders: arrangement.folders,
    collapsed: (Array.isArray(raw.collapsed) ? raw.collapsed : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    ),
    archived: (Array.isArray(raw.archived) ? raw.archived : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    pinned: (Array.isArray(raw.pinned) ? raw.pinned : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    myChats: (Array.isArray(raw.myChats) ? raw.myChats : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    accents,
    mutes: mutesOf(raw.mutes),
    // Only a real boolean counts. Anything else — a missing key, a string an
    // older build wrote — has to read as "never chosen", because that is the
    // value the width bands are allowed to answer for.
    ...(typeof raw.sidebarCollapsed === 'boolean' ? { sidebarCollapsed: raw.sidebarCollapsed } : {})
  }
}

/**
 * A loose chat's position among the LOOSE chats, as a position among entries.
 *
 * The top level interleaves folders and chats, so "second loose chat" and
 * "entry 2" are only the same number on a list with no folders in it. `moveBy`
 * thinks in loose positions, because that is what up and down mean to a reader
 * looking at rows; everything below it thinks in entry positions.
 *
 * `from` is the moving chat's own loose index, and it is what turns a step DOWN
 * into the right entry: `moveBotTo` reads its index against the list without the
 * moving row, so landing after the chat currently below means taking that chat's
 * entry position rather than the one after it.
 */
function looseToEntryIndex(arrangement: Arrangement, loose: number, from: number): number {
  const positions: number[] = []

  arrangement.entries.forEach((entry, index) => {
    if (entry.kind === 'chat') {
      positions.push(index)
    }
  })

  const target = positions[loose]

  if (target === undefined) {
    return arrangement.entries.length
  }

  // Moving down: the row at `loose` keeps its entry position once ours is gone,
  // so landing after it is that position. Moving up: land on it.
  return loose > from ? target : target
}

export const useChatLayoutStore = create<ChatLayoutState>((set, get) => {
  const save = (): void => {
    const { gatewayKey, entries, folders, collapsed, archived, pinned, myChats, accents, mutes, sidebarCollapsed } =
      get()

    if (gatewayKey) {
      persist(gatewayKey, {
        entries,
        folders,
        collapsed: Object.keys(collapsed),
        archived: Object.keys(archived),
        pinned: Object.keys(pinned),
        myChats: Object.keys(myChats),
        accents,
        mutes,
        // Omitted while nobody has chosen, so that "never chosen" survives a
        // round trip as the absence it is rather than as a `false` the width
        // bands would then never get to answer for.
        ...(sidebarCollapsed === undefined ? {} : { sidebarCollapsed })
      })
    }
  }

  /** Every arrangement edit lands here, so every one of them is persisted. */
  const write = (arrangement: Arrangement): void => {
    set({ entries: arrangement.entries, folders: arrangement.folders })
    save()
  }

  const arrangementOf = (): Arrangement => ({ entries: get().entries, folders: get().folders })

  return {
    ...INITIAL,

    async load(gatewayKey) {
      const all = await keyValueStore.getJson<LayoutsOnDisk>(CHAT_LAYOUT_KEY)
      const stored = asLayout(all?.[gatewayKey])
      const archived: Record<string, true> = {}

      for (const name of stored.archived) {
        archived[name] = true
      }

      const collapsed: Record<string, true> = {}

      for (const id of stored.collapsed ?? []) {
        collapsed[id] = true
      }

      const pinned: Record<string, true> = {}

      for (const name of stored.pinned ?? []) {
        pinned[name] = true
      }

      const myChats: Record<string, true> = {}

      for (const name of stored.myChats ?? []) {
        myChats[name] = true
      }

      set({
        gatewayKey,
        entries: stored.entries,
        folders: stored.folders ?? [],
        collapsed,
        archived,
        pinned,
        myChats,
        accents: stored.accents,
        mutes: stored.mutes ?? {},
        sidebarCollapsed: stored.sidebarCollapsed,
        loaded: true
      })
    },

    /**
     * Fold the live roster into the arrangement.
     *
     * New bots land at the end of the loose top-level run, before the first
     * folder — the end of the list would bury them inside whatever folder is
     * last, and the top would push them in front of the chat the owner is
     * reading. Bots that no longer exist are dropped from wherever they were.
     */
    reconcile(botNames) {
      const next = reconcileBots(arrangementOf(), botNames)

      if (next !== arrangementOf()) {
        write(next)
      }
    },

    /**
     * Move one chat up or down WITHIN its own container.
     *
     * Deliberately not across containers any more. When the groups were
     * headings, stepping past one was how a bot changed section and the same
     * gesture as stepping past another bot — one flat array made the two
     * identical. A folder is a container: "down" inside it means the next row
     * inside it, and running off the end into the next folder is not a step
     * anybody asked for. Moving BETWEEN folders is `moveToFolder`, the drag, or
     * the row menu, all of which say which folder out loud.
     */
    moveBy(botName, offset) {
      if (offset === 0) {
        return
      }

      const arrangement = arrangementOf()
      const folderId = arrangement.folders.find(folder => folder.bots.includes(botName))?.id ?? null
      const container =
        folderId === null
          ? arrangement.entries.flatMap(entry => (entry.kind === 'chat' ? [entry.name] : []))
          : (arrangement.folders.find(folder => folder.id === folderId)?.bots ?? [])
      const from = container.indexOf(botName)

      if (from === -1) {
        return
      }

      const to = Math.max(0, Math.min(container.length - 1, from + offset))

      if (to === from) {
        return
      }

      /*
        `moveBotTo` reads its index against the container WITHOUT the moving
        row, so a step down is `to + 1` before the removal and `to` after it.
        At the top level the index counts folders too, so the loose position is
        translated back into an entry position here.
      */
      const target = folderId === null ? looseToEntryIndex(arrangement, to, from) : to

      write(moveBotTo(arrangement, botName, folderId, target))
    },

    moveToFolder(botName, folderId) {
      write(moveBotToFolder(arrangementOf(), botName, folderId))
    },

    /**
     * Commit a drag.
     *
     * `index` is read against the target container AS IT IS, including the
     * dragged row when it is already in that container — the number a caller
     * can actually compute, because a drop line sits between two rows it can
     * see. `features/bots/folder-rows.ts` does the correction for the removal,
     * which is what keeps "same container" and "different container" one path.
     */
    dropBot(botName, folderId, index) {
      write(moveBotTo(arrangementOf(), botName, folderId, index))
    },

    dropFolder(folderId, index) {
      write(moveFolderTo(arrangementOf(), folderId, index))
    },

    moveFolderBy(folderId, offset) {
      if (offset === 0) {
        return
      }

      const arrangement = arrangementOf()
      const from = arrangement.entries.findIndex(entry => entry.kind === 'folder' && entry.id === folderId)

      if (from === -1) {
        return
      }

      const to = Math.max(0, Math.min(arrangement.entries.length - 1, from + offset))

      if (to === from) {
        return
      }

      /*
        `to` unchanged, in BOTH directions, and it is worth saying why the
        correction `moveBy` needs is absent here.

        `moveFolderTo` splices into the list it has ALREADY taken the folder out
        of. Stepping down, the entry the folder is moving past has shifted up by
        one, so the full-list position `to` and the reduced-list insertion point
        `to` are the same index. Stepping up, nothing above the folder moved, so
        `to` is unchanged for the other reason. `moveBotTo` differs because it
        is given a position in the container as the CALLER sees it.
      */
      write(moveFolderTo(arrangement, folderId, to))
    },

    addFolder(name) {
      const id = newFolderId()

      write(addFolder(arrangementOf(), name, id))

      return id
    },

    /**
     * A new folder around one chat.
     *
     * "New folder" on a row you are looking at means that row is what the folder
     * is for, which is the same intent "Add divider above" served and a better
     * outcome: the divider left the chat where it was and hoped, and this puts
     * it inside.
     */
    addFolderAround(botName, name) {
      const id = newFolderId()

      write(moveBotToFolder(addFolder(arrangementOf(), name, id), botName, id))

      return id
    },

    renameFolder(id, name) {
      write(renameFolder(arrangementOf(), id, name))
    },

    setFolderColour(id, colour) {
      write(setFolderColour(arrangementOf(), id, colour))
    },

    removeFolder(id) {
      const collapsed = { ...get().collapsed }

      delete collapsed[id]
      set({ collapsed })
      write(removeFolder(arrangementOf(), id))
    },

    setFolderOpen(id, open) {
      const collapsed = { ...get().collapsed }

      if (open) {
        delete collapsed[id]
      } else {
        collapsed[id] = true
      }

      set({ collapsed })
      save()
    },

    setArchived(botName, archived) {
      const next = { ...get().archived }

      if (archived) {
        next[botName] = true
      } else {
        delete next[botName]
      }

      set({ archived: next })
      save()
    },

    setPinned(botName, pinned) {
      const next = { ...get().pinned }

      if (pinned) {
        next[botName] = true
      } else {
        delete next[botName]
      }

      set({ pinned: next })
      save()
    },

    togglePinned(botName) {
      const { pinned, setPinned } = get()

      setPinned(botName, !pinned[botName])
    },

    setMyChat(botName, mine) {
      const next = { ...get().myChats }

      // The shared Bot Chat is the absence of a choice rather than a choice of
      // its own, so it is stored as nothing. A roster of forty bots nobody has
      // moved then costs forty fewer entries and reads as "never asked".
      if (mine) {
        next[botName] = true
      } else {
        delete next[botName]
      }

      set({ myChats: next })
      save()
    },

    setAccent(botName, accent) {
      const accents = { ...get().accents }

      // Default is the absence of a choice rather than a choice of its own, so
      // it is stored as nothing. A roster of forty bots on the default colour
      // then costs forty fewer entries on disk and reads as "never set".
      if (accent === 'default') {
        delete accents[botName]
      } else {
        accents[botName] = accent
      }

      set({ accents })
      save()
    },

    setMute(botName, until) {
      const mutes = { ...get().mutes }

      if (until === null) {
        delete mutes[botName]
      } else {
        mutes[botName] = Math.floor(until)
      }

      set({ mutes })
      save()
    },

    dropExpiredMutes(now) {
      const swept = withoutExpired(get().mutes, now)

      // `null` is "nothing had lapsed", and returning early on it is what lets
      // this be called on every foreground: an equal copy would still count as
      // a change to the projection and send the whole section again.
      if (!swept) {
        return
      }

      set({ mutes: swept })
      save()
    },

    setSidebarCollapsed(collapsed) {
      set({ sidebarCollapsed: collapsed })
      save()
    },

    applyRemote(patch) {
      const archived: Record<string, true> = {}

      for (const name of patch.archived ?? []) {
        archived[name] = true
      }

      const pinned: Record<string, true> = {}

      for (const name of patch.pinned ?? []) {
        pinned[name] = true
      }

      const myChats: Record<string, true> = {}

      for (const name of patch.myChats ?? []) {
        myChats[name] = true
      }

      set({
        ...(patch.arrangement ? { entries: patch.arrangement.entries, folders: patch.arrangement.folders } : {}),
        ...(patch.archived ? { archived } : {}),
        // Absent is not empty: a section written by a build that predates the
        // field says nothing about pins, and reading that as "none" would
        // unpin every chat the moment an older device wrote the section.
        ...(patch.pinned ? { pinned } : {}),
        // Absent is not empty here either: a build that predates the field says
        // nothing about which chats are the reader's own, and reading that as
        // "none" would put them back in the shared transcript without asking.
        ...(patch.myChats ? { myChats } : {}),
        ...(patch.accents ? { accents: patch.accents } : {}),
        ...(patch.mutes ? { mutes: patch.mutes } : {})
      })
      save()
    },

    reset() {
      set(INITIAL)
    }
  }
})

/** Archived bots, in the order they sit in the arrangement. */
export function archivedOf(arrangement: Arrangement, archived: Record<string, true>): string[] {
  return botsInOrder(arrangement).filter(name => archived[name])
}

/** Every folder, for the row menu's "Move to folder". */
export function foldersOf(arrangement: Arrangement): { id: string; name: string }[] {
  return arrangement.folders.map(folder => ({ id: folder.id, name: folder.name }))
}

/**
 * Is this chat silent, as of now?
 *
 * The clock is read at render rather than subscribed to, which means a mute
 * that lapses while the list is on screen is not noticed until something else
 * re-renders it. That is the right trade for a feature whose whole point is
 * that nothing happens: the cost of being late is one row that goes on looking
 * quiet, and the alternative is a timer per row.
 */
export function useChatMuted(botName: string): boolean {
  const mutes = useChatLayoutStore(state => state.mutes)

  return isMuted(mutes, botName, Math.floor(Date.now() / 1000))
}

/** Is this chat held at the top of its container? */
export function useChatPinned(botName: string): boolean {
  return useChatLayoutStore(state => Boolean(state.pinned[botName]))
}

/** Is this bot opened as the reader's own chat rather than the shared one? */
export function useMyChat(botName: string): boolean {
  return useChatLayoutStore(state => Boolean(state.myChats[botName]))
}

/** One chat's colour. Part 2's header and outgoing bubble read this too. */
export function useChatAccent(botName: string): AccentName {
  return useChatLayoutStore(state => state.accents[botName] ?? 'default')
}

/**
 * Whether the wide layout should be drawing the sidebar collapsed.
 *
 * Two inputs and one rule, and the rule is the owner's: **the window decides
 * only where the owner has not.** An explicit Hide or Show wins at every width,
 * for as long as it is stored; with no choice on record the band answers, and the
 * band is a comparison against one number, which is what makes the second half of
 * the owner's rule true by construction — the same window width cannot produce two
 * answers, so nothing flips while the reader sits still and looks at it.
 *
 * Pure, and exported separately from the store because the shell, the rail, the
 * header button and the Mac's menu bar all have to agree about the answer. Three
 * copies of this comparison is how they would stop agreeing.
 *
 * Resizing DOES change the answer where there is no choice on record — dragging a
 * Mac window from 1200 to 800 collapses the list — which is the intended reading of
 * "start collapsed below 900": the window size is what changed, so the rule about
 * not flipping under a still reader does not apply.
 */
export function resolveSidebarCollapsed(choice: boolean | undefined, windowWidth: number): boolean {
  return choice ?? windowWidth < SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH
}
