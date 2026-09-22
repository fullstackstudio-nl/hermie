/**
 * The two names a bot has, and which one leads.
 *
 * The rule lives in one pure function because three callers that do not share a
 * render tree need the same answer: a chat row, the chat header, and the widget
 * snapshot's projection — which runs in a store subscription and has no hooks
 * available to it at all.
 */
import { asNameOrder, botLabel, botNames, DEFAULT_NAME_ORDER } from '../src/store/bot-names'

const LANCE = { name: 'lance-vance', displayName: 'Netwerkbeheerder' }

describe('the two names a bot has', () => {
  it('leads with the display name by default', () => {
    // The owner's call, revisited: somebody who has named their bots thinks of
    // them by those names. The handle stays on the row one line down, which is
    // where a reader looks to match a chat against an `@mention` or a cron.
    expect(DEFAULT_NAME_ORDER).toBe('display')
    expect(botNames(LANCE, DEFAULT_NAME_ORDER)).toEqual({
      primary: 'Netwerkbeheerder',
      secondary: 'lance-vance'
    })
  })

  it('swaps the two on request, and swaps nothing else', () => {
    expect(botNames(LANCE, 'profile')).toEqual({ primary: 'lance-vance', secondary: 'Netwerkbeheerder' })
  })

  /**
   * One name is one line, in BOTH orders.
   *
   * Drawing `researcher` over `Researcher` would be a second line that adds
   * nothing and invites the reader to look for a difference that is not there.
   * The case-only pair is the single most common shape on a real gateway.
   */
  describe('a bot with only one name', () => {
    it('says so when the display name is the handle in different case', () => {
      const bot = { name: 'researcher', displayName: 'Researcher' }

      expect(botNames(bot, 'profile')).toEqual({ primary: 'researcher', secondary: '' })
      expect(botNames(bot, 'display')).toEqual({ primary: 'researcher', secondary: '' })
    })

    it('says so when the display name was never set', () => {
      // `bots.ts` already falls back to the handle, so this arrives as a copy
      // rather than as an empty string — but both shapes reach here.
      expect(botNames({ name: 'postman', displayName: '' }, 'profile')).toEqual({ primary: 'postman', secondary: '' })
      expect(botNames({ name: 'postman', displayName: 'postman' }, 'display')).toEqual({
        primary: 'postman',
        secondary: ''
      })
    })

    it('ignores surrounding whitespace, which is not a difference either', () => {
      expect(botNames({ name: 'postman', displayName: '  Postman  ' }, 'profile').secondary).toBe('')
    })

    it('keeps a display name that really is different, whitespace trimmed off', () => {
      expect(botNames({ name: 'postman', displayName: '  De Postbode  ' }, 'profile').secondary).toBe('De Postbode')
    })
  })

  it('answers with one line where there is room for one', () => {
    // A browser tab title, a menu-bar item, a widget row. The other name is
    // dropped rather than appended: these already compete for a few characters.
    expect(botLabel(LANCE, 'profile')).toBe('lance-vance')
    expect(botLabel(LANCE, 'display')).toBe('Netwerkbeheerder')
  })

  describe('reading a stored order', () => {
    it('takes the two it knows', () => {
      expect(asNameOrder('profile')).toBe('profile')
      expect(asNameOrder('display')).toBe('display')
    })

    it('refuses anything else, so a caller falls back to its own default', () => {
      // It arrives from disk AND from a gateway another build wrote, so
      // "absent" and "nonsense" both have to mean "this reader has not chosen".
      for (const value of [undefined, null, '', 'handle', 1, {}, ['profile']]) {
        expect(asNameOrder(value)).toBeUndefined()
      }
    })
  })
})
