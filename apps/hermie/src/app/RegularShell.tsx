import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { ActivityScreen } from '../features/activity'
import { BotsScreen } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { strings } from '../i18n/strings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { SIDEBAR_WIDTH } from '../ui/tokens'

type DetailKey = 'chat' | 'activity' | 'cron' | 'settings'

const FOOTER_SECTIONS: { key: Exclude<DetailKey, 'chat'>; label: string; glyph: string }[] = [
  { key: 'activity', label: strings.tabs.activity, glyph: '⇄' },
  { key: 'cron', label: strings.tabs.routines, glyph: '◷' },
  { key: 'settings', label: strings.tabs.settings, glyph: '⚙' }
]

/**
 * Sidebar plus detail, for iPad and macOS.
 *
 * Deliberately no navigator: both panes are always mounted, so a stack would
 * only get in the way — and on macOS `react-native-screens` has no slice to
 * bundle anyway. The chat list IS the sidebar, in its denser variant; Activity,
 * Routines and Settings sit under it as a footer and open as detail panes.
 */
export function RegularShell() {
  const theme = useTheme()
  const [detail, setDetail] = useState<DetailKey>('chat')
  const [selectedBot, setSelectedBot] = useState<string | undefined>(undefined)

  const openBot = (name: string) => {
    setSelectedBot(name)
    setDetail('chat')
  }

  return (
    <View style={{ backgroundColor: theme.colors.bg, flex: 1, flexDirection: 'row' }}>
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderRightColor: theme.colors.border,
          borderRightWidth: 1,
          paddingTop: theme.space.xxl,
          width: SIDEBAR_WIDTH
        }}
      >
        <View style={{ flex: 1 }}>
          <BotsScreen
            onOpenBot={bot => openBot(bot.name)}
            selectedBot={detail === 'chat' ? selectedBot : undefined}
            variant="sidebar"
          />
        </View>

        <View style={{ borderTopColor: theme.colors.border, borderTopWidth: 1, padding: theme.space.sm }}>
          {FOOTER_SECTIONS.map(section => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: detail === section.key }}
              key={section.key}
              onPress={() => setDetail(section.key)}
              style={{
                alignItems: 'center',
                backgroundColor: detail === section.key ? theme.colors.surfaceRaised : 'transparent',
                borderRadius: theme.radii.md,
                flexDirection: 'row',
                gap: theme.space.md,
                paddingHorizontal: theme.space.md,
                paddingVertical: theme.space.sm
              }}
              testID={`sidebar-${section.key}`}
            >
              <Text color={detail === section.key ? 'accent' : 'textMuted'}>{section.glyph}</Text>
              <Text color={detail === section.key ? 'text' : 'textMuted'} variant="callout">
                {section.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={{ flex: 1 }}>
        {detail === 'chat' ? <ChatScreen bot={selectedBot} onOpenBot={openBot} /> : null}
        {detail === 'activity' ? <ActivityScreen /> : null}
        {detail === 'cron' ? <CronScreen /> : null}
        {detail === 'settings' ? <SettingsScreen /> : null}
      </View>
    </View>
  )
}
