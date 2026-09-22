/**
 * The three server-rendered pages' language negotiation, and the catalogues
 * behind it.
 *
 * Two properties, and everything here is one of them from a different side:
 *
 *  1. **A header decides, and a header nobody can read decides English.** Every
 *     shape a browser or a crawler actually sends is covered, and so is every
 *     shape that is not a header at all, because the failure mode of a parser
 *     that throws on rubbish is a sign-in page that 500s.
 *  2. **A missing translation is the English sentence.** That is what makes a
 *     partial catalogue safe to ship, so it is pinned rather than assumed.
 */
import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { htmlLang, localeOf, negotiateLocale, WEB_LOCALES, webCopy, webStrings } from './i18n'

/** Just enough of a request to carry one header. */
const asking = (header?: string): IncomingMessage =>
  ({ headers: header === undefined ? {} : { 'accept-language': header } }) as unknown as IncomingMessage

describe('negotiateLocale', () => {
  it('takes a plain language tag', () => {
    expect(negotiateLocale('nl')).toBe('nl')
    expect(negotiateLocale('de')).toBe('de')
    expect(negotiateLocale('en')).toBe('en')
  })

  it('drops the region, because there is no Flemish copy to fold nl-BE into', () => {
    expect(negotiateLocale('nl-BE')).toBe('nl')
    expect(negotiateLocale('de-AT,de;q=0.9')).toBe('de')
    expect(negotiateLocale('NL-be')).toBe('nl')
  })

  it('lets the weight decide, not the position', () => {
    // German is second in the list and wins anyway, which is the whole reason
    // this is a parse rather than a prefix match.
    expect(negotiateLocale('en;q=0.3, de;q=0.9')).toBe('de')
    expect(negotiateLocale('fr, nl;q=0.8, de;q=0.9')).toBe('de')
  })

  it('keeps the written order where the weights tie', () => {
    expect(negotiateLocale('nl;q=0.5, de;q=0.5')).toBe('nl')
    expect(negotiateLocale('de, nl')).toBe('de')
  })

  it('reads q=0 as a refusal rather than a weak preference', () => {
    expect(negotiateLocale('nl;q=0, de;q=0.1')).toBe('de')
    // Refused and alone: still not chosen, and English is what is left.
    expect(negotiateLocale('de;q=0')).toBe('en')
  })

  it('ignores the wildcard, which asks for the default that is already there', () => {
    expect(negotiateLocale('*')).toBe('en')
    expect(negotiateLocale('*;q=1.0, nl;q=0.5')).toBe('nl')
  })

  it('answers English for a language nobody here speaks', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9,es;q=0.8')).toBe('en')
  })

  it('answers English for no header at all', () => {
    expect(negotiateLocale(undefined)).toBe('en')
    expect(negotiateLocale(null)).toBe('en')
    expect(negotiateLocale('')).toBe('en')
  })

  it('answers English for a header that is not one', () => {
    expect(negotiateLocale(',,,')).toBe('en')
    expect(negotiateLocale(';;;')).toBe('en')
    expect(negotiateLocale('¯\\_(ツ)_/¯')).toBe('en')
    // A weight outside 0..1 is not a weight, so the entry carrying it is dropped.
    expect(negotiateLocale('nl;q=5')).toBe('en')
  })

  it('does not let one broken entry take a good one down with it', () => {
    expect(negotiateLocale('nl;q=5, de;q=0.4')).toBe('de')
  })
})

describe('localeOf', () => {
  it('reads the header off the request', () => {
    expect(localeOf(asking('nl-NL,nl;q=0.9'))).toBe('nl')
    expect(localeOf(asking())).toBe('en')
  })

  it('hands back the copy beside the language it chose', () => {
    const copy = webCopy(asking('de'))

    expect(copy.locale).toBe('de')
    expect(copy.strings.common.signIn).toBe('Anmelden')
  })
})

describe('htmlLang', () => {
  it('is the tag itself, for every language there is', () => {
    for (const locale of WEB_LOCALES) {
      expect(htmlLang(locale)).toBe(locale)
    }
  })
})

describe('the catalogues', () => {
  it('answers a translated key in its own language', () => {
    expect(webStrings('nl').common.signIn).toBe('Inloggen')
    expect(webStrings('nl').common.signIn).not.toBe(webStrings('en').common.signIn)
    expect(webStrings('de').oidc.enrol.heading).not.toBe(webStrings('en').oidc.enrol.heading)
  })

  it('paints the English sentence where a catalogue says nothing', () => {
    // `Hermie Web 1.2.3` reads the same in Dutch, so the Dutch catalogue does
    // not carry it and the fallback is what renders.
    expect(webStrings('nl').setup.footer('1.2.3')).toBe('Hermie Web 1.2.3')
    expect(webStrings('nl').setup.footer('1.2.3')).toBe(webStrings('en').setup.footer('1.2.3'))
    expect(webStrings('de').setup.script.probed('1.2.3', 'cookie')).toBe('Hermes 1.2.3 — cookie.')
  })

  it('keeps every key, of the right kind, in every language', () => {
    for (const locale of WEB_LOCALES) {
      const strings = webStrings(locale)

      expect(typeof strings.admin.footer.version).toBe('function')
      expect(typeof strings.admin.overview.peopleSeen).toBe('function')
      expect(typeof strings.admin.forbidden.knownAs).toBe('function')
      expect(typeof strings.oidc.signIn.title).toBe('function')
      expect(typeof strings.admin.people.empty).toBe('string')
      expect(strings.admin.identity.on('https://example.invalid', 1)).toContain('example.invalid')
    }
  })

  it('is the same object twice, because nothing in it depends on the request', () => {
    expect(webStrings('nl')).toBe(webStrings('nl'))
  })
})
