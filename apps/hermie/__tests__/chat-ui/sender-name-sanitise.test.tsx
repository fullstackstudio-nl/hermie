/**
 * HERM-83, D4: a sender's name is text another person or an identity provider
 * wrote, so it is cleaned ON READ, once, at the one place every rung passes
 * through (`senderLabel`), and the bubble, the chat-list preview, the export and
 * the screen-reader label all get the same cleaned name.
 *
 * `\s` does not match the bidi controls, the directional marks, the zero-width
 * space, the BOM or most C0/C1 controls, and a UTF-16 `slice` can cut a
 * surrogate pair in half. A colleague named "\u202Eetaged" therefore reversed
 * the chat-list line and every export line that led with it.
 */
import { screen } from '@testing-library/react-native'
import { chatRowPreview, createChatState, exportTranscript, reconcile, rowsToItems } from '@hermie/transcript'

import { formatChatPreview, senderLabel, TranscriptList, UserBubble } from '../../src/chat-ui'
import { userItem } from '../../src/chat-ui/fixtures'
import type { MessageAuthor, TranscriptItem, VisibleItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const ME = 'authentik:me'
const RLO = '\u202E'
const BIDI = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']
const MARKS = ['\u200E', '\u200F', '\u200B', '\uFEFF']
// A family: four people joined by ZERO WIDTH JOINER, which must survive.
const FAMILY = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'

const label = (name: string, id = 'authentik:colleague'): string => senderLabel({ id, name })

/** Whether any code point of `value` is half of a surrogate pair. */
const hasLoneSurrogate = (value: string): boolean =>
  Array.from(value).some(point => point.length === 1 && point.charCodeAt(0) >= 0xd800 && point.charCodeAt(0) <= 0xdfff)

describe('senderLabel, cleaning a sender name on read', () => {
  it('caps a 600-character name at 80 code points', () => {
    const cleaned = label('x'.repeat(600))

    expect(Array.from(cleaned)).toHaveLength(80)
  })

  it('flattens newlines, tabs and runs of spaces into one line', () => {
    expect(label('Robin\r\n\n  Vale\t\tWriter\u2028Two')).toBe('Robin Vale Writer Two')
  })

  it.each(BIDI.map(control => [control.codePointAt(0)?.toString(16), control]))(
    'strips the bidi control U+%s',
    (_code, control) => {
      expect(label(`${control}etaged${control}`)).toBe('etaged')
      expect(label(`Rob${control}in`)).toBe('Robin')
    }
  )

  it.each(MARKS.map(mark => [mark.codePointAt(0)?.toString(16), mark]))(
    'strips the directional mark, zero-width space or BOM U+%s',
    (_code, mark) => {
      expect(label(`${mark}Rob${mark}in${mark}`)).toBe('Robin')
    }
  )

  it('strips C0 and C1 controls, keeping the words they separated apart', () => {
    expect(label('Robin\u0000\u0007Vale\u001b[31m')).toBe('Robin Vale [31m')
    expect(label('Robin\u0085Vale\u009b')).toBe('Robin Vale')
  })

  it('never ends on half a surrogate pair when the cap lands inside one', () => {
    // 79 ASCII characters, then an astral emoji: a UTF-16 slice(0, 80) keeps
    // only its high surrogate.
    const cleaned = label(`${'x'.repeat(79)}\u{1F600}tail`)

    expect(cleaned).toBe(`${'x'.repeat(79)}\u{1F600}`)
    expect(hasLoneSurrogate(cleaned)).toBe(false)
    // And one code point later, the emoji is dropped whole, not halved.
    expect(label(`${'x'.repeat(80)}\u{1F600}`)).toBe('x'.repeat(80))
  })

  it('drops a lone surrogate that arrives in the name itself', () => {
    expect(label('Rob\uD83Din')).toBe('Robin')
    expect(label('Rob\uDE00in')).toBe('Robin')
  })

  it('keeps an emoji ZWJ sequence intact', () => {
    expect(label(`${FAMILY} Robin`)).toBe(`${FAMILY} Robin`)
  })

  it('falls to the identity when the stamped name is nothing but controls', () => {
    expect(label(`${RLO}\u200B\uFEFF\u0000`, 'authentik:7f3a')).toBe('7f3a')
  })

  it('cleans the identity rung too', () => {
    expect(senderLabel({ id: `authentik:${RLO}7f3a` })).toBe('7f3a')
  })

  it('cleans what a host directory answers (rung 1), and falls through when that cleans to nothing', () => {
    expect(senderLabel({ id: 'authentik:7f3a', name: 'Robin' }, () => `${RLO}Sam`)).toBe('Sam')
    expect(senderLabel({ id: 'authentik:7f3a', name: 'Robin' }, () => `${RLO}\u200E`)).toBe('Robin')
  })
})

describe('the same cleaned name everywhere it is shown', () => {
  const hostile: MessageAuthor = { id: 'authentik:colleague', name: `${RLO}etaged\nRobin` }

  it('in the bubble’s visible label', () => {
    const items: VisibleItem[] = [
      {
        item: { ...userItem, id: 'a', author: hostile } as TranscriptItem,
        presentation: 'full'
      }
    ]

    renderScreen(<TranscriptList groupChat items={items} ownAuthorId={ME} />)

    expect(screen.getByTestId('user-sender-name-a')).toHaveTextContent('etaged Robin', { exact: true })
  })

  it('in the bubble even when a host directory hands back an uncleaned name', () => {
    const items: VisibleItem[] = [
      { item: { ...userItem, id: 'a', author: hostile } as TranscriptItem, presentation: 'full' }
    ]

    renderScreen(
      <TranscriptList groupChat items={items} ownAuthorId={ME} resolveSenderName={() => `${RLO}Sam\u0000`} />
    )

    expect(screen.getByTestId('user-sender-name-a')).toHaveTextContent('Sam', { exact: true })
  })

  it('in the screen-reader label of a bubble that continues a run', () => {
    renderScreen(
      <UserBubble grouped item={userItem} own={false} sender={{ authorId: hostile.id, name: senderLabel(hostile) }} />
    )

    expect(screen.getByTestId(`user-sender-name-a11y-${userItem.id}`).props.accessibilityLabel).toBe('etaged Robin')
  })

  it('in the chat-list preview', () => {
    const chat = reconcile(
      createChatState('researcher', 'stored', 'resolved'),
      rowsToItems([{ role: 'user', row_id: 1, text: 'draft is ready', display_metadata: { author: hostile } }], 'rpc')
    )

    expect(
      formatChatPreview(chatRowPreview(chat, '', { groupChat: true, ownAuthorId: ME, resolveSenderName: senderLabel }))
    ).toBe('etaged Robin: draft is ready')
  })

  it('in the .txt and .md export lines', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 1, text: 'draft is ready', display_metadata: { author: hostile } }],
      'rpc'
    )
    const { markdown, text } = exportTranscript(items, {
      botName: 'researcher',
      groupChat: true,
      ownAuthorId: ME,
      resolveSenderName: senderLabel
    })

    expect(text).toContain('etaged Robin:')
    expect(markdown).toContain('**etaged Robin**')
    expect(text).not.toContain(RLO)
    expect(markdown).not.toContain(RLO)
  })
})
