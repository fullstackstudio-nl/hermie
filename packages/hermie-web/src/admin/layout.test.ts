/**
 * The roster row's overlap guards, pinned in the stylesheet itself.
 *
 * A rendered page cannot show this one: the overlap this guards against only
 * shows up once a value is long enough to fill a column, and no fixture in a
 * page test is guaranteed to stay that long forever. What actually stops
 * "gateway sign-in" being painted over "today 15:33" again is a handful of CSS
 * declarations — `display: block` on a span that would otherwise ignore
 * `overflow`, `min-width: 0` on the cells that have to be allowed to shrink,
 * and one `align-items` per row kind — so those are what this asserts on the
 * stylesheet string directly, the same way a reader would grep it after the
 * next report of a row that collides.
 */
import { describe, expect, it } from 'vitest'

import { STYLE } from './layout'

/**
 * Every declaration that applies to a selector, joined into one string.
 *
 * A selector can own more than one block — ".roster-row" is the tail of a
 * selector list it shares with ".roster-head" for the columns both need, and
 * carries two rules of its own besides — and CSS applies all of them. Joining
 * every match is what makes an assertion about "the rule for .roster-row"
 * true to the cascade, rather than an accident of which block happens to
 * appear first in the source.
 */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A lookbehind that is not a word character or a hyphen, so ".who-sub"
  // cannot match inside a longer class name — selector lists still match,
  // because the character before a later entry is a comma or a space.
  const pattern = new RegExp(`(?<![\\w-])${escaped}\\s*\\{([^}]*)\\}`, 'g')
  const bodies = [...STYLE.matchAll(pattern)].map(match => match[1] ?? '')

  if (!bodies.length) {
    throw new Error(`no rule for ${selector} in STYLE`)
  }

  return bodies.join(' ')
}

describe('the roster row cannot overlap its own columns', () => {
  it('lets every cell shrink to its column instead of forcing the column open', () => {
    expect(ruleFor('.who')).toContain('min-width: 0')
    expect(ruleFor('.who-text')).toContain('min-width: 0')
    expect(ruleFor('.who-name')).toContain('min-width: 0')
  })

  it('makes the second line and the shared-username note real boxes, not bare inline text', () => {
    // A `<span>` is `display: inline` by default, and an inline box is exactly
    // as wide as its content — `overflow: hidden` on one has nothing to clip,
    // which is how a second line painted straight across the next column. The
    // whole fix is this one declaration, so it is asserted on its own.
    const rule = ruleFor('.who-sub, .who-note, .cell')

    expect(rule).toContain('display: block')
    expect(rule).toContain('min-width: 0')
    expect(rule).toContain('white-space: nowrap')
    expect(rule).toContain('overflow: hidden')
    expect(rule).toContain('text-overflow: ellipsis')
  })

  it('clips the name the same way', () => {
    const rule = ruleFor('.who-name strong')

    expect(rule).toContain('overflow: hidden')
    expect(rule).toContain('text-overflow: ellipsis')
    expect(rule).toContain('white-space: nowrap')
  })

  it('aligns a header row to its single line and a person row to its first line', () => {
    // Centring a person's row against a name block that is one, two or three
    // lines tall is what put "Last seen" and "Bots" between the lines instead
    // of beside the name. The header row has no such block, so it stays
    // centred; the roster row aligns to the top instead.
    expect(ruleFor('.roster-head')).toContain('align-items: center')
    expect(ruleFor('.roster-row')).toContain('align-items: start')
  })

  it('gives every header cell the same size and weight, switches included', () => {
    // One `font` shorthand on `.roster-head`, inherited by every span in it —
    // and the switches' own header rule no longer sets a second, smaller
    // font-size that made "Read-only / Push / Administrator" read as a
    // different, quieter table glued under "Who / Last seen / Bots".
    expect(ruleFor('.roster-head')).toMatch(/font:\s*600 0\.72rem/)
    expect(ruleFor('.roster-head .switches > span')).not.toMatch(/font-size/)
  })
})
