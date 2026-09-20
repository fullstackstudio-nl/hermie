/**
 * One gallery section, as the whole app.
 *
 * `--hermieOpen gallery:<id>` lands here, BEFORE the gateway phase is decided —
 * the component kit takes no gateway and no onboarding, so a screenshot of a
 * sheet should not first require a configured connection and a copied keychain.
 * That is most of the value: it makes every component photographable on a clean
 * simulator with one command.
 *
 * The framing is the compact shell's: the wallpaper, and one full-bleed glass
 * panel over it. Full-bleed rather than floating even on a wide window, because
 * the panel is not what is under inspection here and the extra 28pt of width is.
 *
 * `gallery:chat` is the exception, and it is the one that needed fixing. A whole
 * chat screen IS its layout, and on a wide window the real layout is two floating
 * panels with the chat in the right-hand one (`RegularShell`) — so photographed
 * full-bleed it was a screenshot of a phone chat stretched to 1376pt, which is a
 * shape the app never shows anybody. On a wide window it now gets the real shell:
 * the same gaps, the same sidebar width, the same panels.
 *
 * The sidebar there is the REAL `BotsScreen`, over a seeded roster. A fixture
 * copy of the list would be a second chat list to keep in step with the first,
 * and the point of the exercise is that the screenshot shows what the app shows.
 *
 * The panel owns the safe-area inset. `Screen` deliberately does not add one
 * inside a `GlassSurface` (docs/platform-notes.md, 2026-09-20: it was painting
 * the wallpaper over the panel and insetting twice), and in the real app the
 * inset comes from the navigator above or from `RegularShell`'s window padding.
 * Here there is neither, so without this a section's own header sits under the
 * clock — which is what the first cron-detail screenshot showed.
 */
import { useEffect } from 'react'
import { useWindowDimensions, View } from 'react-native'

import { BotsScreen } from '../features/bots'
import { GalleryScreen, GALLERY_CHAT_SECTION } from '../features/settings/GalleryScreen'
import { useSafeAreaInsets } from '../platform/safe-area'
import { useBotsStore, type Bot } from '../store/bots'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { REGULAR_LAYOUT_MIN_WIDTH, SIDEBAR_WIDTH, WINDOW_GAP } from '../ui/tokens'

/**
 * The roster the wide chat frame's sidebar shows.
 *
 * The fake gateway's two bots plus the two the chat fixtures mention, so the
 * list has enough rows to read as a list and every name in the transcript
 * resolves to somebody. Fixture data only — the same rule the committed
 * screenshots follow (CONTRIBUTING.md).
 */
const FIXTURE_ROSTER: Bot[] = [
  {
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Digs through sources and reports back',
    model: 'example-model-local',
    provider: 'example',
    isDefault: true,
    hasAvatar: false,
    canonical: {
      id: 'session-researcher',
      resolvedId: 'session-researcher',
      preview: 'Latency for the two re-runs, if you want it.',
      lastActive: Math.floor(Date.now() / 1000) - 120,
      messageCount: 24
    },
    uiMetaRevision: 0
  },
  {
    name: 'writer',
    displayName: 'Writer',
    description: 'Turns notes into prose',
    model: 'example-model-local',
    provider: 'example',
    isDefault: false,
    hasAvatar: false,
    canonical: {
      id: 'session-writer',
      resolvedId: 'session-writer',
      preview: 'Draft is ready for your read-through.',
      lastActive: Math.floor(Date.now() / 1000) - 2_400,
      messageCount: 11
    },
    uiMetaRevision: 0
  },
  {
    name: 'bookkeeper',
    displayName: 'Bookkeeper',
    description: 'Reconciles the ledger',
    model: 'example-model-local',
    provider: 'example',
    isDefault: false,
    hasAvatar: false,
    canonical: {
      id: 'session-bookkeeper',
      resolvedId: 'session-bookkeeper',
      preview: 'Approval needed before I move three invoices.',
      lastActive: Math.floor(Date.now() / 1000) - 90_000,
      messageCount: 6
    },
    uiMetaRevision: 0
  },
  {
    name: 'postman',
    displayName: 'Postman',
    description: 'Delivers between the others',
    model: 'example-model-local',
    provider: 'example',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0
  }
]

export function DevGallery({ section }: { section: string }) {
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()

  // Only the chat demo is about its layout, and only a wide window has a second
  // layout to be wrong about.
  const wideChat = section === GALLERY_CHAT_SECTION && width >= REGULAR_LAYOUT_MIN_WIDTH

  useEffect(() => {
    if (wideChat && useBotsStore.getState().bots.length === 0) {
      useBotsStore.getState().setBots(FIXTURE_ROSTER, { fromCache: true })
    }
  }, [wideChat])

  if (wideChat) {
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
            <BotsScreen selectedBot="researcher" variant="sidebar" />
          </GlassSurface>

          <View style={{ flex: 1, minWidth: 0 }} testID="shell-content">
            <GlassSurface contentStyle={{ flex: 1 }} style={{ flex: 1 }} variant="panel">
              <GalleryScreen section={section} />
            </GlassSurface>
          </View>
        </View>
      </Wallpaper>
    )
  }

  return (
    <Wallpaper style={{ flex: 1 }} testID="wallpaper">
      <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
        <View style={{ flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
          <GalleryScreen section={section} />
        </View>
      </GlassSurface>
    </Wallpaper>
  )
}
