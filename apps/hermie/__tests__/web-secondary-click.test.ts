/**
 * Right-clicking a chat row.
 *
 * The row menu — rename, colour, move, add a divider, archive — was reachable
 * by exactly one gesture: a long press. That is right on a phone and is a
 * gesture nobody performs with a mouse, so in a browser the menu had no way in
 * at all. Found by right-clicking a row in a real browser and watching nothing
 * happen.
 *
 * Driven against the `.web` half directly, as every seam test here is: the
 * shared module is the no-op the phones get.
 */
import { secondaryClick } from '../src/platform/secondary-click.web'
import { secondaryClick as nativeSecondaryClick } from '../src/platform/secondary-click'

describe('a secondary click in a browser', () => {
  it('opens the menu the long press opens', () => {
    const open = jest.fn()
    const preventDefault = jest.fn()

    secondaryClick(open).onContextMenu?.({ preventDefault })

    expect(open).toHaveBeenCalledTimes(1)
  })

  it('stops the browser drawing its own menu over the app', () => {
    // Not optional: without it one gesture opens two menus.
    const preventDefault = jest.fn()

    secondaryClick(jest.fn()).onContextMenu?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})

describe('everywhere else', () => {
  it('hands back nothing, because the gesture is already wired', () => {
    // A long press on the phones, and the system's own menu on a Mac — which
    // is a native view rather than an event. See `platform/context-menu.tsx`.
    expect(nativeSecondaryClick(jest.fn())).toEqual({})
  })
})
