import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { ActivityScreen } from '../features/activity'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { SIDEBAR_WIDTH } from '../ui/tokens'

type DetailKey = 'chat' | 'activity' | 'cron' | 'settings'

const SECTIONS: { key: DetailKey; label: string }[] = [
  { key: 'chat', label: 'Bots' },
  { key: 'activity', label: 'Activity' },
  { key: 'cron', label: 'Routines' },
  { key: 'settings', label: 'Settings' }
]

// The regular shell deliberately avoids a navigator: on macOS and iPad the
// sidebar and the detail pane are both always mounted, so a stack would only
// get in the way. Real bot rows replace the section list once the gateway
// client lands.
export function RegularShell() {
  const theme = useTheme()
  const [selected, setSelected] = useState<DetailKey>('chat')

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.bg }}>
      <View
        style={{
          width: SIDEBAR_WIDTH,
          backgroundColor: theme.colors.surface,
          borderRightWidth: 1,
          borderRightColor: theme.colors.border,
          paddingTop: theme.space.xxl,
          paddingHorizontal: theme.space.md
        }}
      >
        <Text variant="caption" color="textMuted" style={{ marginBottom: theme.space.sm }}>
          HERMIE
        </Text>
        {SECTIONS.map(section => (
          <Pressable
            key={section.key}
            accessibilityRole="button"
            onPress={() => setSelected(section.key)}
            style={{
              paddingVertical: theme.space.sm,
              paddingHorizontal: theme.space.md,
              borderRadius: theme.radii.md,
              backgroundColor: selected === section.key ? theme.colors.surfaceRaised : 'transparent'
            }}
          >
            <Text variant="callout" color={selected === section.key ? 'text' : 'textMuted'}>
              {section.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={{ flex: 1 }}>
        {selected === 'chat' ? <ChatScreen /> : null}
        {selected === 'activity' ? <ActivityScreen /> : null}
        {selected === 'cron' ? <CronScreen /> : null}
        {selected === 'settings' ? <SettingsScreen /> : null}
      </View>
    </View>
  )
}
