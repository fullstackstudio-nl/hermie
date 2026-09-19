import { useCallback, useState } from 'react'
import { Pressable, useWindowDimensions, View } from 'react-native'

import { ActivityScreen } from '../features/activity'
import { BotsScreen } from '../features/bots'
import { ChatScreen, type OpenChatOptions } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { strings } from '../i18n/strings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { REGULAR_LAYOUT_MIN_WIDTH, SIDEBAR_WIDTH } from '../ui/tokens'

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
 *
 * A macOS window can be dragged narrower than two panes fit. When it is, the
 * shell shows ONE pane at a time with a back affordance rather than squeezing a
 * 320pt sidebar against a 200pt chat: below that width there is no second pane
 * worth having, and a chat you cannot read is worse than a list you have to
 * tap through.
 */
export function RegularShell() {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const [detail, setDetail] = useState<DetailKey>('chat')
  const [selectedBot, setSelectedBot] = useState<string | undefined>(undefined)
  const [focusItemId, setFocusItemId] = useState<string | undefined>(undefined)

  // Two panes need the sidebar plus a detail wide enough to read a chat in.
  const narrow = width > 0 && width < REGULAR_LAYOUT_MIN_WIDTH
  const [showSidebar, setShowSidebar] = useState(true)

  const openBot = useCallback(
    (name: string, options?: OpenChatOptions) => {
      setSelectedBot(name)
      // A new focus target every time, even for the same item: the chat screen
      // only scrolls when the id it is handed changes, and following the same
      // DM twice should work twice.
      setFocusItemId(options?.focusItemId)
      setDetail('chat')
      setShowSidebar(false)
    },
    [setDetail]
  )

  const sidebarVisible = !narrow || showSidebar

  return (
    <View style={{ backgroundColor: theme.colors.bg, flex: 1, flexDirection: 'row' }}>
      {sidebarVisible ? (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRightColor: theme.colors.border,
            borderRightWidth: narrow ? 0 : 1,
            paddingTop: theme.space.xxl,
            width: narrow ? '100%' : SIDEBAR_WIDTH
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
            {FOOTER_SECTIONS.map(section => {
              const selected = detail === section.key

              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={section.key}
                  onPress={() => {
                    setDetail(section.key)
                    setShowSidebar(false)
                  }}
                  style={{
                    alignItems: 'center',
                    // The selected row keeps its highlight when the pointer
                    // leaves it: on a desktop the sidebar is a persistent index,
                    // and a selection that only shows while pressed is not one.
                    backgroundColor: selected ? theme.colors.surfaceRaised : 'transparent',
                    borderRadius: theme.radii.md,
                    flexDirection: 'row',
                    gap: theme.space.md,
                    paddingHorizontal: theme.space.md,
                    paddingVertical: theme.space.sm
                  }}
                  testID={`sidebar-${section.key}`}
                >
                  <Text color={selected ? 'accent' : 'textMuted'}>{section.glyph}</Text>
                  <Text color={selected ? 'text' : 'textMuted'} variant="callout">
                    {section.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      ) : null}

      {!narrow || !sidebarVisible ? (
        <View style={{ flex: 1 }}>
          {narrow ? <BackToList onPress={() => setShowSidebar(true)} /> : null}

          {detail === 'chat' ? <ChatScreen bot={selectedBot} focusItemId={focusItemId} onOpenBot={openBot} /> : null}
          {detail === 'activity' ? <ActivityScreen onOpenBot={openBot} /> : null}
          {detail === 'cron' ? <CronScreen /> : null}
          {detail === 'settings' ? <SettingsScreen /> : null}
        </View>
      ) : null}
    </View>
  )
}

/** The one-pane fallback's way back to the list, for a window dragged narrow. */
function BackToList({ onPress }: { onPress: () => void }) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: theme.colors.surface,
        opacity: pressed ? 0.6 : 1,
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.xl
      })}
      testID="regular-back-to-list"
    >
      <Text color="accent" variant="callout">
        {`‹ ${strings.bots.title}`}
      </Text>
    </Pressable>
  )
}
