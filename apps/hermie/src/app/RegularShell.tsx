import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { ActivityScreen } from '../features/activity'
import { BotsScreen } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { SIDEBAR_WIDTH } from '../ui/tokens'

type DetailKey = 'chat' | 'activity' | 'cron' | 'settings'

const FOOTER_SECTIONS: { key: Exclude<DetailKey, 'chat'>; label: string }[] = [
  { key: 'activity', label: 'Activity' },
  { key: 'cron', label: 'Routines' },
  { key: 'settings', label: 'Settings' }
]

/**
 * Sidebar plus detail, for iPad and macOS.
 *
 * Deliberately no navigator: both panes are always mounted, so a stack would
 * only get in the way — and on macOS `react-native-screens` has no slice to
 * bundle anyway. The bot list IS the sidebar; Activity, Routines and Settings
 * sit under it as a footer.
 */
export function RegularShell() {
  const theme = useTheme()
  const [detail, setDetail] = useState<DetailKey>('chat')
  const [selectedBot, setSelectedBot] = useState<string | undefined>(undefined)

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.bg }}>
      <View
        style={{
          width: SIDEBAR_WIDTH,
          backgroundColor: theme.colors.surface,
          borderRightWidth: 1,
          borderRightColor: theme.colors.border,
          paddingTop: theme.space.xxl
        }}
      >
        <Text
          variant="caption"
          color="textMuted"
          style={{ marginBottom: theme.space.sm, paddingHorizontal: theme.space.lg }}
        >
          BOTS
        </Text>

        <View style={{ flex: 1 }}>
          <BotsScreen
            selectedBot={detail === 'chat' ? selectedBot : undefined}
            onOpenBot={bot => {
              setSelectedBot(bot.name)
              setDetail('chat')
            }}
          />
        </View>

        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: theme.space.sm }}>
          {FOOTER_SECTIONS.map(section => (
            <Pressable
              key={section.key}
              accessibilityRole="button"
              onPress={() => setDetail(section.key)}
              style={{
                paddingVertical: theme.space.sm,
                paddingHorizontal: theme.space.md,
                borderRadius: theme.radii.md,
                backgroundColor: detail === section.key ? theme.colors.surfaceRaised : 'transparent'
              }}
            >
              <Text variant="callout" color={detail === section.key ? 'text' : 'textMuted'}>
                {section.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={{ flex: 1 }}>
        {detail === 'chat' ? <ChatScreen bot={selectedBot} /> : null}
        {detail === 'activity' ? <ActivityScreen /> : null}
        {detail === 'cron' ? <CronScreen /> : null}
        {detail === 'settings' ? <SettingsScreen /> : null}
      </View>
    </View>
  )
}
