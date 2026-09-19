import { useCallback, useState } from 'react'
import { View } from 'react-native'

import { ActivityScreen } from '../features/activity'
import { BotsScreen, type BotsSection } from '../features/bots'
import { ChatScreen, type OpenChatOptions } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { useGateway } from '../gateway'
import { SignedOutPanel } from '../gateway/SignedOutPanel'
import { strings } from '../i18n/strings'
import { useSafeAreaInsets } from '../platform/safe-area'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { SIDEBAR_WIDTH, WINDOW_GAP } from '../ui/tokens'
import { OverlayPanel } from './OverlayPanel'

/**
 * Two floating glass panels over a wallpaper, for a wide window — an iPad, or a
 * Mac.
 *
 * Deliberately no navigator: both panels are always mounted, so a stack would
 * only get in the way. The chat list IS the sidebar; Activity, Crons and
 * Settings slide in over the chat column from the right (`OverlayPanel`) rather
 * than replacing it, so the list stays where the reader left it.
 *
 * A window narrower than two panels never reaches this component: `useLayoutMode`
 * hands that case to the compact stack instead.
 *
 * **One inset source for both columns.** The padding that clears the system's
 * safe area is applied ONCE, to the row that holds both panels, and neither
 * panel adds any of its own. A Mac reported this as a bug when they disagreed:
 * the strip under the title bar was gone above the chat and still there above
 * the list, because the sidebar carried a hard-coded top padding that the
 * Mac-aware inset never reached. Two columns cannot disagree about a number
 * they do not each own.
 */
export function RegularShell() {
  const insets = useSafeAreaInsets()
  const { status } = useGateway()
  const [section, setSection] = useState<BotsSection | null>(null)
  const [selectedBot, setSelectedBot] = useState<string | undefined>(undefined)
  const [focusItemId, setFocusItemId] = useState<string | undefined>(undefined)

  const openBot = useCallback((name: string, options?: OpenChatOptions) => {
    setSelectedBot(name)
    // A new focus target every time, even for the same item: the chat screen
    // only scrolls when the id it is handed changes, and following the same DM
    // twice should work twice.
    setFocusItemId(options?.focusItemId)
    setSection(null)
  }, [])

  const signedOut = status === 'needs_signin'

  return (
    <Wallpaper style={{ flex: 1 }} testID="wallpaper">
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          gap: WINDOW_GAP,
          paddingBottom: WINDOW_GAP + insets.bottom,
          paddingLeft: WINDOW_GAP + insets.left,
          paddingRight: WINDOW_GAP + insets.right,
          paddingTop: WINDOW_GAP + insets.top
        }}
        testID="shell-window"
      >
        <GlassSurface
          contentStyle={{ flex: 1 }}
          style={{ width: SIDEBAR_WIDTH }}
          testID="shell-sidebar"
          variant="panel"
        >
          <BotsScreen
            currentTab={section ?? 'chats'}
            onOpenBot={bot => openBot(bot.name)}
            onOpenSection={setSection}
            selectedBot={section === null ? selectedBot : undefined}
            variant="sidebar"
          />
        </GlassSurface>

        <View style={{ flex: 1, minWidth: 0 }} testID="shell-content">
          <GlassSurface contentStyle={{ flex: 1 }} style={{ flex: 1 }} variant="panel">
            {/*
              A dead session is not a chat problem and must not read as one, so
              it takes the whole column rather than sitting under a chat error.
            */}
            {signedOut ? (
              <SignedOutPanel />
            ) : (
              <ChatScreen bot={selectedBot} focusItemId={focusItemId} onOpenBot={openBot} />
            )}
          </GlassSurface>

          <OverlayPanel onClose={() => setSection(null)} title={titleFor(section)} visible={section !== null}>
            {section === 'activity' ? <ActivityScreen onOpenBot={openBot} /> : null}
            {section === 'cron' ? <CronScreen /> : null}
            {section === 'settings' ? <SettingsScreen /> : null}
          </OverlayPanel>
        </View>
      </View>
    </Wallpaper>
  )
}

function titleFor(section: BotsSection | null): string {
  switch (section) {
    case 'activity':
      return strings.activity.title
    case 'cron':
      return strings.tabs.routines
    case 'settings':
      return strings.settings.title
    default:
      return ''
  }
}
