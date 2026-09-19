/**
 * The window's floor: a coloured gradient the glass panels float over.
 *
 * No image assets. A wallpaper shipped as a PNG has to ship at every scale
 * factor for every device, and these are three gradients — the file would be
 * pure weight. Dark wallpapers are deep but COLOURED; `#000000` is not a
 * wallpaper, and the flat black field is exactly what was rejected.
 *
 * The mockup builds each one from a diagonal base plus four or five radial
 * blooms. React Native has no radial gradient, and the obvious substitute — a
 * circle with a gradient inside it — is worse than no bloom at all: the circle
 * clips while its colour is still at full strength, so what you see is a lit
 * disc with a visible rim. Every bloom in the mockup is anchored near an edge or
 * a corner, so each one is drawn instead as a full-bleed wash that starts opaque
 * at its own corner and is fully transparent well before the opposite one. No
 * clip, no rim, and nothing to measure.
 */
import { LinearGradient } from 'expo-linear-gradient'
import type { ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '../theme'
import { withAlpha, type Bloom } from '../tokens'

export type WallpaperProps = {
  children?: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function Wallpaper({ children, style, testID }: WallpaperProps) {
  const theme = useTheme()
  const [first, second, third] = theme.wallpaper.base

  return (
    <View style={[{ backgroundColor: first }, style]} testID={testID}>
      <LinearGradient
        colors={[first ?? '#000000', second ?? first ?? '#000000', third ?? second ?? first ?? '#000000']}
        // The mockup's 158°: down, and a little to the right.
        end={{ x: 0.85, y: 1 }}
        locations={[0, 0.48, 1]}
        pointerEvents="none"
        start={{ x: 0.15, y: 0 }}
        style={StyleSheet.absoluteFill}
      />

      {theme.wallpaper.blooms.map((bloom, index) => (
        <BloomWash bloom={bloom} key={index} />
      ))}

      {children}
    </View>
  )
}

function BloomWash({ bloom }: { bloom: Bloom }) {
  // The corner the bloom is closest to, which is where its wash starts.
  const fromLeft = bloom.x < 0.5
  const fromTop = bloom.y < 0.5

  // How far across the window the colour is still doing anything. Past this the
  // wash is fully transparent, which is what keeps the edge invisible.
  const reach = Math.min(1, bloom.size * 0.72)

  return (
    <LinearGradient
      colors={[
        withAlpha(bloom.color, bloom.opacity),
        withAlpha(bloom.color, bloom.opacity * 0.5),
        withAlpha(bloom.color, 0)
      ]}
      end={{ x: fromLeft ? 1 : 0, y: fromTop ? 1 : 0 }}
      locations={[0, reach * 0.38, reach]}
      pointerEvents="none"
      start={{ x: fromLeft ? 0 : 1, y: fromTop ? 0 : 1 }}
      style={StyleSheet.absoluteFill}
    />
  )
}
