/**
 * Per-item expanded state, held ABOVE the list.
 *
 * Every disclosure in the transcript — a folded long reply, a tool card, a cron
 * card, a bot-to-bot exchange, a roll-up — used to keep its own `useState`. In a
 * virtualised list that is a bug with a delay on it: scroll a expanded card out of
 * the window, `FlatList` unmounts the row, and scrolling back re-mounts it
 * collapsed. The reader did not collapse anything.
 *
 * So the state lives in one set, keyed by item id, owned by `TranscriptList` and
 * read through this context. It also means the list itself can decide that
 * expanding something must not move the viewport, which a row has no way to
 * arrange from the inside.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface ExpandedApi {
  isExpanded: (id: string) => boolean
  toggle: (id: string) => void
  /** Used by a card that opens itself once and then follows the reader. */
  setExpanded: (id: string, expanded: boolean) => void
}

/**
 * The fallback for a component rendered outside a list — the gallery, a test, a
 * sheet. It keeps nothing, which is honest: there is no list to be virtualised
 * out of.
 */
const NOOP: ExpandedApi = {
  isExpanded: () => false,
  setExpanded: () => {},
  toggle: () => {}
}

const ExpandedContext = createContext<ExpandedApi>(NOOP)

export function ExpandedProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = useCallback((id: string) => {
    setIds(current => {
      const next = new Set(current)

      if (!next.delete(id)) {
        next.add(id)
      }

      return next
    })
  }, [])

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setIds(current => {
      if (current.has(id) === expanded) {
        return current
      }

      const next = new Set(current)

      if (expanded) {
        next.add(id)
      } else {
        next.delete(id)
      }

      return next
    })
  }, [])

  const api = useMemo<ExpandedApi>(
    () => ({ isExpanded: id => ids.has(id), setExpanded, toggle }),
    [ids, setExpanded, toggle]
  )

  return <ExpandedContext.Provider value={api}>{children}</ExpandedContext.Provider>
}

/**
 * One item's disclosure state.
 *
 * Returns a tuple rather than the whole API so a row cannot accidentally read or
 * write another row's state, which is how the memo key stays honest.
 */
export function useExpanded(id: string): [boolean, () => void] {
  const api = useContext(ExpandedContext)

  return [api.isExpanded(id), useCallback(() => api.toggle(id), [api, id])]
}

/** For a component that needs the whole API — a group card toggling its children. */
export function useExpandedApi(): ExpandedApi {
  return useContext(ExpandedContext)
}
