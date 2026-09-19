/**
 * What the Markdown renderer actually paints, with the real block component.
 */
import { act, render } from '@testing-library/react-native'
import { marked } from 'marked'

import { MarkdownBlock } from '../../src/markdown/Block'
import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import type { MarkdownContext } from '../../src/markdown/context'
import { highlightToLines, isKnownLanguage } from '../../src/markdown/highlight'
import { preprocessMarkdown } from '../../src/markdown/preprocess'
import { ThemeProvider } from '../../src/ui/theme'

const DOCUMENT = [
  '# Title',
  '',
  'Body with **bold**, *italic*, ~~struck~~ and `code`.',
  '',
  '- one',
  '  - nested',
  '',
  '1. first',
  '',
  '> quoted',
  '',
  '| Area | Status |',
  '| --- | --- |',
  '| Recovery | Shipped |',
  '',
  '---',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '[link](https://example.com/x)'
].join('\n')

const CONTEXT: MarkdownContext = {
  blockBackground: '#EEEEEE',
  borderColor: '#DDDDDD',
  color: 'text',
  fontSize: 17,
  lineHeight: 25,
  linkColor: '#0063CC',
  mutedColor: 'textMuted',
  mutedTextColor: '#5C5C65',
  onLinkPress: () => undefined,
  scheme: 'light',
  selectable: true,
  textColor: '#17171B'
}

describe('Markdown rendering', () => {
  beforeEach(resetBlockCache)

  it('renders every supported block kind', () => {
    const view = render(
      <ThemeProvider>
        <Markdown text={DOCUMENT} />
      </ThemeProvider>
    )

    expect(view.getByText('Title')).toBeTruthy()
    expect(view.getByText('quoted')).toBeTruthy()
    expect(view.getByText('nested')).toBeTruthy()
    expect(view.getByText('Recovery')).toBeTruthy()
    // The code block's language label.
    expect(view.getByText('TS')).toBeTruthy()
    expect(view.getByRole('link')).toBeTruthy()
  })

  it('opens a link through the injected handler', () => {
    const onLinkPress = jest.fn()

    const view = render(
      <ThemeProvider>
        <Markdown onLinkPress={onLinkPress} text="[link](https://example.com/x)" />
      </ThemeProvider>
    )

    act(() => {
      view.getByRole('link').props.onPress()
    })

    expect(onLinkPress).toHaveBeenCalledWith('https://example.com/x')
  })

  it('memoizes a block on its source text', () => {
    const lexer = jest.spyOn(marked, 'lexer')

    const view = render(
      <ThemeProvider>
        <MarkdownBlock context={CONTEXT} raw="Settled paragraph." />
      </ThemeProvider>
    )

    const afterFirst = lexer.mock.calls.length

    view.rerender(
      <ThemeProvider>
        <MarkdownBlock context={CONTEXT} raw="Settled paragraph." />
      </ThemeProvider>
    )

    expect(lexer.mock.calls.length).toBe(afterFirst)

    view.rerender(
      <ThemeProvider>
        <MarkdownBlock context={CONTEXT} raw="Settled paragraph. And more." />
      </ThemeProvider>
    )

    expect(lexer.mock.calls.length).toBeGreaterThan(afterFirst)

    lexer.mockRestore()
  })

  it('renders an unterminated fence as a code block while streaming', () => {
    const view = render(
      <ThemeProvider>
        <Markdown streaming text={'Here you go:\n\n```python\nprint("hi")'} />
      </ThemeProvider>
    )

    expect(view.getByText('PYTHON')).toBeTruthy()
  })
})

describe('preprocessMarkdown', () => {
  it('hides an unterminated reasoning block', () => {
    expect(preprocessMarkdown('<think>secret plan')).not.toContain('secret plan')
    expect(preprocessMarkdown('<think>secret</think>Visible.')).toContain('Visible.')
  })

  it('turns a MEDIA tag into a link', () => {
    expect(preprocessMarkdown('MEDIA:/srv/out/report.pdf')).toContain('[report.pdf](/srv/out/report.pdf)')
  })

  it('gives a table the blank line GFM needs', () => {
    const out = preprocessMarkdown('Intro line\n| a | b |\n| --- | --- |\n| 1 | 2 |')

    expect(out).toContain('Intro line\n\n| a | b |')
  })
})

describe('highlighting', () => {
  it('knows the registered languages and their aliases', () => {
    expect(isKnownLanguage('ts')).toBe(true)
    expect(isKnownLanguage('yml')).toBe(true)
    expect(isKnownLanguage('dockerfile')).toBe(true)
    expect(isKnownLanguage('brainfuck')).toBe(false)
  })

  it('returns scoped spans per line', () => {
    const lines = highlightToLines('const a = "x"\nlet b = 2', 'ts')

    expect(lines).toHaveLength(2)
    expect(lines[0]?.[0]).toEqual({ scope: 'keyword', text: 'const' })
    expect(
      lines
        .flat()
        .map(span => span.text)
        .join('')
    ).toBe('const a = "x"let b = 2')
  })

  it('degrades to plain text for an unknown language', () => {
    expect(highlightToLines('whatever', 'nope')).toEqual([[{ text: 'whatever' }]])
  })
})
