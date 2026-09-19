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
 * The panel owns the safe-area inset. `Screen` deliberately does not add one
 * inside a `GlassSurface` (docs/platform-notes.md, 2026-09-20: it was painting
 * the wallpaper over the panel and insetting twice), and in the real app the
 * inset comes from the navigator above or from `RegularShell`'s window padding.
 * Here there is neither, so without this a section's own header sits under the
 * clock — which is what the first cron-detail screenshot showed.
 */
import { View } from 'react-native'

import { GalleryScreen } from '../features/settings/GalleryScreen'
import { useSafeAreaInsets } from '../platform/safe-area'
import { GlassSurface, Wallpaper } from '../ui/glass'

export function DevGallery({ section }: { section: string }) {
  const insets = useSafeAreaInsets()

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
