/**
 * The layer that makes one English string table three languages.
 *
 * The four properties worth pinning, in the order they would break:
 *
 *  1. **English is the fallback, not an error.** The whole reason the app can
 *     add copy in one language and translate it later is that a missing key
 *     reads as the English sentence rather than as a hole.
 *  2. **Resolution happens on access.** A value captured at import time is the
 *     bug the 14 module-level `const OPTIONS = […]` lists in this app were, and
 *     it is invisible in English because English is what a cold start shows.
 *  3. **A catalogue of the wrong SHAPE loses.** A translation that answers a
 *     function key with a bare string would drop the interpolated argument
 *     silently; the English function wins instead.
 *  4. **The completeness walkers agree on what "missing" means** — including
 *     the half people forget, which is a translation left behind by a key that
 *     was renamed in English.
 */
import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { missingKeys, strayKeys, type Translation } from '../src/i18n/catalogue'
import { strings } from '../src/i18n/strings'

afterEach(() => {
  resetActiveLocale()
})

describe('the localised proxy', () => {
  it('hands back the English sentence when the catalogue has no answer', () => {
    setActiveLocale('nl')

    // `settings.theme` is deliberately not in the Dutch catalogue yet. A reader
    // in Dutch sees the English word rather than a key or an empty row.
    expect(strings.settings.theme).toBe('Theme')
  })

  it('hands back the catalogue value when it has one', () => {
    setActiveLocale('nl')

    expect(strings.settings.language).toBe('Taal')

    setActiveLocale('de')

    expect(strings.settings.language).toBe('Sprache')
  })

  it('resolves on every read rather than once at import', () => {
    // The same expression, twice, with nothing in between but a switch. A value
    // captured when this module loaded would answer the same thing both times.
    expect(strings.settings.language).toBe('Language')

    setActiveLocale('de')

    expect(strings.settings.language).toBe('Sprache')
  })

  it('keeps functions callable, and keeps their arguments', () => {
    setActiveLocale('nl')

    // Untranslated, so English — but still a function with its argument intact,
    // which is the thing a naive string-only catalogue breaks.
    expect(strings.onboarding.stepCounter(2, 4)).toBe('Step 2 of 4')
  })

  it('walks nested branches without losing the path', () => {
    setActiveLocale('de')

    expect(strings.settings.languageFollowDevice).toBe('Gerät folgen')
    expect(strings.settings.themeOptions.system).toBe('System')
  })

  it('still enumerates the English keys under a translation', () => {
    setActiveLocale('nl')

    // `Object.keys` on the proxy has to answer with the SOURCE's keys, or the
    // coverage walkers below would only ever see what has been translated.
    expect(Object.keys(strings.settings.themeOptions)).toEqual(['system', 'light', 'dark'])
  })
})

/** A source table small enough to reason about, with one of each kind of leaf. */
const SOURCE = {
  plain: 'Plain',
  interpolated: (name: string) => `Hello ${name}`,
  nested: {
    deep: 'Deep',
    deeper: { leaf: 'Leaf' }
  }
}

describe('shape mismatches', () => {
  it('ignores a catalogue value of the wrong kind', () => {
    // Cast on purpose: the `Translation` type would refuse this, and the point
    // is what happens when a catalogue is wrong anyway — after a cast, after a
    // hand-edit, after a key changed kind in English.
    const wrong = { plain: { not: 'a string' }, interpolated: 'no argument' } as unknown as Translation<typeof SOURCE>

    expect(missingKeys(SOURCE, wrong)).toEqual(
      expect.arrayContaining(['plain', 'interpolated', 'nested.deep', 'nested.deeper.leaf'])
    )
  })
})

describe('missingKeys', () => {
  it('reports every leaf of a branch the translation omits, not the branch', () => {
    expect(missingKeys(SOURCE, { plain: 'Effen', interpolated: (name: string) => `Hallo ${name}` })).toEqual([
      'nested.deep',
      'nested.deeper.leaf'
    ])
  })

  it('is empty for a complete translation', () => {
    const complete: Translation<typeof SOURCE> = {
      plain: 'Effen',
      interpolated: (name: string) => `Hallo ${name}`,
      nested: { deep: 'Diep', deeper: { leaf: 'Blad' } }
    }

    expect(missingKeys(SOURCE, complete)).toEqual([])
  })
})

describe('strayKeys', () => {
  it('finds a translation the English table no longer has a key for', () => {
    const stale = { plain: 'Effen', retired: 'Weg', nested: { gone: 'Verdwenen' } } as unknown as Translation<
      typeof SOURCE
    >

    expect(strayKeys(SOURCE, stale).sort()).toEqual(['nested.gone', 'retired'])
  })

  it('is empty for a translation that only answers real keys', () => {
    expect(strayKeys(SOURCE, { plain: 'Effen', nested: { deep: 'Diep' } })).toEqual([])
  })
})
