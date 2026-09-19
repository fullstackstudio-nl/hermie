import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'

import { useSettingsStore } from '../store/settings'
import { darkColors, lightColors, radii, space, type, type ColorScale } from './tokens'

export type Theme = {
  scheme: 'light' | 'dark'
  colors: ColorScale
  space: typeof space
  radii: typeof radii
  type: typeof type
}

function buildTheme(scheme: 'light' | 'dark'): Theme {
  return {
    scheme,
    colors: scheme === 'dark' ? darkColors : lightColors,
    space,
    radii,
    type
  }
}

const ThemeContext = createContext<Theme>(buildTheme('light'))

export function ThemeProvider({ children }: { children: ReactNode }) {
  // `useColorScheme` follows the system on every platform Hermie targets,
  // including macOS. The stored appearance overrides it when the user pinned
  // one, which is why the preference is read here rather than in Settings: the
  // theme is what every screen resolves through.
  const system = useColorScheme() === 'dark' ? 'dark' : 'light'
  const appearance = useSettingsStore(state => state.appearance)
  const loaded = useSettingsStore(state => state.loaded)

  useEffect(() => {
    // Hydrating here rather than further down the tree keeps the very first
    // paint from flashing the system scheme before the stored one arrives.
    if (!loaded) {
      void useSettingsStore.getState().hydrate()
    }
  }, [loaded])

  const scheme = appearance === 'system' ? system : appearance
  const theme = useMemo(() => buildTheme(scheme), [scheme])

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
