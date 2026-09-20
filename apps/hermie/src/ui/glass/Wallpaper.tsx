/**
 * The window's floor: one flat colour the glass sits on.
 *
 * It used to be a diagonal ramp plus four or five corner washes, built to imitate
 * the mockup's radial blooms. The owner's verdict on the result was that it looks
 * generated, and the reference he set against it — iPadOS 26 Messages in dark
 * mode — is a near-black field with nothing painted on it at all: everything that
 * reads as depth there comes from the glass in FRONT of the floor, not from the
 * floor. So this is `theme.wallpaper.fill` and nothing else.
 *
 * Still no image assets, for the reason there never were any: a wallpaper shipped
 * as a PNG has to ship at every scale factor for every device, and this is one
 * colour.
 */
import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '../theme'

export type WallpaperProps = {
  children?: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function Wallpaper({ children, style, testID }: WallpaperProps) {
  const theme = useTheme()

  return (
    <View style={[{ backgroundColor: theme.wallpaper.fill }, style]} testID={testID}>
      {children}
    </View>
  )
}
