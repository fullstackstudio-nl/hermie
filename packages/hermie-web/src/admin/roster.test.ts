/**
 * The pieces both rosters are drawn from.
 *
 * Unit tests rather than page tests, because the properties worth pinning are
 * the ones a rendered page cannot show: that a colour follows an id for ever,
 * that a timestamp is one line whatever the distance to it is, and that a
 * control the browser posts is still a control a keyboard can reach.
 */
import { describe, expect, it } from 'vitest'

import { webStrings } from '../i18n'
import { avatar, cell, initialsOf, pill, rosterHead, toneOf, toggle, whenAgo, whenCell } from './roster'

const en = webStrings('en')

/** A local-time moment, so the expectations do not depend on the machine's zone. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month, day, hour, minute).getTime()

describe('initialsOf', () => {
  it('takes the first letter of up to two words', () => {
    expect(initialsOf('Grace Hopper')).toBe('GH')
    expect(initialsOf('Katherine Coleman Goble Johnson')).toBe('KC')
    expect(initialsOf('max')).toBe('M')
  })

  it('cuts an email at the at-sign, because the domain is not a name', () => {
    expect(initialsOf('ada@example.invalid')).toBe('A')
    expect(initialsOf('ada.lovelace@example.invalid')).toBe('AL')
  })

  it('reads a dot, an underscore and a hyphen as a space', () => {
    expect(initialsOf('grace_hopper')).toBe('GH')
    expect(initialsOf('jean-bartik')).toBe('JB')
  })

  it('answers one glyph for a name that has no letters to give', () => {
    expect(initialsOf('')).toBe('·')
    expect(initialsOf('   ')).toBe('·')
  })

  it('does not cut a name in the middle of a character', () => {
    // One code point, two UTF-16 units: a `slice(0, 1)` would answer half of it.
    expect(initialsOf('𝒜da')).toBe('𝒜')
  })
})

describe('toneOf', () => {
  it('answers the same tone for the same id, always', () => {
    expect(toneOf('ada@example.invalid')).toBe(toneOf('ada@example.invalid'))
  })

  it('stays inside the six tones the style sheet defines', () => {
    for (const id of ['', 'a', 'ada@example.invalid', 'Xr7tPq2mKd9sLb4wVc1zYe', '👩‍💻']) {
      expect(toneOf(id)).toBeGreaterThanOrEqual(0)
      expect(toneOf(id)).toBeLessThan(6)
    }
  })

  it('usually separates two ids that differ by one character', () => {
    const tones = new Set(['person-1', 'person-2', 'person-3', 'person-4', 'person-5'].map(toneOf))

    // Not a promise of a perfect spread — it is a colour — but a hash that
    // answered one tone for everybody would make the discs pointless.
    expect(tones.size).toBeGreaterThan(1)
  })
})

describe('avatar', () => {
  it('carries the tone of the id and the initials of the name, and no text for a reader', () => {
    const html = avatar('Grace Hopper', 'grace@example.invalid')

    expect(html).toContain(`av-${toneOf('grace@example.invalid')}`)
    expect(html).toContain('>GH<')
    // The name is beside it in the row; the disc is decoration.
    expect(html).toContain('aria-hidden="true"')
  })

  it('escapes what it draws', () => {
    expect(avatar('<b>', 'x')).not.toContain('<b>')
  })
})

describe('whenAgo', () => {
  const noon = at(2026, 8, 22, 12, 0)

  it('says a clock time for today and yesterday', () => {
    expect(whenAgo(at(2026, 8, 22, 11, 58) / 1000, en, noon)).toEqual({
      text: 'today 11:58',
      title: '2026-09-22 11:58'
    })
    expect(whenAgo(at(2026, 8, 21, 9, 4) / 1000, en, noon).text).toBe('yesterday 09:04')
  })

  it('says a date this year and a date with its year before that', () => {
    expect(whenAgo(at(2026, 8, 2, 8, 30) / 1000, en, noon).text).toBe('2 Sep')
    expect(whenAgo(at(2025, 10, 30, 8, 30) / 1000, en, noon).text).toBe('30 Nov 2025')
  })

  it('is a day apart even when it is an hour apart, because a day is what it says', () => {
    // 23:30 yesterday and 00:30 today are an hour apart and are not the same day.
    expect(whenAgo(at(2026, 8, 21, 23, 30) / 1000, en, at(2026, 8, 22, 0, 30)).text).toBe('yesterday 23:30')
  })

  it('answers a dash for a stamp that is not one, and no title to hover', () => {
    expect(whenAgo(0, en, noon)).toEqual({ text: '—', title: '' })
  })

  it('says the day in the language the page is in', () => {
    expect(whenAgo(at(2026, 8, 22, 11, 58) / 1000, webStrings('nl'), noon).text).toBe('vandaag 11:58')
    expect(whenAgo(at(2026, 8, 2, 8, 30) / 1000, webStrings('de'), noon).text).toBe('2 Sep')
    expect(whenAgo(at(2026, 2, 2, 8, 30) / 1000, webStrings('de'), noon).text).toBe('2 Mär')
  })

  it('puts the whole stamp on the pointer and the short form in the cell', () => {
    const html = whenCell('Last seen', at(2026, 8, 2, 8, 30) / 1000, en, noon)

    expect(html).toContain('title="2026-09-02 08:30"')
    expect(html).toContain('2 Sep')
    // And the column's name, for whoever hears the page rather than sees it.
    expect(html).toContain('<span class="sr">Last seen </span>')
  })
})

describe('the controls a row carries', () => {
  it('draws a real checkbox with the column name on it, and the track beside it', () => {
    const html = toggle({ name: 'readOnly', label: 'Read-only', checked: true })

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('name="readOnly"')
    expect(html).toContain('checked')
    expect(html).toContain('aria-label="Read-only"')
    expect(html).toContain('<span class="track">')
    // The visible caption is the same word, so it is hidden from the reader that
    // already heard it as the control's name.
    expect(html).toContain('<span class="switch-name" aria-hidden="true">Read-only</span>')
  })

  it('leaves a box unticked and can belong to a form somewhere else on the page', () => {
    const html = toggle({ name: 'push', label: 'Push', checked: false, form: 'person-3' })

    expect(html).not.toContain('checked')
    expect(html).toContain('form="person-3"')
  })

  it('makes a pill quiet unless it is asked for the accent or the danger one', () => {
    expect(pill('administrator')).toBe('<span class="pill">administrator</span>')
    expect(pill('administrator', 'on')).toContain('class="pill on"')
    expect(pill('disabled', 'bad')).toContain('class="pill bad"')
  })

  it('lays the head strip out with one cell per column, including the empty one', () => {
    expect(rosterHead(['Who', 'Last seen', ''])).toBe(
      '<div class="roster-head"><span>Who</span><span>Last seen</span><span></span></div>'
    )
  })

  it('puts the column name in every cell it draws', () => {
    expect(cell('Bots', 'All bots')).toContain('<span class="sr">Bots </span>All bots')
  })
})
