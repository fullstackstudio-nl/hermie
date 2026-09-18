import { View, type ViewProps } from 'react-native'
import { useSafeAreaInsets } from '../../platform/safe-area'

import { useTheme } from '../theme'

export type ScreenProps = ViewProps & {
  /** Skip the top safe-area inset when a navigation header already covers it. */
  edgeToEdgeTop?: boolean
  padded?: boolean
}

export function Screen({ edgeToEdgeTop = false, padded = true, style, ...rest }: ScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <View
      {...rest}
      style={[
        {
          flex: 1,
          backgroundColor: theme.colors.bg,
          paddingTop: edgeToEdgeTop ? 0 : insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left + (padded ? theme.space.lg : 0),
          paddingRight: insets.right + (padded ? theme.space.lg : 0)
        },
        style
      ]}
    />
  )
}
