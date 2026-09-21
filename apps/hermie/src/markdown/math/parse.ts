/**
 * A LaTeX subset → a tree the renderer can lay out, or `null`.
 *
 * ## Why a subset, and why `null` rather than a best effort
 *
 * KaTeX parses all of LaTeX's mathematics and draws it from bundled fonts.
 * Neither half of that survives the trip to a phone: the fonts are assets that
 * load asynchronously, and an expression whose metrics arrive a frame late
 * changes its row's height on an INVERTED list, which moves the reader by
 * exactly the correction. ADR-0020 has the measurement and the decision.
 *
 * So this parser covers what a chat agent actually writes — symbols, scripts,
 * fractions, roots, the big operators with their limits — and answers `null` for
 * everything else. `null` is the whole design: the caller shows the LaTeX source
 * in a code block, which is honest, copyable and correct. Dropping an unknown
 * command would silently change what the mathematics SAYS, and a renderer that
 * quietly says something else is worse than one that admits it cannot draw.
 *
 * ## Pure, and total
 *
 * No React, no theme, no platform, and it never throws — a malformed expression
 * is a `null`, including a half-typed one, because this runs on every flush of a
 * streaming reply and the text is a prefix of an expression more often than it is
 * an expression.
 */
import { ACCENTS, BIG_OPERATORS, DELIMITERS, FONT_COMMANDS, FUNCTION_NAMES, SPACING, SYMBOLS } from './symbols'

/** How a run of characters is set. `italic` is the default for a variable. */
export type MathStyle = 'italic' | 'roman' | 'bold' | 'mono'

export type MathNode =
  /** One run of characters, already resolved from whatever wrote it. */
  | { kind: 'run'; text: string; style: MathStyle }
  /** A horizontal sequence. Always present at the top, even for one atom. */
  | { kind: 'row'; items: MathNode[] }
  /** A base with a superscript, a subscript, or both. */
  | { kind: 'scripts'; base: MathNode; sup?: MathNode; sub?: MathNode }
  /**
   * A big operator with its limits.
   *
   * Separate from `scripts` because the limits go UNDER and OVER in display
   * style and beside the glyph inline — one node, two layouts, decided by the
   * renderer rather than by the parser.
   */
  | { kind: 'operator'; symbol: string; upper?: MathNode; lower?: MathNode }
  | { kind: 'frac'; numerator: MathNode; denominator: MathNode }
  | { kind: 'sqrt'; radicand: MathNode; index?: MathNode }
  /** A group inside delimiters that grow with their contents. */
  | { kind: 'fenced'; open: string; close: string; body: MathNode }
  /** A character combined onto the last glyph of its base. */
  | { kind: 'accent'; base: MathNode; combining: string }
  /** Horizontal space, in multiples of a thin space. */
  | { kind: 'space' }

/**
 * The longest expression this will look at.
 *
 * A guard rather than a limit anybody should reach: the parser is linear, but it
 * runs on every flush of a streaming reply, and a model that opens `$$` and then
 * writes a thousand lines of prose would otherwise be re-parsed on each one.
 */
const MAX_LENGTH = 4000

/** Nesting deeper than this is a runaway rather than an expression. */
const MAX_DEPTH = 24

type Atom =
  | { type: 'char'; value: string }
  | { type: 'command'; name: string }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'sup' }
  | { type: 'sub' }
  | { type: 'ampersand' }

/**
 * Characters that end a command name.
 *
 * A LaTeX control word is a backslash and letters; a control SYMBOL is a
 * backslash and exactly one non-letter, which is how `\{`, `\\` and `\,` are
 * spelled.
 */
const LETTER_RE = /[A-Za-z]/
const DIGIT_RE = /[0-9]/

function tokenize(source: string): Atom[] | null {
  const atoms: Atom[] = []
  let at = 0

  while (at < source.length) {
    const char = source[at] as string

    if (char === '\\') {
      const next = source[at + 1]

      if (next === undefined) {
        // A trailing backslash is a half-typed command, which a streaming reply
        // produces constantly. Not renderable yet.
        return null
      }

      if (!LETTER_RE.test(next)) {
        atoms.push({ type: 'command', name: next })
        at += 2

        continue
      }

      let end = at + 1

      while (end < source.length && LETTER_RE.test(source[end] as string)) {
        end += 1
      }

      atoms.push({ type: 'command', name: source.slice(at + 1, end) })
      at = end

      continue
    }

    if (char === '{') {
      atoms.push({ type: 'open' })
      at += 1

      continue
    }

    if (char === '}') {
      atoms.push({ type: 'close' })
      at += 1

      continue
    }

    if (char === '^') {
      atoms.push({ type: 'sup' })
      at += 1

      continue
    }

    if (char === '_') {
      atoms.push({ type: 'sub' })
      at += 1

      continue
    }

    if (char === '&') {
      atoms.push({ type: 'ampersand' })
      at += 1

      continue
    }

    if (char === '%' || char === '#' || char === '$') {
      // `%` starts a comment and `#` is a macro parameter; neither belongs in a
      // chat message, and `$` inside math means the delimiters were mismatched.
      return null
    }

    atoms.push({ type: 'char', value: char })
    at += 1
  }

  return atoms
}

class Parser {
  private at = 0

  constructor(private readonly atoms: Atom[]) {}

  /** The whole input as one row, or `null` if anything in it is unknown. */
  parse(): MathNode | null {
    const row = this.row(0)

    if (row === null || this.at !== this.atoms.length) {
      // Trailing atoms mean an unmatched `}` — the group parser stopped early.
      return null
    }

    return row
  }

  /** Everything up to the end of the input or the next unconsumed `}`. */
  private row(depth: number): MathNode | null {
    if (depth > MAX_DEPTH) {
      return null
    }

    const items: MathNode[] = []

    while (this.at < this.atoms.length) {
      const atom = this.atoms[this.at] as Atom

      if (atom.type === 'close') {
        break
      }

      const node = this.atomOrScripts(depth)

      if (node === null) {
        return null
      }

      items.push(node)
    }

    return { kind: 'row', items: merged(items) }
  }

  /**
   * One atom, plus any scripts hanging off it.
   *
   * Both orders are accepted — `x_i^2` and `x^2_i` mean the same thing — and a
   * repeated script (`x^2^3`) is a genuine LaTeX error rather than something to
   * guess at, so it is a `null`.
   */
  private atomOrScripts(depth: number): MathNode | null {
    const base = this.atom(depth)

    if (base === null) {
      return null
    }

    let sup: MathNode | undefined
    let sub: MathNode | undefined

    for (;;) {
      const atom = this.atoms[this.at]

      if (atom?.type === 'sup') {
        if (sup) {
          return null
        }

        this.at += 1
        const parsed = this.atom(depth + 1)

        if (parsed === null) {
          return null
        }

        sup = parsed

        continue
      }

      if (atom?.type === 'sub') {
        if (sub) {
          return null
        }

        this.at += 1
        const parsed = this.atom(depth + 1)

        if (parsed === null) {
          return null
        }

        sub = parsed

        continue
      }

      break
    }

    if (!sup && !sub) {
      return base
    }

    // A big operator keeps its own node so the renderer can put the limits
    // under and over it rather than beside it.
    if (base.kind === 'operator') {
      return {
        kind: 'operator',
        symbol: base.symbol,
        ...(sup ? { upper: sup } : {}),
        ...(sub ? { lower: sub } : {})
      }
    }

    return { kind: 'scripts', base, ...(sup ? { sup } : {}), ...(sub ? { sub } : {}) }
  }

  /** A group, a command, or a single character. */
  private atom(depth: number): MathNode | null {
    if (depth > MAX_DEPTH) {
      return null
    }

    const atom = this.atoms[this.at]

    if (!atom) {
      // A script with nothing after it: `x^`. Half-typed rather than wrong.
      return null
    }

    if (atom.type === 'open') {
      this.at += 1
      const body = this.row(depth + 1)

      if (body === null || this.atoms[this.at]?.type !== 'close') {
        return null
      }

      this.at += 1

      return body
    }

    if (atom.type === 'close' || atom.type === 'sup' || atom.type === 'sub' || atom.type === 'ampersand') {
      // `&` is an alignment tab, which only means anything inside an
      // environment; this parser has none, so it is not renderable.
      return null
    }

    if (atom.type === 'char') {
      this.at += 1

      return { kind: 'run', text: atom.value, style: styleOf(atom.value) }
    }

    return this.command(atom.name, depth)
  }

  private command(name: string, depth: number): MathNode | null {
    this.at += 1

    if (SPACING.has(name)) {
      return { kind: 'space' }
    }

    const symbol = SYMBOLS[name]

    if (symbol !== undefined) {
      return { kind: 'run', text: symbol, style: 'roman' }
    }

    const big = BIG_OPERATORS[name]

    if (big !== undefined) {
      return { kind: 'operator', symbol: big }
    }

    if (FUNCTION_NAMES.has(name)) {
      return { kind: 'run', text: name, style: 'roman' }
    }

    const font = FONT_COMMANDS[name]

    if (font !== undefined) {
      const body = this.atom(depth + 1)

      return body === null ? null : restyle(body, font)
    }

    const accent = ACCENTS[name]

    if (accent !== undefined) {
      const body = this.atom(depth + 1)

      return body === null ? null : { kind: 'accent', base: body, combining: accent }
    }

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const numerator = this.atom(depth + 1)
      const denominator = numerator === null ? null : this.atom(depth + 1)

      return numerator === null || denominator === null ? null : { kind: 'frac', numerator, denominator }
    }

    if (name === 'sqrt') {
      const index = this.optionalArgument(depth)

      if (index === null) {
        return null
      }

      const radicand = this.atom(depth + 1)

      return radicand === null ? null : { kind: 'sqrt', radicand, ...(index ? { index } : {}) }
    }

    if (name === 'left') {
      return this.fenced(depth)
    }

    // A `\right` reached here has no `\left`, which is a genuine error.
    if (name === 'right') {
      return null
    }

    const delimiter = DELIMITERS[name]

    if (delimiter !== undefined) {
      return { kind: 'run', text: delimiter, style: 'roman' }
    }

    // `\\` is a line break, and this renderer draws one line. An expression that
    // wanted two is an environment in disguise, so it falls back whole rather
    // than being run together on one line.
    return null
  }

  /**
   * `\sqrt[3]{x}` — the one optional argument in the supported subset.
   *
   * Three answers, which is why it is not a `MathNode | null`: a node when there
   * was one, `undefined` when there was no bracket, and `null` when a bracket
   * opened and did not close.
   */
  private optionalArgument(depth: number): MathNode | null | undefined {
    const atom = this.atoms[this.at]

    if (atom?.type !== 'char' || atom.value !== '[') {
      return undefined
    }

    this.at += 1
    const items: MathNode[] = []

    for (;;) {
      const next = this.atoms[this.at]

      if (!next) {
        return null
      }

      if (next.type === 'char' && next.value === ']') {
        this.at += 1

        return { kind: 'row', items: merged(items) }
      }

      const node = this.atomOrScripts(depth + 1)

      if (node === null) {
        return null
      }

      items.push(node)
    }
  }

  /** `\left( … \right)`, with the two delimiters the pair names. */
  private fenced(depth: number): MathNode | null {
    const open = this.delimiter()

    if (open === null) {
      return null
    }

    const body = this.row(depth + 1)

    if (body === null) {
      return null
    }

    const closer = this.atoms[this.at]

    if (closer?.type !== 'command' || closer.name !== 'right') {
      return null
    }

    this.at += 1
    const close = this.delimiter()

    return close === null ? null : { kind: 'fenced', open, close, body }
  }

  /** The delimiter after a `\left` or a `\right`, as the character it draws. */
  private delimiter(): string | null {
    const atom = this.atoms[this.at]

    if (!atom) {
      return null
    }

    if (atom.type === 'char') {
      if (!'()[]|./'.includes(atom.value)) {
        return null
      }

      this.at += 1

      return atom.value === '.' ? '' : atom.value
    }

    if (atom.type === 'command') {
      const delimiter = DELIMITERS[atom.name]

      if (delimiter === undefined) {
        return null
      }

      this.at += 1

      return delimiter
    }

    if (atom.type === 'open') {
      this.at += 1

      return '{'
    }

    if (atom.type === 'close') {
      this.at += 1

      return '}'
    }

    return null
  }
}

/**
 * How one character is set when nothing said otherwise.
 *
 * A letter is a variable and variables are italic; a digit, an operator and a
 * bracket are not. That is the one typographic rule in mathematics that carries
 * meaning rather than style, which is why it is applied at the character and not
 * left to the renderer.
 */
function styleOf(char: string): MathStyle {
  return LETTER_RE.test(char) ? 'italic' : 'roman'
}

/**
 * Glue adjacent runs of the same style into one.
 *
 * `12.5` is five atoms out of the tokenizer and one run out of here, which
 * matters for more than tidiness: the renderer emits a `Text` per run, and a
 * number split into five of them can have a line break inserted between any two
 * of its digits.
 */
function merged(items: MathNode[]): MathNode[] {
  const out: MathNode[] = []

  for (const item of items) {
    const last = out[out.length - 1]

    if (last && last.kind === 'run' && item.kind === 'run' && last.style === item.style) {
      out[out.length - 1] = { kind: 'run', style: last.style, text: last.text + item.text }

      continue
    }

    out.push(item)
  }

  return out
}

/** Set a whole sub-tree in one style, for `\mathrm` and its family. */
function restyle(node: MathNode, style: MathStyle): MathNode {
  switch (node.kind) {
    case 'run':
      return { kind: 'run', style, text: node.text }

    case 'row':
      return { kind: 'row', items: merged(node.items.map(item => restyle(item, style))) }

    default:
      // A fraction inside `\mathbf` is a fraction; the style applies to the
      // characters it reaches, and reaching further than that is not worth a
      // second traversal of every node kind.
      return node
  }
}

/**
 * Parse one expression, or answer `null` when it cannot be drawn.
 *
 * `null` means "show the source", never "show nothing". Every caller in this
 * folder treats it that way and the tests pin that they do.
 */
export function parseMath(source: string): MathNode | null {
  const trimmed = source.trim()

  if (!trimmed || trimmed.length > MAX_LENGTH) {
    return null
  }

  const atoms = tokenize(trimmed)

  if (!atoms || !atoms.length) {
    return null
  }

  const node = new Parser(atoms).parse()

  // An empty row is `{}` or whitespace: nothing to draw, so nothing to claim.
  return node && node.kind === 'row' && !node.items.length ? null : node
}

/**
 * Whether a character is a digit, for the renderer's spacing rule.
 *
 * Exported so the renderer does not keep a second copy of the same test.
 */
export function isDigit(char: string): boolean {
  return DIGIT_RE.test(char)
}
