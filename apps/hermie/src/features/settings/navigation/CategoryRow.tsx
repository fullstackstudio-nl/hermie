/**
 * One category in the Settings list: its mark, its name, one line of where it
 * stands, and the chevron that says it opens a page.
 *
 * `selected` is the split layout's highlight — the category whose page is
 * showing in the column beside the list — and it is drawn with the same tint a
 * pressed row gets, so "this one is open" and "you are pressing this one" read
 * as the same idea.
 */
import { Pressable, View } from 'react-native'

import { Icon, ICON_SIZE, type IconName } from '../../../ui/Icon'
import { Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../../ui/tokens'

export interface CategoryRowProps {
  icon: IconName
  title: string
  summary: string
  onPress: () => void
  selected?: boolean
  testID?: string
}

export function CategoryRow({ icon, title, summary, onPress, selected = false, testID }: CategoryRowProps) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityHint={summary || undefined}
      accessibilityLabel={title}
      accessibilityRole="button"
      aria-selected={selected}
      onPress={onPress}
      testID={testID}
    >
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: pressed || selected ? theme.elevation.e2 : 'transparent',
            flexDirection: 'row',
            gap: theme.space.md,
            minHeight: CONTROL_MIN_HEIGHT,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.sm
          }}
        >
          <Icon color={theme.colors.accentText} name={icon} size={ICON_SIZE.control} slot={ICON_SIZE.tabSlot} />
          <View style={{ flex: 1, gap: theme.space.xxs }}>
            <Text numberOfLines={1} variant="body">
              {title}
            </Text>
            {summary ? (
              <Text
                color="textMuted"
                numberOfLines={1}
                testID={testID ? `${testID}-summary` : undefined}
                variant="meta"
              >
                {summary}
              </Text>
            ) : null}
          </View>
          <Icon color={theme.colors.textMuted} name="chevronRight" size={ICON_SIZE.inline} />
        </View>
      )}
    </Pressable>
  )
}
