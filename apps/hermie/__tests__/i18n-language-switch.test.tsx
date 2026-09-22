/**
 * Picking a language, and the screen changing while you are looking at it.
 *
 * The thing under test is not the picker — it is a store write — but the two
 * halves that make a switch VISIBLE without a restart:
 *
 *  1. `strings.x.y` resolves on access, so a component that renders again
 *     paints the new language with no other change;
 *  2. something has to make it render again. `App` subscribes at the root
 *     (`useFollowsLocale`), which re-renders the tree under it in one pass
 *     rather than remounting it — a remount would throw away the scroll
 *     position and the open sheet of whoever just used the picker.
 *
 * Both halves are asserted, and separately: the first would pass on its own
 * while a reader sat in front of an English screen with a Dutch setting.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { useRef } from 'react'
import { View } from 'react-native'

import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { strings } from '../src/i18n/strings'
import { useFollowsLocale } from '../src/i18n/use-locale'
import { AppearanceSection } from '../src/features/settings/AppearanceSection'
import { resetLanguageStore, useLanguageStore } from '../src/store/language'
import { Text } from '../src/ui/primitives'
import { renderScreen, withProviders } from './support/render'

afterEach(() => {
  act(() => {
    resetLanguageStore()
  })
  resetActiveLocale()
})

describe('the picker in Settings → Appearance', () => {
  it('offers "follow the device" and each language in its own words', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    expect(screen.getByTestId('settings-language-system')).toBeTruthy()
    expect(screen.getByText('Nederlands')).toBeTruthy()
    expect(screen.getByText('Deutsch')).toBeTruthy()
    expect(screen.getByText('English')).toBeTruthy()
  })

  it('pins the language, and says so in that language', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    act(() => {
      fireEvent.press(screen.getByTestId('settings-language-nl'))
    })

    expect(useLanguageStore.getState().choice).toBe('nl')
    expect(useLanguageStore.getState().locale).toBe('nl')
    // The group re-rendered because it reads the store, and its own header came
    // back in Dutch. The rest of the screen needs the root subscription below.
    expect(screen.getByText('Taal')).toBeTruthy()
  })

  it('starts on "follow the device"', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    expect(useLanguageStore.getState().choice).toBe('system')
  })
})

/** A component that reads a string and counts how many times it was mounted. */
function Probe({ mounts }: { mounts: { current: number } }) {
  const first = useRef(true)

  if (first.current) {
    first.current = false
    mounts.current += 1
  }

  return <Text testID="probe">{strings.settings.language}</Text>
}

/** The root's job, in miniature: subscribe, and render the tree under it. */
function Root({ mounts }: { mounts: { current: number } }) {
  useFollowsLocale()

  return (
    <View>
      <Probe mounts={mounts} />
    </View>
  )
}

describe('a switch at the root', () => {
  it('repaints a screen that never touched the language store', () => {
    const mounts = { current: 0 }

    render(withProviders(<Root mounts={mounts} />))

    expect(screen.getByTestId('probe').props.children).toBe('Language')

    act(() => {
      setActiveLocale('nl')
    })

    expect(screen.getByTestId('probe').props.children).toBe('Taal')
  })

  it('re-renders rather than remounting', () => {
    const mounts = { current: 0 }

    render(withProviders(<Root mounts={mounts} />))

    expect(mounts.current).toBe(1)

    act(() => {
      setActiveLocale('de')
    })

    expect(screen.getByTestId('probe').props.children).toBe('Sprache')
    // Still one. A `key={locale}` on the tree would pass the assertion above
    // and fail this one, and would have cost the reader whatever they had open.
    expect(mounts.current).toBe(1)
  })

  it('leaves an untranslated string in English', () => {
    render(withProviders(<Root mounts={{ current: 0 }} />))

    act(() => {
      setActiveLocale('nl')
    })

    // Not a gap in the screen, and not a key: the sentence the app is written
    // in. See `i18n/coverage.ts` for how one of these becomes a to-do.
    expect(strings.settings.theme).toBe('Theme')
  })
})
