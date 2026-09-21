/**
 * How the chat list is arranged — and that is ALL it is.
 *
 * The order of the rows, the named dividers between them, which bots are
 * archived, what colour each chat carries and whether the list is showing at all
 * on the wide layout are the owner's arrangement of their own list.
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

export const CHAT_LAYOUT_KEY = 'hermie.chats.layout'

/**
 * One position in the list. Dividers and chats live in ONE array rather than in
 * a tree of sections, which is what makes "move this bot into that section" a
 * swap of two adjacent positions instead of a graft between two containers.
 * Everything before the first divider is the unsectioned top group.
 */
export type LayoutEntry = { kind: 'divider'; id: string; name: string } | { kind: 'chat'; name: string }

export interface PersistedLayout {
  entries: LayoutEntry[]
  archived: string[]
  accents: Record<string, AccentName>
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
  archived: Record<string, true>
  accents: Record<string, AccentName>
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
  moveBy: (botName: string, offset: number) => void
  moveToSection: (botName: string, dividerId: string | null) => void
  addDivider: (name: string) => string
  /** A new section break immediately above one chat, so that chat starts it. */
  addDividerAbove: (botName: string, name: string) => string | null
  renameDivider: (id: string, name: string) => void
  /** Put a chat immediately before position `index` of the CURRENT entry list. */
  moveToIndex: (botName: string, index: number) => void
  removeDivider: (id: string) => void
  setArchived: (botName: string, archived: boolean) => void
  setAccent: (botName: string, accent: AccentName) => void
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
  applyRemote: (patch: { entries?: LayoutEntry[]; archived?: string[]; accents?: Record<string, AccentName> }) => void
  reset: () => void
}

const INITIAL = {
  gatewayKey: null as string | null,
  entries: [] as LayoutEntry[],
  archived: {} as Record<string, true>,
  accents: {} as Record<string, AccentName>,
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
  const entries: LayoutEntry[] = []
  const seen = new Set<string>()

  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    if (entry.kind === 'divider' && typeof entry.id === 'string' && entry.id) {
      entries.push({ kind: 'divider', id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' })
      continue
    }

    // A duplicated chat row would render the same bot twice and make every move
    // ambiguous, so the first position wins and the rest are dropped.
    if (entry.kind === 'chat' && typeof entry.name === 'string' && entry.name && !seen.has(entry.name)) {
      seen.add(entry.name)
      entries.push({ kind: 'chat', name: entry.name })
    }
  }

  const accents: Record<string, AccentName> = {}

  for (const [bot, accent] of Object.entries(raw.accents ?? {})) {
    if (typeof accent === 'string' && accent in ACCENTS) {
      accents[bot] = accent as AccentName
    }
  }

  return {
    entries,
    archived: (Array.isArray(raw.archived) ? raw.archived : []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    ),
    accents,
    // Only a real boolean counts. Anything else — a missing key, a string an
    // older build wrote — has to read as "never chosen", because that is the
    // value the width bands are allowed to answer for.
    ...(typeof raw.sidebarCollapsed === 'boolean' ? { sidebarCollapsed: raw.sidebarCollapsed } : {})
  }
}

let dividerCounter = 0

/** Divider ids only have to be unique within one gateway's arrangement. */
function newDividerId(): string {
  dividerCounter += 1

  return `d${Date.now().toString(36)}${dividerCounter.toString(36)}`
}

export const useChatLayoutStore = create<ChatLayoutState>((set, get) => {
  const save = (): void => {
    const { gatewayKey, entries, archived, accents, sidebarCollapsed } = get()

    if (gatewayKey) {
      persist(gatewayKey, {
        entries,
        archived: Object.keys(archived),
        accents,
        // Omitted while nobody has chosen, so that "never chosen" survives a
        // round trip as the absence it is rather than as a `false` the width
        // bands would then never get to answer for.
        ...(sidebarCollapsed === undefined ? {} : { sidebarCollapsed })
      })
    }
  }

  const write = (entries: LayoutEntry[]): void => {
    set({ entries })
    save()
  }

  return {
    ...INITIAL,

    async load(gatewayKey) {
      const all = await keyValueStore.getJson<LayoutsOnDisk>(CHAT_LAYOUT_KEY)
      const stored = asLayout(all?.[gatewayKey])
      const archived: Record<string, true> = {}

      for (const name of stored.archived) {
        archived[name] = true
      }

      set({
        gatewayKey,
        entries: stored.entries,
        archived,
        accents: stored.accents,
        sidebarCollapsed: stored.sidebarCollapsed,
        loaded: true
      })
    },

    /**
     * Fold the live roster into the arrangement.
     *
     * New bots land at the end of the unsectioned top group — the end of the
     * list would bury them under sections they were never put in, and the top
     * would push them in front of the chat the owner is reading. Bots that no
     * longer exist are dropped. Nothing else moves.
     */
    reconcile(botNames) {
      const live = new Set(botNames)
      const { entries } = get()
      const placed = new Set<string>()
      const kept: LayoutEntry[] = []

      for (const entry of entries) {
        if (entry.kind === 'divider') {
          kept.push(entry)
          continue
        }

        if (live.has(entry.name)) {
          placed.add(entry.name)
          kept.push(entry)
        }
      }

      const added = botNames.filter(name => !placed.has(name)).map(name => ({ kind: 'chat' as const, name }))

      if (!added.length && kept.length === entries.length) {
        return
      }

      const firstDivider = kept.findIndex(entry => entry.kind === 'divider')
      const at = firstDivider === -1 ? kept.length : firstDivider

      write([...kept.slice(0, at), ...added, ...kept.slice(at)])
    },

    /**
     * Move one chat up or down by `offset` positions.
     *
     * Positions, not rows of the same kind: stepping past a divider is how a bot
     * changes section, and it is the same gesture as stepping past another bot.
     * That is the whole reason dividers and chats share one array.
     */
    moveBy(botName, offset) {
      const entries = [...get().entries]
      const from = entries.findIndex(entry => entry.kind === 'chat' && entry.name === botName)

      if (from === -1 || offset === 0) {
        return
      }

      const to = Math.max(0, Math.min(entries.length - 1, from + offset))

      if (to === from) {
        return
      }

      const [moved] = entries.splice(from, 1)

      if (moved) {
        entries.splice(to, 0, moved)
        write(entries)
      }
    },

    /** Put one chat at the end of a section; `null` is the unsectioned top group. */
    moveToSection(botName, dividerId) {
      const entries = get().entries.filter(entry => !(entry.kind === 'chat' && entry.name === botName))

      if (entries.length === get().entries.length) {
        return
      }

      const start = dividerId === null ? 0 : entries.findIndex(e => e.kind === 'divider' && e.id === dividerId) + 1

      if (dividerId !== null && start === 0) {
        return
      }

      let end = start

      while (end < entries.length && entries[end]?.kind !== 'divider') {
        end += 1
      }

      entries.splice(end, 0, { kind: 'chat', name: botName })
      write(entries)
    },

    /**
     * Put one chat immediately before position `index` of the current entry list.
     *
     * The hold-and-drag reorder commits through here rather than through a run of
     * `moveBy` calls: a drag knows where the row ended up, and expressing that as
     * N single steps means N writes to disk and N chances for the list to
     * re-render mid-gesture.
     *
     * `index` is read against the list AS IT IS, including the dragged row. That
     * is the number the caller can actually compute — a drop line sits between two
     * rows it can see — so the shift that removing the row causes is corrected
     * here rather than at every call site.
     */
    moveToIndex(botName, index) {
      const entries = [...get().entries]
      const from = entries.findIndex(entry => entry.kind === 'chat' && entry.name === botName)

      if (from === -1) {
        return
      }

      const target = Math.max(0, Math.min(entries.length, index))

      // Dropping a row immediately before or immediately after itself is the same
      // arrangement, and writing it would churn the disk for nothing.
      if (target === from || target === from + 1) {
        return
      }

      const [moved] = entries.splice(from, 1)

      if (!moved) {
        return
      }

      entries.splice(target > from ? target - 1 : target, 0, moved)
      write(entries)
    },

    addDivider(name) {
      const id = newDividerId()

      write([...get().entries, { kind: 'divider', id, name }])

      return id
    },

    /**
     * A new section break directly above one chat.
     *
     * The chat itself does not move, which is the point: "Add divider above" on the
     * row you are looking at means that row becomes the first one under a new
     * heading. Returns null for a bot that is not in the arrangement rather than
     * appending a heading to the end, which would be a divider nowhere near the
     * row the reader right-clicked.
     */
    addDividerAbove(botName, name) {
      const entries = [...get().entries]
      const at = entries.findIndex(entry => entry.kind === 'chat' && entry.name === botName)

      if (at === -1) {
        return null
      }

      const id = newDividerId()

      entries.splice(at, 0, { kind: 'divider', id, name })
      write(entries)

      return id
    },

    renameDivider(id, name) {
      write(get().entries.map(entry => (entry.kind === 'divider' && entry.id === id ? { ...entry, name } : entry)))
    },

    /**
     * Remove a divider, not the bots under it.
     *
     * Dropping the heading leaves its rows exactly where they are, which folds
     * them into the section above — the same thing that would happen if the
     * owner dragged the heading away, and the only reading that never loses a
     * chat.
     */
    removeDivider(id) {
      write(get().entries.filter(entry => !(entry.kind === 'divider' && entry.id === id)))
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

    setSidebarCollapsed(collapsed) {
      set({ sidebarCollapsed: collapsed })
      save()
    },

    applyRemote(patch) {
      const archived: Record<string, true> = {}

      for (const name of patch.archived ?? []) {
        archived[name] = true
      }

      set({
        ...(patch.entries ? { entries: patch.entries } : {}),
        ...(patch.archived ? { archived } : {}),
        ...(patch.accents ? { accents: patch.accents } : {})
      })
      save()
    },

    reset() {
      set(INITIAL)
    }
  }
})

/**
 * The list as the sidebar renders it: dividers with their rows, the unsectioned
 * top group first, and the archived bots pulled out into their own collection.
 *
 * Pure, and derived on every read rather than stored: a second copy of the order
 * is a second thing that can be stale.
 */
export type LayoutSection = { divider: { id: string; name: string } | null; bots: string[] }

export function sectionsOf(entries: readonly LayoutEntry[], archived: Record<string, true>): LayoutSection[] {
  const sections: LayoutSection[] = [{ divider: null, bots: [] }]

  for (const entry of entries) {
    if (entry.kind === 'divider') {
      sections.push({ divider: { id: entry.id, name: entry.name }, bots: [] })
      continue
    }

    if (!archived[entry.name]) {
      sections[sections.length - 1]?.bots.push(entry.name)
    }
  }

  // An empty top group is not a section; a named one stays even when empty, so
  // there is something to move a row back into.
  return sections.filter(section => section.divider !== null || section.bots.length > 0)
}

/** Archived bots, in the order they sit in the arrangement. */
export function archivedOf(entries: readonly LayoutEntry[], archived: Record<string, true>): string[] {
  return entries
    .filter(entry => entry.kind === 'chat' && archived[entry.name])
    .map(entry => (entry as { name: string }).name)
}

/** Every divider, for the "move to section" menu. */
export function dividersOf(entries: readonly LayoutEntry[]): { id: string; name: string }[] {
  return entries
    .filter((entry): entry is Extract<LayoutEntry, { kind: 'divider' }> => entry.kind === 'divider')
    .map(entry => ({ id: entry.id, name: entry.name }))
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
