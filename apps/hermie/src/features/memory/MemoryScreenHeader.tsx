/**
 * The header the memory pages draw for themselves.
 *
 * The same shape as the Crons feature's, and a copy rather than an import for
 * the reason that feature's barrel implies: `ScreenHeader` is not exported from
 * it, because it is a detail of how that feature does its own navigation rather
 * than a primitive the app agreed on. Reaching across a feature boundary for a
 * component neither feature owns is how two features end up unable to change
 * their own back button.
 *
 * The chevron is drawn by `Icon` rather than typed, so it matches every other
 * one in the app on every platform.
 */
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'

import { Icon, ICON_SIZE } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'

export interface MemoryScreenHeaderProps {
  back: string
  onBack: () => void
  title: string
  subtitle?: string
  /** The trailing side — the Entries / Graph tabs, once there are two. */
  action?: ReactNode
  testID?: string
}

export function MemoryScreenHeader({ back, onBack, title, subtitle, action, testID }: MemoryScreenHeaderProps) {
  const theme = useTheme()

  return (
    <View
      style={{ gap: theme.space.xxs, paddingBottom: theme.space.sm, paddingHorizontal: theme.space.lg }}
      testID={testID}
    >
      <Pressable
        accessibilityLabel={back}
        accessibilityRole="button"
        onPress={onBack}
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: 2,
          justifyContent: 'center',
          minHeight: CONTROL_MIN_HEIGHT
        }}
        testID={testID ? `${testID}-back` : undefined}
      >
        <Icon color={theme.colors.accentText} name="chevronLeft" size={ICON_SIZE.inline} />
        <Text color="accentText" variant="preview">
          {back}
        </Text>
      </Pressable>

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
        <View style={{ flex: 1, gap: theme.space.xxs }}>
          <Text accessibilityRole="header" aria-level={1} variant="title">
            {title}
          </Text>
          {subtitle ? (
            <Text color="textMuted" numberOfLines={1} variant="preview">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
    </View>
  )
}
