/**
 * The app does not restyle itself when its window stops being the front one.
 *
 * The owner photographed it on the Mac: click another app and Hermie's chrome
 * visibly changes. Nothing in this app asks for that. Both of its blurring
 * materials — `UIGlassEffect` on iOS 26 and `expo-blur` below it — are
 * `UIVisualEffectView`s, and macOS draws every visual effect view in a window
 * that is not key with the dimmed variant of its material.
 *
 * **There is no API to turn that off.** That was looked for in the iOS 27 SDK
 * rather than assumed, and the list is in `platform/window-activity.ts` beside
 * the code that replaced it. So the lever is not to have a visual effect view on
 * screen while the window is inactive, and the recipe that replaces it is the
 * one this app already draws for Android and for Reduce Transparency: the
 * surface's own rung of the elevation ladder, which is the ONLY inactive-safe
 * one — the `blur` fallback is a `UIVisualEffectView` as well and dims exactly
 * the same way.
 *
 * Three things are asserted here, and the third is the one that keeps a phone
 * out of it:
 *
 *  - the seam reaches the theme, so every surface in the app reads one answer;
 *  - a surface that was blurring stops putting a blur view on screen, and
 *    paints its solid rung instead of nothing;
 *  - the WEB seam is a constant, because a `backdrop-filter` has no window
 *    state in it and a blur that came and went with tab focus would be this
 *    same bug invented by us.
 *
 * What is NOT asserted, and cannot be from here: that macOS dims the material at
 * all. There is no Mac window in this environment. See docs/platform-notes.md.
 */
import { act, render, screen } from '@testing-library/react-native'
import { StyleSheet, Text } from 'react-native'

import { GlassSurface } from '../src/ui/glass'
import { ThemeProvider, useTheme } from '../src/ui/theme'

jest.mock('expo-status-bar', () => ({ StatusBar: jest.fn(() => null) }))

const mockListeners = new Set<(active: boolean) => void>()
let mockInitiallyActive = true

jest.mock('../src/platform/window-activity', () => ({
  isWindowActive: () => mockInitiallyActive,
  subscribeToWindowActivity: (handler: (active: boolean) => void) => {
    mockListeners.add(handler)

    return () => mockListeners.delete(handler)
  }
}))

/** The window's activation changing, the way the native module reports it. */
function setWindowActive(active: boolean) {
  act(() => {
    for (const listener of [...mockListeners]) {
      listener(active)
    }
  })
}

function Flag() {
  return <Text testID="flag">{String(useTheme().windowActive)}</Text>
}

/** Every blur view on screen, whichever of the two materials drew it. */
function materials() {
  return screen.UNSAFE_root.findAll(
    node => node.type === 'ExpoBlurView' || node.type === 'ExpoGlassView' || node.type === 'ExpoGlassContainer'
  )
}

beforeEach(() => {
  mockListeners.clear()
  mockInitiallyActive = true
})

describe('the window-activity seam and the theme', () => {
  it('starts from the seam rather than from an assumption', () => {
    mockInitiallyActive = false

    render(
      <ThemeProvider>
        <Flag />
      </ThemeProvider>
    )

    // The native event only fires on a CHANGE, so a bundle that reloaded behind
    // another window has to be told the current answer by the getter or it
    // spends its first activation drawing a material macOS is dimming.
    expect(screen.getByTestId('flag')).toHaveTextContent('false')
  })

  it('follows the window out of the front and back into it', () => {
    render(
      <ThemeProvider>
        <Flag />
      </ThemeProvider>
    )

    expect(screen.getByTestId('flag')).toHaveTextContent('true')

    setWindowActive(false)
    expect(screen.getByTestId('flag')).toHaveTextContent('false')

    setWindowActive(true)
    expect(screen.getByTestId('flag')).toHaveTextContent('true')
  })

  it('drops the subscription with the provider', () => {
    const view = render(
      <ThemeProvider>
        <Flag />
      </ThemeProvider>
    )

    expect(mockListeners.size).toBe(1)

    view.unmount()
    expect(mockListeners.size).toBe(0)
  })
})

describe('a glass surface in an inactive window', () => {
  function Panel() {
    return (
      <ThemeProvider>
        <GlassSurface contentTestID="panel-surface" testID="panel" variant="panel">
          <Text>{'body'}</Text>
        </GlassSurface>
      </ThemeProvider>
    )
  }

  it('blurs while the window is in front', () => {
    render(<Panel />)

    expect(materials().length).toBe(1)
  })

  it('takes the blur view off screen while the window is not', () => {
    render(<Panel />)

    setWindowActive(false)

    // A count rather than the nodes themselves: a failure here would otherwise
    // try to serialise a whole rendered tree, which runs the worker out of heap
    // before it can print what went wrong.
    expect(materials().length).toBe(0)
  })

  /**
   * The part that makes it a SWAP rather than a hole.
   *
   * A panel with no blur and no fill is a transparent rectangle over the
   * wallpaper, which is a bigger restyle than the dimming this is for. The
   * elevation ladder's own rung is what the solid path already paints on
   * Android, and it is defined to keep the same hierarchy.
   */
  it('paints the surface its own solid rung instead', () => {
    render(<Panel />)

    const fill = () => StyleSheet.flatten(screen.getByTestId('panel-surface').props.style)?.backgroundColor

    const before = fill()

    setWindowActive(false)

    const after = fill()

    expect(before).toBe('transparent')
    expect(after).not.toBe('transparent')
    expect(typeof after).toBe('string')
  })

  it('comes back to the blurred material when the window does', () => {
    render(<Panel />)

    setWindowActive(false)
    setWindowActive(true)

    expect(materials().length).toBe(1)
  })
})

describe('the browser half of the seam', () => {
  it('is a constant, because a backdrop-filter has no window state in it', () => {
    // Required rather than imported so the mock above, which stands in for the
    // NATIVE seam, cannot answer for it.
    const web = jest.requireActual('../src/platform/window-activity.web') as {
      isWindowActive: () => boolean
      subscribeToWindowActivity: (handler: (active: boolean) => void) => () => void
    }

    expect(web.isWindowActive()).toBe(true)

    const handler = jest.fn()
    const unsubscribe = web.subscribeToWindowActivity(handler)

    expect(handler).not.toHaveBeenCalled()
    expect(() => unsubscribe()).not.toThrow()
  })
})
