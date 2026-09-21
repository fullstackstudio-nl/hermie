/**
 * Drawing a parsed expression.
 *
 * Two surfaces, one notation. Inline math is runs inside the sentence's own
 * `Text` (`linear.ts` says why it can be nothing else); block math is the same
 * runs, with boxes for the three constructs that genuinely need a second
 * dimension — a fraction, a root, and a big operator's limits.
 *
 * ## Every height here is arithmetic on the font size
 *
 * Nothing measures, nothing loads and nothing settles a frame later. That is the
 * requirement rather than an optimisation: a row on an INVERTED list that grows
 * after it is laid out moves the reader by exactly the growth, which is the
 * displacement `docs/platform-notes.md` measured for `Show more`. A fraction is
 * two leadings and a rule tall the moment it mounts, and stays that tall.
 *
 * ## The theme, not a palette
 *
 * Ink is `context.textColor` and the rules are `context.textColor` too rather
 * than the hairline: a fraction bar that is a border colour disappears against a
 * dark bubble, and the bar is part of the notation rather than part of the
 * furniture. Nothing here carries a colour of its own, so dark mode is whatever
 * the surrounding bubble already decided.
 */
import { Text, View } from 'react-native'

import { CodeBlock } from '../CodeBlock'
import { MONOSPACE, type MarkdownContext } from '../context'
import { mathRuns, type MathRun } from './linear'
import { parseMath, type MathNode, type MathStyle } from './parse'

/** The info string a fenced fallback carries, so the block says what it is. */
export const MATH_LANGUAGE = 'latex'

/** A script's size, as a fraction of the size it hangs off. */
const SCRIPT_SCALE = 0.72

/** How thick a fraction bar and a radical's overline are drawn. */
const RULE = 1

/** Air above and below a fraction bar, as a fraction of the font size. */
const FRACTION_GAP = 0.18

function textStyle(style: MathStyle, fontSize: number, color: string) {
  return {
    color,
    fontSize,
    ...(style === 'bold' ? { fontWeight: '700' as const } : {}),
    ...(style === 'italic' ? { fontStyle: 'italic' as const } : {}),
    ...(style === 'mono' ? { fontFamily: MONOSPACE } : {})
  }
}

/**
 * A row of runs as nested `Text`.
 *
 * One outer `Text` with the runs inside it, so a long expression wraps with the
 * sentence rather than becoming its own box — which is the same reason
 * `Inline.tsx` nests everything.
 */
export function MathRunsText({
  runs,
  context,
  fontSize
}: {
  runs: readonly MathRun[]
  context: MarkdownContext
  fontSize: number
}) {
  return (
    <>
      {runs.map((run, index) => (
        <Text key={index} style={textStyle(run.style, fontSize, context.textColor)}>
          {run.text}
        </Text>
      ))}
    </>
  )
}

/** Whether a node is one the block renderer opens out into boxes. */
function isTwoDimensional(node: MathNode): boolean {
  return (
    node.kind === 'frac' ||
    node.kind === 'sqrt' ||
    (node.kind === 'operator' && Boolean(node.upper ?? node.lower)) ||
    (node.kind === 'fenced' && containsTwoDimensional(node.body))
  )
}

function containsTwoDimensional(node: MathNode): boolean {
  if (node.kind === 'row') {
    return node.items.some(containsTwoDimensional)
  }

  return isTwoDimensional(node)
}

/**
 * A run of one-dimensional nodes, drawn as text.
 *
 * Grouped rather than emitted one at a time so that `2x + 1` is one `Text` and
 * therefore one line-breaking run: a `View` per atom in a flex row would let a
 * break land between the `2` and the `x`.
 */
function LinearSpan({ nodes, context, fontSize }: { nodes: MathNode[]; context: MarkdownContext; fontSize: number }) {
  const runs = mathRuns({ kind: 'row', items: nodes })

  if (!runs.length) {
    return null
  }

  return (
    <Text selectable={context.selectable} style={{ lineHeight: Math.round(fontSize * 1.3) }}>
      <MathRunsText context={context} fontSize={fontSize} runs={runs} />
    </Text>
  )
}

function Fraction({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'frac') {
    return null
  }

  const gap = Math.round(fontSize * FRACTION_GAP)

  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 2 }}>
      <View style={{ alignItems: 'center', paddingBottom: gap }}>
        <MathLayout context={context} fontSize={fontSize} node={node.numerator} />
      </View>
      {/*
        The bar spans the wider of the two sides, which `alignSelf: 'stretch'`
        gets for free from the column's own width — and costs no measurement.
      */}
      <View style={{ alignSelf: 'stretch', backgroundColor: context.textColor, height: RULE }} />
      <View style={{ alignItems: 'center', paddingTop: gap }}>
        <MathLayout context={context} fontSize={fontSize} node={node.denominator} />
      </View>
    </View>
  )
}

function Root({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'sqrt') {
    return null
  }

  const gap = Math.round(fontSize * 0.12)

  return (
    <View style={{ alignItems: 'flex-end', flexDirection: 'row' }}>
      {node.index ? (
        <View style={{ paddingBottom: Math.round(fontSize * 0.5) }}>
          <MathLayout context={context} fontSize={Math.round(fontSize * SCRIPT_SCALE)} node={node.index} />
        </View>
      ) : null}
      {/*
        The radical sign is a character and the overline is a border, because a
        `√` that had to stretch over two lines of a nested fraction would need a
        drawn path and a measurement — and the border already grows with
        whatever it sits over.
      */}
      <Text selectable={context.selectable} style={textStyle('roman', fontSize, context.textColor)}>
        {'√'}
      </Text>
      <View
        style={{
          borderTopColor: context.textColor,
          borderTopWidth: RULE,
          paddingHorizontal: 3,
          paddingTop: gap
        }}
      >
        <MathLayout context={context} fontSize={fontSize} node={node.radicand} />
      </View>
    </View>
  )
}

function BigOperator({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'operator') {
    return null
  }

  const limitSize = Math.round(fontSize * SCRIPT_SCALE)
  // Big enough to read as an operator rather than as a letter, which is what
  // the display style of every typesetter does with these.
  const symbolSize = Math.round(fontSize * 1.35)

  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 3 }}>
      {node.upper ? <MathLayout context={context} fontSize={limitSize} node={node.upper} /> : null}
      <Text selectable={context.selectable} style={textStyle('roman', symbolSize, context.textColor)}>
        {node.symbol}
      </Text>
      {node.lower ? <MathLayout context={context} fontSize={limitSize} node={node.lower} /> : null}
    </View>
  )
}

function Fenced({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  if (node.kind !== 'fenced') {
    return null
  }

  return (
    <View style={{ alignItems: 'center', flexDirection: 'row' }}>
      {node.open ? (
        <Text selectable={context.selectable} style={textStyle('roman', fontSize, context.textColor)}>
          {node.open}
        </Text>
      ) : null}
      <MathLayout context={context} fontSize={fontSize} node={node.body} />
      {node.close ? (
        <Text selectable={context.selectable} style={textStyle('roman', fontSize, context.textColor)}>
          {node.close}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * One sub-tree, as boxes where it needs them and as text where it does not.
 *
 * `alignItems: 'center'` is the axis rule: a fraction beside a variable lines up
 * on the middle of the bar, which is where every typesetter puts the maths axis,
 * and getting it from flexbox costs nothing and cannot drift.
 */
export function MathLayout({
  node,
  context,
  fontSize
}: {
  node: MathNode
  context: MarkdownContext
  fontSize: number
}) {
  const items = node.kind === 'row' ? node.items : [node]

  if (!items.some(containsTwoDimensional)) {
    return <LinearSpan context={context} fontSize={fontSize} nodes={items} />
  }

  // Adjacent one-dimensional nodes are collected into one span before the next
  // box, so line breaking still happens between words rather than between atoms.
  const groups: { boxes: MathNode | null; linear: MathNode[] }[] = []
  let pending: MathNode[] = []

  for (const item of items) {
    if (isTwoDimensional(item)) {
      groups.push({ boxes: item, linear: pending })
      pending = []

      continue
    }

    pending.push(item)
  }

  if (pending.length) {
    groups.push({ boxes: null, linear: pending })
  }

  return (
    <View style={{ alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap' }}>
      {groups.map((group, index) => (
        <View key={index} style={{ alignItems: 'center', flexDirection: 'row' }}>
          {group.linear.length ? <LinearSpan context={context} fontSize={fontSize} nodes={group.linear} /> : null}
          {group.boxes ? <Box context={context} fontSize={fontSize} node={group.boxes} /> : null}
        </View>
      ))}
    </View>
  )
}

function Box({ node, context, fontSize }: { node: MathNode; context: MarkdownContext; fontSize: number }) {
  switch (node.kind) {
    case 'frac':
      return <Fraction context={context} fontSize={fontSize} node={node} />

    case 'sqrt':
      return <Root context={context} fontSize={fontSize} node={node} />

    case 'operator':
      return <BigOperator context={context} fontSize={fontSize} node={node} />

    case 'fenced':
      return <Fenced context={context} fontSize={fontSize} node={node} />

    default:
      return <LinearSpan context={context} fontSize={fontSize} nodes={[node]} />
  }
}

/**
 * `$$…$$` — one expression on its own, centred.
 *
 * A failure is the SOURCE in a code block, never a blank and never a guess. The
 * reader gets what the model wrote, in a box they can already copy out of.
 */
export function BlockMath({ source, context }: { source: string; context: MarkdownContext }) {
  const node = parseMath(source)

  if (!node) {
    return <CodeBlock code={source.trim()} context={context} language={MATH_LANGUAGE} />
  }

  return (
    <View style={{ alignItems: 'center', marginVertical: 8, width: '100%' }} testID="markdown-math-block">
      <MathLayout context={context} fontSize={context.fontSize} node={node} />
    </View>
  )
}

/**
 * The runs for `$…$`, or `null` when the expression cannot be drawn.
 *
 * Runs rather than an element, because the caller is inside a `Text` and has to
 * nest them itself — and because the fallback it chooses is a code chip, which
 * is its own construct and not this module's business.
 */
export function inlineMathRuns(source: string): MathRun[] | null {
  const node = parseMath(source)

  return node ? mathRuns(node) : null
}
