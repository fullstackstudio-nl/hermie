/**
 * The categories, as rows.
 *
 * The same component in both layouts — the stack's `Root` page on a phone, and
 * the 300pt column beside the pages on a wide window — because "master-detail"
 * and "a list that pushes" are the same list with a different destination for a
 * tap. One list, one place a category can be forgotten from.
 */
import { View } from 'react-native'

import { InsetGroup } from '../../../ui/primitives'
import { settingsTitle } from './route-meta'
import type { SettingsCategoryName } from './route-names'
import { settingsCategory, visibleCategoryGroups } from './routes'
import { CategoryRow } from './CategoryRow'

export interface SettingsCategoryListProps {
  onPick: (name: SettingsCategoryName) => void
  /** The category whose page is open beside the list, on the split layout. */
  current?: SettingsCategoryName | null
}

export function SettingsCategoryList({ onPick, current = null }: SettingsCategoryListProps) {
  return (
    <>
      {visibleCategoryGroups().map(group => (
        <InsetGroup key={group.join('-')}>
          {group.map(name => (
            <CategoryListRow current={current} key={name} name={name} onPick={onPick} />
          ))}
        </InsetGroup>
      ))}
    </>
  )
}

/**
 * One row, as its own component for one reason: the summary is a HOOK, and a
 * hook cannot be called in a loop over a list whose length this build decides.
 */
function CategoryListRow({
  name,
  current,
  onPick
}: {
  name: SettingsCategoryName
  current: SettingsCategoryName | null
  onPick: (name: SettingsCategoryName) => void
}) {
  const category = settingsCategory(name)
  const summary = category.useSummary()

  return (
    <View>
      <CategoryRow
        icon={category.icon}
        onPress={() => onPick(name)}
        selected={current === name}
        summary={summary}
        testID={`settings-cat-${name}`}
        title={settingsTitle(name)}
      />
    </View>
  )
}
