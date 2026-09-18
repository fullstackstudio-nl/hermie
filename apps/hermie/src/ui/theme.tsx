import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'

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
  // including macOS; an explicit in-app override lands with Settings.
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light'
  const theme = useMemo(() => buildTheme(scheme), [scheme])

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
