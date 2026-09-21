/**
 * A parsed expression → styled runs on ONE line.
 *
 * This is how inline math is drawn, and how the two-dimensional renderer draws
 * everything except the three constructs that genuinely need a second dimension
 * (a fraction, a root, and a big operator's limits). ADR-0020 states the rule and
 * the reason: an inline expression has to live inside the sentence's `Text`, and
 * React Native will not lay a `View` out inside one on Android — so a construct
 * that needs boxes cannot be inline at all, and inventing a different
 * presentation for the same expression depending on where it sits would mean a
 * reader who moved `$x^2$` into `$$…$$` saw two different notations.
 *
 * ## Scripts are Unicode where Unicode has them
 *
 * `x^2` is `x²`: one character, correct at any size, selectable, and impossible
 * to misread. Unicode's superscript and subscript blocks cover the digits, the
 * arithmetic signs, the brackets and most of the Latin letters, which is very
 * nearly everything a script in a chat message contains.
 *
 * Where it does not reach — `x^{n+1}` has a `+`, which it does, but `x^{\alpha}`
 * does not — the run falls back to the LaTeX spelling with brackets that make the
 * extent explicit: `x^(α)`. Deliberately not a smaller font on the baseline,
 * which is what a naive nested `Text` produces: `x` followed by a small `α`
 * sitting on the same baseline reads as a subscript, so a superscript drawn that
 * way says the wrong thing.
 */
import type { MathNode, MathStyle } from './parse'

/** One run of characters, ready for a `Text`. */
export interface MathRun {
  text: string
  style: MathStyle
}

/** U+2009 THIN SPACE: what every `\,`-family command comes out as. */
const THIN_SPACE = ' '

const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
  f: 'ᶠ',
  g: 'ᵍ',
  h: 'ʰ',
  i: 'ⁱ',
  j: 'ʲ',
  k: 'ᵏ',
  l: 'ˡ',
  m: 'ᵐ',
  n: 'ⁿ',
  o: 'ᵒ',
  p: 'ᵖ',
  r: 'ʳ',
  s: 'ˢ',
  t: 'ᵗ',
  u: 'ᵘ',
  v: 'ᵛ',
  w: 'ʷ',
  x: 'ˣ',
  y: 'ʸ',
  z: 'ᶻ',
  A: 'ᴬ',
  B: 'ᴮ',
  D: 'ᴰ',
  E: 'ᴱ',
  G: 'ᴳ',
  H: 'ᴴ',
  I: 'ᴵ',
  J: 'ᴶ',
  K: 'ᴷ',
  L: 'ᴸ',
  M: 'ᴹ',
  N: 'ᴺ',
  O: 'ᴼ',
  P: 'ᴾ',
  R: 'ᴿ',
  T: 'ᵀ',
  U: 'ᵁ',
  V: 'ⱽ',
  W: 'ᵂ',
  '·': '˙',
  '⊤': 'ᵀ'
}

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ'
}

/** The characters of a sub-tree, with nothing about how they are set. */
export function mathToPlainText(node: MathNode): string {
  switch (node.kind) {
    case 'run':
      return node.text

    case 'row':
      return node.items.map(mathToPlainText).join('')

    case 'space':
      return THIN_SPACE

    case 'scripts':
      return (
        mathToPlainText(node.base) +
        (node.sub ? `_${braced(mathToPlainText(node.sub))}` : '') +
        (node.sup ? `^${braced(mathToPlainText(node.sup))}` : '')
      )

    case 'operator':
      return (
        node.symbol +
        (node.lower ? `_${braced(mathToPlainText(node.lower))}` : '') +
        (node.upper ? `^${braced(mathToPlainText(node.upper))}` : '')
      )

    case 'frac':
      return `${parenthesised(node.numerator)}/${parenthesised(node.denominator)}`

    case 'sqrt':
      return `√(${mathToPlainText(node.radicand)})`

    case 'fenced':
      return node.open + mathToPlainText(node.body) + node.close

    case 'accent':
      return mathToPlainText(node.base) + node.combining
  }
}

/** Brackets only where the extent is not already one character. */
function braced(text: string): string {
  return [...text].length > 1 ? `(${text})` : text
}

function parenthesised(node: MathNode): string {
  const text = mathToPlainText(node)

  return [...text].length > 1 ? `(${text})` : text
}

/**
 * One sub-tree's characters translated into the superscript or subscript block,
 * or `null` when even one of them has no such form.
 *
 * All or nothing on purpose: half a script raised and half of it on the baseline
 * is not a smaller notation, it is a wrong one.
 */
function shifted(node: MathNode, table: Record<string, string>): string | null {
  const text = mathToPlainText(node)
  let out = ''

  for (const char of text) {
    const mapped = table[char]

    if (mapped === undefined) {
      return null
    }

    out += mapped
  }

  return out
}

/** The superscript form of a sub-tree, or `null`. */
export function superscriptOf(node: MathNode): string | null {
  return shifted(node, SUPERSCRIPTS)
}

/** The subscript form of a sub-tree, or `null`. */
export function subscriptOf(node: MathNode): string | null {
  return shifted(node, SUBSCRIPTS)
}

function push(runs: MathRun[], text: string, style: MathStyle): void {
  if (!text) {
    return
  }

  const last = runs[runs.length - 1]

  if (last && last.style === style) {
    last.text += text

    return
  }

  runs.push({ style, text })
}

/**
 * Flatten a sub-tree into runs for one line.
 *
 * `twoDimensional` names the constructs the caller will draw with boxes instead;
 * an inline caller passes nothing and gets the whole expression on one line.
 */
function walk(node: MathNode, runs: MathRun[]): void {
  switch (node.kind) {
    case 'run':
      push(runs, node.text, node.style)

      return

    case 'row':
      for (const item of node.items) {
        walk(item, runs)
      }

      return

    case 'space':
      push(runs, THIN_SPACE, 'roman')

      return

    case 'accent':
      walk(node.base, runs)
      // A combining character binds to the glyph before it, so it is appended to
      // whatever run the base ended in rather than opening one of its own.
      push(runs, node.combining, runs[runs.length - 1]?.style ?? 'roman')

      return

    case 'fenced':
      push(runs, node.open, 'roman')
      walk(node.body, runs)
      push(runs, node.close, 'roman')

      return

    case 'sqrt':
      if (node.index) {
        const index = superscriptOf(node.index)

        push(runs, index ?? `[${mathToPlainText(node.index)}]`, 'roman')
      }

      push(runs, '√(', 'roman')
      walk(node.radicand, runs)
      push(runs, ')', 'roman')

      return

    case 'frac': {
      const numerator: MathRun[] = []
      const denominator: MathRun[] = []

      walk(node.numerator, numerator)
      walk(node.denominator, denominator)

      // Brackets whenever the side is more than one character: `a+b/c` and
      // `(a+b)/c` are different numbers, and the reader cannot see the fraction
      // bar that would have said which one this is.
      appendGrouped(runs, numerator)
      push(runs, '/', 'roman')
      appendGrouped(runs, denominator)

      return
    }

    case 'scripts': {
      walk(node.base, runs)

      if (node.sub) {
        const sub = subscriptOf(node.sub)

        if (sub === null) {
          push(runs, `_${braced(mathToPlainText(node.sub))}`, 'roman')
        } else {
          push(runs, sub, 'roman')
        }
      }

      if (node.sup) {
        const sup = superscriptOf(node.sup)

        if (sup === null) {
          push(runs, `^${braced(mathToPlainText(node.sup))}`, 'roman')
        } else {
          push(runs, sup, 'roman')
        }
      }

      return
    }

    case 'operator': {
      push(runs, node.symbol, 'roman')

      if (node.lower) {
        const lower = subscriptOf(node.lower)

        push(runs, lower ?? `_${braced(mathToPlainText(node.lower))}`, 'roman')
      }

      if (node.upper) {
        const upper = superscriptOf(node.upper)

        push(runs, upper ?? `^${braced(mathToPlainText(node.upper))}`, 'roman')
      }

      return
    }
  }
}

function appendGrouped(runs: MathRun[], side: MathRun[]): void {
  const characters = side.reduce((total, run) => total + [...run.text].length, 0)
  const wrap = characters > 1

  if (wrap) {
    push(runs, '(', 'roman')
  }

  for (const run of side) {
    push(runs, run.text, run.style)
  }

  if (wrap) {
    push(runs, ')', 'roman')
  }
}

/** Every run in one expression, in reading order. */
export function mathRuns(node: MathNode): MathRun[] {
  const runs: MathRun[] = []

  walk(node, runs)

  return runs
}
