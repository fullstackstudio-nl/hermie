/**
 * The `context` section, as bytes.
 *
 * The expectations here are written against the PLUGIN's reader
 * (`context/render.py` in the hermie-plugin repository) rather than against
 * this module's own types, for the same reason the push tests are written
 * against the daemon's reader: the two live in different repositories and the
 * only thing that keeps them in step is a test that says what the far side
 * will do with these bytes.
 *
 * Three properties, and the third is the one that would go unnoticed:
 *
 *  - the CAPS. `render.py` truncates per field, so a longer value costs nothing
 *    in the prompt — but it still travels, still sits in the profile, and is
 *    still carried by every other device's write.
 *  - the FLATTENING. The plugin renders one fact per line, so a newline inside
 *    a field would arrive looking like a second fact.
 *  - the NEIGHBOURS. ADR-0016 replaces the key whole, so a write that did not
 *    carry the other people's rows would delete their context.
 */
import { describe, expect, it } from 'vitest'

import {
  CONTEXT_LIMITS,
  CONTEXT_SECTION_VERSION,
  contextDefaultOf,
  contextRowFor,
  contextSectionFor,
  contextTextOf,
  foreignContextUsers,
  type ContextUserInput
} from './context'

const NOW = 1_789_957_143

const user = (patch: Partial<ContextUserInput> = {}): ContextUserInput => ({
  userId: 'tester@example.invalid',
  displayName: 'Sebas',
  device: { model: 'iPhone 17 Pro', os: 'iOS 27.0', appVersion: '0.1.0 (1284) · 7c838c4' },
  timezone: 'Europe/Amsterdam',
  locale: 'nl-NL',
  updatedAt: NOW,
  ...patch
})

describe('one field', () => {
  it('is flattened to single spaces, because the plugin renders one fact per line', () => {
    expect(contextTextOf('two\nlines   and  gaps', 100)).toBe('two lines and gaps')
  })

  it('is cut at the cap the plugin uses', () => {
    expect(contextTextOf('x'.repeat(900), CONTEXT_LIMITS.about)).toHaveLength(CONTEXT_LIMITS.about)
  })

  it('is empty for anything that is not text', () => {
    expect(contextTextOf(null, 10)).toBe('')
    expect(contextTextOf({ about: 'me' }, 10)).toBe('')
    expect(contextTextOf(['me'], 10)).toBe('')
  })
})

describe('one person’s row', () => {
  it('carries the device, the place and the stamp', () => {
    expect(contextRowFor(user())).toEqual({
      displayName: 'Sebas',
      device: { model: 'iPhone 17 Pro', os: 'iOS 27.0', appVersion: '0.1.0 (1284) · 7c838c4' },
      timezone: 'Europe/Amsterdam',
      locale: 'nl-NL',
      updatedAt: NOW
    })
  })

  it('omits an empty field rather than writing it as an empty string', () => {
    const row = contextRowFor(user({ displayName: '', timezone: '', locale: '' }))

    expect(row).not.toHaveProperty('displayName')
    expect(row).not.toHaveProperty('timezone')
    expect(row).not.toHaveProperty('locale')
  })

  it('caps the free text and the per-bot notes at the plugin’s own limits', () => {
    const row = contextRowFor(
      user({ about: 'a'.repeat(1000), perBot: { researcher: 'b'.repeat(1000), writer: '   ' } })
    )

    expect(row.about).toHaveLength(CONTEXT_LIMITS.about)
    expect(row.perBot).toEqual({ researcher: 'b'.repeat(CONTEXT_LIMITS.perBot) })
  })

  it('drops a bot whose note is empty, rather than writing a key with nothing under it', () => {
    expect(contextRowFor(user({ perBot: { researcher: '' } }))).not.toHaveProperty('perBot')
  })
})

describe('the whole section', () => {
  it('names this device’s person as the default', () => {
    const section = contextSectionFor({ others: {}, own: user() })

    expect(section).toMatchObject({ v: CONTEXT_SECTION_VERSION, default: 'tester@example.invalid' })
    expect(Object.keys(section?.users ?? {})).toEqual(['tester@example.invalid'])
  })

  it('carries rows belonging to other people through untouched', () => {
    const others = { 'colleague@example.invalid': { displayName: 'Robin', v: 9, future: true } }
    const section = contextSectionFor({ others, own: user() })

    expect(section?.users['colleague@example.invalid']).toEqual(others['colleague@example.invalid'])
  })

  it('is undefined when there is nothing at all to say', () => {
    expect(contextSectionFor({ others: {}, own: null })).toBeUndefined()
  })

  it('keeps the default somebody else set when this device has no identity', () => {
    const section = contextSectionFor({
      others: { 'colleague@example.invalid': { displayName: 'Robin' } },
      own: null,
      fallbackDefault: 'colleague@example.invalid'
    })

    expect(section?.default).toBe('colleague@example.invalid')
  })
})

describe('reading a section back', () => {
  const bag = {
    context: {
      v: 1,
      default: 'tester@example.invalid',
      users: {
        'tester@example.invalid': { displayName: 'Sebas' },
        'colleague@example.invalid': { displayName: 'Robin' }
      }
    }
  }

  it('leaves out our own row, which is ours to replace', () => {
    expect(Object.keys(foreignContextUsers(bag, 'tester@example.invalid'))).toEqual(['colleague@example.invalid'])
  })

  it('answers nothing for a bag with no section in it', () => {
    expect(foreignContextUsers({ push: {} }, 'tester@example.invalid')).toEqual({})
    expect(contextDefaultOf({ push: {} })).toBe('')
  })

  it('reads the default back, for a write that has nobody of its own', () => {
    expect(contextDefaultOf(bag)).toBe('tester@example.invalid')
  })
})
