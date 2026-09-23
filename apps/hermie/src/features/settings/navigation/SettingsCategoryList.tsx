/**
 * The categories, as rows — and, in the sidebar, the search field and the
 * account row above them.
 *
 * The same component in both layouts — the stack's `Root` page on a phone, and
 * the column beside the pages on a wide window — because "master-detail" and "a
 * list that pushes" are the same list with a different destination for a tap. One
 * list, one place a category can be forgotten from. What differs is the chrome
 * around it, and that is `variant`:
 *
 *  - **`grouped`** (the default, and the phone) — the rows in `InsetGroup` cards,
 *    and nothing above them. No search field and no account row: the phone's
 *    Settings root is one screen deep and a search box on it would be a field
 *    between the reader and a list they can already see all of.
 *  - **`sidebar`** — the reference's own shape. A search field, then the account
 *    row, then the categories as free-standing rows with the open one filled.
 *
 * ## The search is real
 *
 * It reads three things per category: the category's own title, the line of state
 * under it, and the title of every route UNDERNEATH it — so "licence" finds About
 * and "MCP" finds Bots & capabilities, which is where those pages actually live.
 * A row matched through a descendant says which one instead of its summary, so a
 * hit is never unexplained.
 *
 * Picking is unchanged in both shapes: `onPick` takes a CATEGORY, and the split
 * layout resets its stack to that category exactly as it did before. The search
 * narrows the list; it does not learn a second way to navigate.
 */
import { useMemo, useState } from 'react'
import { View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { InsetGroup, SearchField, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { AccountRow } from './AccountRow'
import { CategoryRow, type CategoryRowVariant } from './CategoryRow'
import { settingsDescendants, settingsTitle } from './route-meta'
import type { SettingsCategoryName } from './route-names'
import { settingsCategory, visibleCategories, visibleCategoryGroups } from './routes'

export interface SettingsCategoryListProps {
  onPick: (name: SettingsCategoryName) => void
  /** The category whose page is open beside the list, on the split layout. */
  current?: SettingsCategoryName | null
  variant?: CategoryRowVariant
}

/**
 * Every category's line of state, in one place.
 *
 * Written out one call at a time on purpose: a summary is a HOOK, and a hook
 * cannot be called in a loop whose length this build decides. The `Record` type is
 * what keeps the list complete — a thirteenth category added to
 * `SETTINGS_CATEGORIES` and forgotten here does not compile.
 *
 * All twelve are read even where a category is hidden. That costs a store
 * subscription and buys the thing the search needs: one object, with a stable hook
 * order, whatever this platform decided to show.
 */
function useCategorySummaries(): Record<SettingsCategoryName, string> {
  return {
    Account: settingsCategory('Account').useSummary(),
    Gateways: settingsCategory('Gateways').useSummary(),
    ChatsMessages: settingsCategory('ChatsMessages').useSummary(),
    Notifications: settingsCategory('Notifications').useSummary(),
    Context: settingsCategory('Context').useSummary(),
    Memory: settingsCategory('Memory').useSummary(),
    Appearance: settingsCategory('Appearance').useSummary(),
    Privacy: settingsCategory('Privacy').useSummary(),
    Voice: settingsCategory('Voice').useSummary(),
    Capabilities: settingsCategory('Capabilities').useSummary(),
    Advanced: settingsCategory('Advanced').useSummary(),
    About: settingsCategory('About').useSummary()
  }
}

/** A category's hit for one needle: whether it matched, and what matched it. */
interface Hit {
  matched: boolean
  /** The titles of the pages under this category that the needle found, if any. */
  under: string[]
}

export function matchCategory(name: SettingsCategoryName, summary: string, needle: string): Hit {
  if (!needle) {
    return { matched: true, under: [] }
  }

  const under = settingsDescendants(name)
    .map(route => settingsTitle(route))
    .filter(title => title.toLocaleLowerCase().includes(needle))

  const own = [settingsTitle(name), summary].some(value => value.toLocaleLowerCase().includes(needle))

  return { matched: own || under.length > 0, under }
}

export function SettingsCategoryList({ onPick, current = null, variant = 'grouped' }: SettingsCategoryListProps) {
  const theme = useTheme()
  const summaries = useCategorySummaries()
  const [query, setQuery] = useState('')
  const sidebar = variant === 'sidebar'
  const needle = sidebar ? query.trim().toLocaleLowerCase() : ''

  const hits = useMemo(() => {
    const out = new Map<SettingsCategoryName, Hit>()

    for (const name of visibleCategories()) {
      out.set(name, matchCategory(name, summaries[name], needle))
    }

    return out
    // `summaries` is rebuilt every render by design — the values are what the
    // stores currently say — so the dependency that matters is the needle, and
    // the map is recomputed whenever a summary changes anyway.
  }, [needle, summaries])

  const row = (name: SettingsCategoryName) => {
    const hit = hits.get(name)

    if (!hit?.matched) {
      return null
    }

    return (
      <CategoryRow
        category={name}
        key={name}
        onPress={() => onPick(name)}
        selected={current === name}
        summary={hit.under.length ? hit.under.join(' · ') : summaries[name]}
        testID={`settings-cat-${name}`}
        title={settingsTitle(name)}
        variant={variant}
      />
    )
  }

  if (!sidebar) {
    return (
      <>
        {visibleCategoryGroups().map(group => (
          <InsetGroup key={group.join('-')}>
            {group.map(name => (
              // The wrapper is `InsetGroup`'s hairline seam; the row inside it
              // carries its own key.
              <View key={name}>{row(name)}</View>
            ))}
          </InsetGroup>
        ))}
      </>
    )
  }

  const found = visibleCategories().filter(name => hits.get(name)?.matched)

  return (
    <>
      {/*
        The same pill the chat list searches with, down to the magnifier's slot —
        one component, so a field in Settings and a field in the chat list cannot
        drift apart.
      */}
      <SearchField
        label={strings.settings.search.label}
        onChangeText={setQuery}
        style={{ marginHorizontal: theme.space.sm }}
        testID="settings-search"
        value={query}
      />

      {/*
        The account row, above the categories and outside the search: it is who
        this device IS rather than a setting, and a reader narrowing the list
        down to one word is not looking for it. It opens the Account category —
        a shortcut to a page that is still in the list below, not a second home
        for anything.
      */}
      {needle ? null : <AccountRow onPress={() => onPick('Account')} />}

      {/*
        The groups become gaps rather than cards here. The reference's sidebar has
        no card around its rows at all, and the five groups the phone draws still
        say what they said — they are the spacing between the runs.
      */}
      {found.length ? (
        visibleCategoryGroups()
          .map(group => group.filter(name => hits.get(name)?.matched))
          .filter(group => group.length > 0)
          .map(group => (
            <View key={group.join('-')} style={{ gap: theme.space.xxs }}>
              {group.map(name => row(name))}
            </View>
          ))
      ) : (
        <Text
          color="textMuted"
          style={{ marginHorizontal: theme.space.lg }}
          testID="settings-search-empty"
          variant="preview"
        >
          {strings.settings.search.noMatches}
        </Text>
      )}
    </>
  )
}
