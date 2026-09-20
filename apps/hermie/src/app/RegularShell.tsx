import { useCallback, useState } from 'react'
import { View } from 'react-native'

import type { DevInitialView } from '../dev'
import { ActivityScreen } from '../features/activity'
import { BotsScreen, type BotsSection } from '../features/bots'
import { ChatScreen, type OpenChatOptions } from '../features/chats'
import { CronScreen } from '../features/cron'
import { SettingsScreen } from '../features/settings'
import { strings } from '../i18n/strings'
import { useSafeAreaInsets } from '../platform/safe-area'
import { useChatLayoutStore } from '../store/chat-layout'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { useShortcut } from '../ui/useShortcut'
import { SIDEBAR_RAIL_WIDTH, WINDOW_GAP } from '../ui/tokens'
import { OverlayPanel } from './OverlayPanel'
import { SidebarOverlay } from './SidebarOverlay'
import { useSidebarState, useSidebarWidth } from './useLayoutMode'

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
 *
 * ## The sidebar can be hidden, and what that means depends on the width
 *
 * Hiding it leaves the rail (`SidebarRail`) and gives the chat column everything
 * else, which is the lever the 2026-09-20 portrait pass asked for: at 834pt the
 * bubble cap lands around 335pt, about 38 characters, and there was nothing left
 * to take from except the list. Three rules, and the last one is the owner's:
 *
 *  - **Below 900pt the list comes BACK as an overlay** (`SidebarOverlay`), over
 *    the chat, and goes away again as soon as a chat is picked. Re-expanding in
 *    place there would squeeze the chat column, which is the thing the collapse
 *    was for. At 900 and above there is room for both, so Show simply shows.
 *  - **The default follows the width, the choice follows the owner.** With no
 *    explicit Hide or Show on record the window decides; once there is one it wins
 *    at every width, and it is stored per gateway with the rest of the arrangement
 *    (ADR-0012). `resolveSidebarCollapsed` is the whole rule.
 *  - **Nothing flips itself while the reader sits still.** That falls out of the
 *    rule above being a comparison against one number rather than a state machine:
 *    one window width cannot produce two answers.
 *
 * Three ways in, one function: the header's round button, ⌘⇧S / ⌃⇧S, and the Mac
 * menu bar's Hide/Show Sidebar — the last two arrive as the same `toggleSidebar`
 * action (`platform/desktop-shortcuts`), so there is nothing to keep in step.
 */
export function RegularShell({ initial }: { initial?: DevInitialView } = {}) {
  const insets = useSafeAreaInsets()
  const sidebar = useSidebarWidth()
  const { collapsed, overlays } = useSidebarState()
  const setSidebarCollapsed = useChatLayoutStore(state => state.setSidebarCollapsed)
  const [section, setSection] = useState<BotsSection | null>(initial?.section ?? null)
  const [selectedBot, setSelectedBot] = useState<string | undefined>(initial?.bot)
  const [focusItemId, setFocusItemId] = useState<string | undefined>(undefined)
  const [cronJobId, setCronJobId] = useState<string | undefined>(undefined)
  // Showing the list temporarily is a thing this WINDOW is doing, not a thing the
  // owner has decided about their list, so it never reaches the store.
  const [listOverlay, setListOverlay] = useState(false)

  const openBot = useCallback((name: string, options?: OpenChatOptions) => {
    setSelectedBot(name)
    // A new focus target every time, even for the same item: the chat screen
    // only scrolls when the id it is handed changes, and following the same DM
    // twice should work twice.
    setFocusItemId(options?.focusItemId)
    setSection(null)
    // Picking a chat was the errand the temporary list was opened for.
    setListOverlay(false)
  }, [])

  // A cron card in the transcript opens the crons panel ON that cron. Opening
  // the panel any other way clears the target, so the next visit lands on the
  // list rather than on whichever cron somebody followed a card to last week.
  const openCron = useCallback((jobId: string) => {
    setCronJobId(jobId)
    setSection('cron')
  }, [])

  const openSection = useCallback((next: BotsSection) => {
    setCronJobId(undefined)
    setSection(next)
    setListOverlay(false)
  }, [])

  /**
   * One toggle for all three ways in.
   *
   * The order of the branches is the behaviour. A temporary list closes first,
   * because that is the level the reader is looking at; then a collapsed sidebar on
   * a narrow window opens as an overlay rather than pushing the chat aside; then
   * anything else is the plain in-place Hide or Show, which is what gets stored.
   */
  const toggleSidebar = useCallback(() => {
    if (listOverlay) {
      setListOverlay(false)

      return
    }

    if (collapsed && overlays) {
      setListOverlay(true)

      return
    }

    setSidebarCollapsed(!collapsed)
  }, [collapsed, listOverlay, overlays, setSidebarCollapsed])

  /** Asked for from the rail, which only ever means "show it", never "hide it". */
  const showList = useCallback(() => {
    if (overlays) {
      setListOverlay(true)

      return
    }

    setSidebarCollapsed(false)
  }, [overlays, setSidebarCollapsed])

  // ⌘, opens Settings, on a Mac from the keyboard and from the menu bar. ⌘W and
  // Escape close it again, through the Escape stack `OverlayPanel` registers on.
  useShortcut('settings', () => openSection('settings'))
  // ⌘⇧S / ⌃⇧S, and the Mac menu bar's Hide/Show Sidebar, which arrives as the same
  // action. Registered on the shell rather than on the sidebar because the sidebar
  // is the thing that goes away — a shortcut that unregisters when its target is
  // hidden is a shortcut that can only ever hide.
  useShortcut('toggleSidebar', toggleSidebar)

  /** The list, in whichever of its two containers is on screen. */
  const list = (
    <BotsScreen
      currentTab={section ?? 'chats'}
      onOpenBot={bot => openBot(bot.name)}
      onOpenSection={openSection}
      selectedBot={section === null ? selectedBot : undefined}
      variant="sidebar"
    />
  )

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
        {/*
          The rail and the sidebar are the same panel at two widths, and the same
          `BotsScreen` in two variants — see `SidebarRail` for why the rail is a
          variant rather than a component of its own. The window gap is unchanged in
          both, so the content panel gains exactly the width the list gave up.
        */}
        <GlassSurface
          contentStyle={{ flex: 1 }}
          style={{ width: collapsed ? SIDEBAR_RAIL_WIDTH : sidebar }}
          testID="shell-sidebar"
          variant="panel"
        >
          {collapsed ? (
            /*
              `onOpenBot` and `selectedBot` are handed to the rail as well, and they
              are not decoration: ⌘1…9 and ⌘↑/↓ are registered by this component in
              either variant, and without somewhere to send the chat they would fire
              into nothing. A shortcut that reports success and does nothing is the
              worst of the three possible behaviours.
            */
            <BotsScreen
              currentTab={section ?? 'chats'}
              onOpenBot={bot => openBot(bot.name)}
              onOpenSection={openSection}
              onShowList={showList}
              selectedBot={section === null ? selectedBot : undefined}
              variant="rail"
            />
          ) : (
            list
          )}
        </GlassSurface>

        <View style={{ flex: 1, minWidth: 0 }} testID="shell-content">
          <GlassSurface contentStyle={{ flex: 1 }} style={{ flex: 1 }} variant="panel">
            {/*
              A dead session is not a chat problem and must not read as one, so
              it takes the whole column rather than sitting under a chat error.
              `ChatScreen` does that itself now, on both layouts, so there is no
              second copy of the rule here to disagree with it.
            */}
            {/*
              The chat column's sidebar control exists only while the list is
              SHOWING, and that is a decision rather than an oversight.

              Measured on an iPad Pro 11" in portrait: with a button in the header
              as well, a collapsed window drew two identical sidebar icons about
              90pt apart — the rail's and the header's — doing the same thing. One
              control at a time is the rule every app with a rail follows, and it
              also settles the label: the header's is always Hide, the rail's is
              always Show, and neither has to describe a state the other is in.
            */}
            <ChatScreen
              bot={selectedBot}
              focusItemId={focusItemId}
              onOpenBot={openBot}
              onOpenCron={openCron}
              onToggleSidebar={collapsed ? undefined : toggleSidebar}
            />
          </GlassSurface>

          <OverlayPanel onClose={() => setSection(null)} title={titleFor(section)} visible={section !== null}>
            {section === 'activity' ? <ActivityScreen onOpenBot={openBot} /> : null}
            {section === 'cron' ? <CronScreen {...(cronJobId ? { initialJobId: cronJobId } : {})} /> : null}
            {section === 'settings' ? (
              <SettingsScreen {...(initial?.page ? { initialPage: initial.page } : {})} />
            ) : null}
          </OverlayPanel>
        </View>

        {/*
          Over BOTH columns rather than inside the content one, because it stands in
          for the sidebar and therefore starts at the window's own leading edge. It
          is the last child so that Escape reaches it before the destination panel
          when both are up — the stack delivers to whatever registered last.
        */}
        <SidebarOverlay onClose={() => setListOverlay(false)} visible={listOverlay} width={sidebar}>
          {listOverlay ? list : null}
        </SidebarOverlay>
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
