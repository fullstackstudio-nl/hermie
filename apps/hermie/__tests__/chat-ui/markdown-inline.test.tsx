/**
 * Two inline bugs seen in real replies, pinned with the exact text that broke.
 *
 *   1. `** \`example.nl\` staat op autorenew=off**` rendered as literal
 *      asterisks. The lexer is right to do that — `**` followed by a space is
 *      not a left-flanking delimiter run, so it opens nothing and no `strong`
 *      token is ever emitted — so the repair belongs in `preprocess`.
 *   2. A wrapped inline-code span painted a background-coloured but EMPTY chip
 *      at the end of the previous line, because the chip's fake padding was an
 *      ASCII space and the line broke on it.
 *
 * Both are asserted on the rendered tree. A preprocessed string proves nothing
 * about what a reader sees, and "it renders" proves nothing at all.
 */
import { render } from '@testing-library/react-native'
import { marked } from 'marked'
import type { ReactElement } from 'react'
import { StyleSheet, type TextStyle } from 'react-native'
import type { Token } from 'marked'

import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import { MONOSPACE } from '../../src/markdown/context'
import { preprocessMarkdown, repairStrayEmphasisSpaces } from '../../src/markdown/preprocess'
import { ThemeProvider } from '../../src/ui/theme'
import { HAIRLINE, TINT_SUNK } from '../../src/ui/tokens'

/** The reply that started it, character for character. */
const AUTORENEW = '** `example.nl` staat op autorenew=off**'

interface RenderedNode {
  type: string
  props: { style?: unknown }
  children: (RenderedNode | string)[] | null
}

function descendants(node: RenderedNode | string | null): RenderedNode[] {
  if (!node || typeof node === 'string') {
    return []
  }

  return [node, ...(node.children ?? []).flatMap(descendants)]
}

function textOf(node: RenderedNode | string): string {
  if (typeof node === 'string') {
    return node
  }

  return (node.children ?? []).map(textOf).join('')
}

function styleOf(node: RenderedNode): TextStyle {
  return (StyleSheet.flatten(node.props.style as TextStyle) ?? {}) as TextStyle
}

function renderNodes(text: string): RenderedNode[] {
  const view = render(
    <ThemeProvider>
      <Markdown text={text} />
    </ThemeProvider>
  )

  return descendants(view.toJSON() as unknown as RenderedNode)
}

function boldNodes(nodes: RenderedNode[]): RenderedNode[] {
  return nodes.filter(node => styleOf(node).fontWeight === '700')
}

/** Every node painted as inline code: the chip style is the only marker. */
function codeNodes(nodes: RenderedNode[]): RenderedNode[] {
  return nodes.filter(node => styleOf(node).fontFamily === MONOSPACE && styleOf(node).backgroundColor !== undefined)
}

function hasStrong(tokens: Token[]): boolean {
  return tokens.some(token => token.type === 'strong' || hasStrong((token as { tokens?: Token[] }).tokens ?? []))
}

/** Is this text bold once it has been through the whole pipeline? */
function rendersBold(text: string): boolean {
  return hasStrong(marked.lexer(preprocessMarkdown(text)))
}

describe('bold a model opened with a stray space', () => {
  beforeEach(resetBlockCache)

  it('renders the autorenew reply bold, with its code chip intact', () => {
    const nodes = renderNodes(AUTORENEW)
    const bold = boldNodes(nodes)

    expect(bold).toHaveLength(1)

    const boldText = textOf(bold[0] as RenderedNode)

    expect(boldText).toContain('example.nl')
    expect(boldText).toContain('staat op autorenew=off')
    // The literal asterisks the reader used to see.
    expect(boldText).not.toContain('**')

    // The chip is INSIDE the bold span, not swallowed by it.
    const chips = codeNodes(descendants(bold[0] as RenderedNode))

    expect(chips).toHaveLength(1)
    expect(textOf(chips[0] as RenderedNode)).toContain('example.nl')
  })

  it('renders the mirror shape bold too', () => {
    const bold = boldNodes(renderNodes('**autorenew staat op off **'))

    expect(bold).toHaveLength(1)
    expect(textOf(bold[0] as RenderedNode)).toBe('autorenew staat op off')
  })

  it('leaves the arithmetic shape as literal asterisks', () => {
    const nodes = renderNodes('a ** b ** c')

    expect(boldNodes(nodes)).toHaveLength(0)
    expect(textOf(nodes[0] as RenderedNode)).toContain('a ** b ** c')
  })
})

/**
 * preprocess directly, so a future "simplification" trips on the conservative
 * cases rather than on a rendering nobody is looking at.
 */
describe('repairStrayEmphasisSpaces', () => {
  it('drops the space the opening delimiter was broken by', () => {
    expect(repairStrayEmphasisSpaces(AUTORENEW)).toBe('**`example.nl` staat op autorenew=off**')
    expect(repairStrayEmphasisSpaces('** bold**')).toBe('**bold**')
    expect(repairStrayEmphasisSpaces('**  two spaces**')).toBe('**two spaces**')
    expect(repairStrayEmphasisSpaces('__ under__')).toBe('__under__')
  })

  it('drops the space before a broken closing delimiter', () => {
    expect(repairStrayEmphasisSpaces('**bold **')).toBe('**bold**')
    expect(repairStrayEmphasisSpaces('__under __')).toBe('__under__')
  })

  it('repairs each pair on a line independently', () => {
    expect(repairStrayEmphasisSpaces('x ** y** z ** w**')).toBe('x **y** z **w**')
  })

  it('leaves both-ends-broken alone: arithmetic and literal asterisks', () => {
    expect(repairStrayEmphasisSpaces('a ** b ** c')).toBe('a ** b ** c')
    expect(repairStrayEmphasisSpaces('2 ** 3 ** 4')).toBe('2 ** 3 ** 4')
    expect(repairStrayEmphasisSpaces('** bold **')).toBe('** bold **')
    expect(repairStrayEmphasisSpaces('** `a` **')).toBe('** `a` **')
  })

  it('leaves a delimiter with no partner alone', () => {
    expect(repairStrayEmphasisSpaces('** lone')).toBe('** lone')
    expect(repairStrayEmphasisSpaces('ends on **')).toBe('ends on **')
    expect(repairStrayEmphasisSpaces('** one\ntwo **')).toBe('** one\ntwo **')
  })

  it('leaves a bold-italic run and a rule made of asterisks alone', () => {
    expect(repairStrayEmphasisSpaces('*** bold italic ***')).toBe('*** bold italic ***')
    expect(repairStrayEmphasisSpaces('***bold italic***')).toBe('***bold italic***')
    expect(repairStrayEmphasisSpaces('***')).toBe('***')
    expect(repairStrayEmphasisSpaces('* * *')).toBe('* * *')
    expect(repairStrayEmphasisSpaces('___')).toBe('___')
  })

  it('leaves list bullets alone', () => {
    expect(repairStrayEmphasisSpaces('* item\n* other')).toBe('* item\n* other')
    // A bullet whose CONTENT is broken bold is still repaired.
    expect(repairStrayEmphasisSpaces('- ** listed**')).toBe('- **listed**')
  })

  it('never produces a delimiter pair the lexer would still refuse', () => {
    // `see**(x)**` is not left-flanking either: punctuation after, word before.
    expect(repairStrayEmphasisSpaces('see** (x)**')).toBe('see** (x)**')
  })

  it('keeps its hands off inline code and fenced code', () => {
    expect(preprocessMarkdown('`** in code**`')).toBe('`** in code**`')
    expect(preprocessMarkdown('```\n** in fence**\n```')).toBe('```\n** in fence**\n```')
  })

  it('is idempotent', () => {
    for (const input of [AUTORENEW, '**bold **', 'a ** b ** c', '***bold italic***', '- ** listed**']) {
      const once = repairStrayEmphasisSpaces(input)

      expect(repairStrayEmphasisSpaces(once)).toBe(once)
    }
  })
})

/**
 * preprocess runs on the ACCUMULATED text on every flush, so the transform has
 * to settle a half-arrived run rather than flip it. Bold switching on and then
 * off again is the artefact a reader would actually notice.
 */
describe('streaming a stray-space bold', () => {
  function boldStates(text: string): boolean[] {
    return Array.from({ length: text.length }, (_, index) => rendersBold(text.slice(0, index + 1)))
  }

  function flipCount(states: boolean[]): number {
    return states.filter((state, index) => index > 0 && state !== states[index - 1]).length
  }

  it('turns the autorenew reply bold exactly once, at the closing delimiter', () => {
    const states = boldStates(AUTORENEW)

    expect(flipCount(states)).toBe(1)
    expect(states.at(-1)).toBe(true)
  })

  it('turns the mirror shape bold exactly once', () => {
    const states = boldStates('**bold ** and more')

    expect(flipCount(states)).toBe(1)
    expect(states.at(-1)).toBe(true)
  })

  it('never turns the arithmetic shape bold at all', () => {
    expect(boldStates('a ** b ** c').some(Boolean)).toBe(false)
  })
})

/**
 * The empty chip.
 *
 * A background-coloured nested `Text` paints every line fragment of its range,
 * and a fragment holding only the line's trailing whitespace is painted across
 * the whole remaining line width — which is the near-black bar the owner saw in
 * an incoming bubble. Line breaking itself cannot be exercised here (the test
 * renderer does no text layout), so what is asserted is the CAUSE: the chip must
 * contain no breakable and no collapsible whitespace at all.
 */
describe('inline code chips', () => {
  beforeEach(resetBlockCache)

  /** The sentence from the running Mac build that painted the bar. */
  const TESTMAIL = 'Ik zag een testmail van gisteren naar `test@example.com`. Dat is niets om je zorgen over te maken.'

  it('pads the chip with non-breaking spaces, never an ASCII one', () => {
    const chips = codeNodes(renderNodes(TESTMAIL))

    expect(chips).toHaveLength(1)
    expect(textOf(chips[0] as RenderedNode)).toBe('\u00a0test@example.com\u00a0')
  })

  it('leaves no whitespace a line break could strand inside a chip', () => {
    const inputs = [
      TESTMAIL,
      'A long sentence that has to wrap, with `a-rather-long-inline-code-span` near its end.',
      'Run `git commit --amend` again',
      'Spaced ``  padded  `` chip'
    ]

    for (const input of inputs) {
      const chips = codeNodes(renderNodes(input))

      expect(chips.length).toBeGreaterThan(0)

      for (const chip of chips) {
        const content = textOf(chip)

        // Every space is non-breaking, so no break can land on one and leave a
        // whitespace-only fragment behind. An ASCII space here is the bug.
        expect(content).not.toMatch(/[ \t]/)
        // The chip's own edges cannot break at all: it travels whole.
        expect(content.startsWith('\u00a0')).toBe(true)
        expect(content.endsWith('\u00a0')).toBe(true)
        // And it is never padding alone.
        expect(content.replace(/[\s\u200b]/g, '').length).toBeGreaterThan(0)
      }
    }
  })

  it('still lets a multi-word span wrap on its own word boundaries', () => {
    const chips = codeNodes(renderNodes('Run `git commit --amend` again'))

    expect(chips).toHaveLength(1)
    // A zero-width break IN FRONT of each gap: the wrap point paints nothing and
    // the gap travels with the word after it. That is the 6.3 wrap rule kept
    // without a breakable space.
    expect(textOf(chips[0] as RenderedNode)).toBe('\u00a0git\u200b\u00a0commit\u200b\u00a0--amend\u00a0')
  })

  it('treats whitespace at the edge of the code as padding, not a wrap point', () => {
    const chips = codeNodes(renderNodes('Spaced ``  padded  `` chip'))

    expect(chips).toHaveLength(1)

    const content = textOf(chips[0] as RenderedNode)

    expect(content).toContain('padded')
    expect(content).not.toContain('\u200b')
    expect(content.startsWith('\u00a0\u00a0')).toBe(true)
    expect(content.endsWith('\u00a0\u00a0')).toBe(true)
  })
})

/**
 * The chip's colour. It used to borrow the code-BLOCK surface, which the bubble
 * hands in as an opaque near-black in dark mode — a redaction bar through a
 * sentence rather than a code chip.
 */
describe('inline code chip colour', () => {
  beforeEach(resetBlockCache)

  function chipStyle(node: ReactElement): TextStyle {
    const nodes = descendants(render(<ThemeProvider>{node}</ThemeProvider>).toJSON() as unknown as RenderedNode)
    const chips = nodes.filter(candidate => styleOf(candidate).fontFamily === MONOSPACE)

    expect(chips).toHaveLength(1)

    return styleOf(chips[0] as RenderedNode)
  }

  it('defaults to the theme sunk tint, not the code-block surface', () => {
    const style = chipStyle(<Markdown text="a `chip` here" />)

    expect(Object.values(TINT_SUNK)).toContain(style.backgroundColor)
    expect(Object.values(HAIRLINE)).toContain(style.borderColor)
  })

  it('does not take the code-block surface a bubble passes in', () => {
    const style = chipStyle(<Markdown surface="#1B1B1F" text="a `chip` here" />)

    expect(style.backgroundColor).not.toBe('#1B1B1F')
    expect(Object.values(TINT_SUNK)).toContain(style.backgroundColor)
  })

  it('lets a caller override the chip colours per bubble', () => {
    const style = chipStyle(
      <Markdown inlineCodeBackground="rgba(1,2,3,0.1)" inlineCodeBorderColor="rgba(4,5,6,0.2)" text="a `chip` here" />
    )

    expect(style.backgroundColor).toBe('rgba(1,2,3,0.1)')
    expect(style.borderColor).toBe('rgba(4,5,6,0.2)')
  })

  it('keeps the chip text in the body colour and a monospace face', () => {
    const style = chipStyle(<Markdown text="a `chip` here" />)

    expect(style.fontFamily).toBe(MONOSPACE)
    expect(style.color).toBeTruthy()
  })
})
