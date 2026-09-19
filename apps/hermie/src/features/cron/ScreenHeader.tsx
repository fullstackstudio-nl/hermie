/**
 * The header a routine sub-screen draws for itself.
 *
 * The cron feature is one screen with early-return sub-screens rather than a
 * navigator (see `CronScreen`), so nothing above it supplies a back button.
 * This is that button, shaped like the design board's `‹ Hermie` eyebrow.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'

export interface ScreenHeaderProps {
  back: string
  onBack: () => void
  title: string
  subtitle?: string
  /** Rendered on the trailing side, e.g. the list's "New routine" action. */
  action?: React.ReactNode
}

export function ScreenHeader({ back, onBack, title, subtitle, action }: ScreenHeaderProps) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.xxs, paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={back}
        onPress={onBack}
        style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
      >
        <Text color="accent" variant="preview">{`‹ ${back}`}</Text>
      </Pressable>

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
        <View style={{ flex: 1, gap: theme.space.xxs }}>
          <Text variant="title">{title}</Text>
          {subtitle ? (
            <Text color="textMuted" variant="preview">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
    </View>
  )
}
