# 0020. Diagrams and mathematics are drawn in the bundle, not in a web view

- Status: Accepted
- Date: 2026-09-22

## Context

Replies from a Hermes agent carry two things this renderer could not draw: ` ```mermaid `
fences and LaTeX between `$…$` or `$$…$$`. Both had been left as source — a diagram printed as its
own listing, an equation printed as `\frac{a}{b}` in the middle of a sentence.

The obvious answer is the real libraries. `mermaid` renders every diagram type there is, and KaTeX
typesets all of LaTeX's mathematics. Neither survives the trip intact:

- **`mermaid` needs a DOM.** It is ~2.8 MB of JavaScript that measures text with `getBBox` and
  builds an SVG document. On the web that is fine; on iOS and Android the only DOM available is a
  `WebView`, which means a native view per diagram, a page load per diagram, and — the part that
  decides this — a content height that is only known **after** the page has laid out.
- **KaTeX needs fonts.** Four bundled faces, loaded asynchronously, with the metrics that position
  every glyph coming from a table that assumes them. An expression laid out before the fonts arrive
  is a different size from the same expression after.

Both failure modes are the same failure mode, and this app has already measured what it costs. The
transcript is an **inverted** list: a row that changes height after it is laid out moves everything
the reader is looking at by exactly the change. `docs/platform-notes.md` has the table for
`Show more` — a body grown by 300pt displaces the rows below it by 300pt, every time, at every
starting offset. A diagram that settles two frames after it mounts does the same thing, with nobody
having touched anything.

There is also a security question, which is smaller than it looks but is worth writing down.
Mermaid's own answer to "a diagram's labels are untrusted text" is `securityLevel: 'strict'`, which
exists because its renderer can otherwise be made to emit markup and follow links out of a label.
Message content in this app is untrusted by definition: it is whatever a model wrote, which is in
turn whatever a tool read off a disk or a web page.

Three options were considered.

1. **The real libraries, in a `WebView` on native and inline on the web.** Correct for every diagram
   and every expression. Costs an asynchronous height on the one list that cannot absorb one, a
   native view per diagram, a sandbox to get right, and two rendering paths that will drift.
2. **The real libraries everywhere, with the height pre-declared.** Removes the displacement by
   fixing the box, which means guessing the aspect ratio and either letterboxing every diagram or
   clipping some of them.
3. **Parse and draw a subset in the bundle.** `react-native-svg` is already shipped for the icons and
   the bubble tails. A diagram whose geometry is computed from the label text has its final size
   before it mounts, on every platform, with one code path.

## Decision

**We draw a subset ourselves, synchronously, and fall back to the source for everything else.**

- **Mermaid**: `flowchart` and `graph`, all four directions, the seven common node shapes, and
  solid / dotted / thick edges with labels. Parsed by `markdown/mermaid/parse.ts`, laid out as a
  layered drawing by `layout.ts`, drawn with `react-native-svg`. Labels are real `Text` positioned
  over the drawing rather than SVG text, so they are selectable and reach a screen reader.
- **Mathematics**: `$…$` and `$$…$$` become real lexer tokens (`markdown/math/marked-math.ts`) so
  `a_i` stops opening emphasis. The expression is parsed to a small tree and resolved against a
  Unicode symbol table. A block gets boxes for the three constructs that need a second dimension — a
  fraction, a root, a big operator's limits — and everything else, inline included, is set on one
  line with Unicode superscripts and subscripts.
- **Anything outside the subset answers `null`, and `null` means the SOURCE**, in a code block for a
  fence or a block expression and in a code chip for an inline one. A `sequenceDiagram`, a
  `subgraph`, `\begin{matrix}`, a half-streamed fence: all of them show the reader exactly what the
  model wrote.

## Consequences

**What this buys.**

- Every height is arithmetic on the font size. Nothing measures, nothing loads, nothing settles a
  frame later, so the inverted list never moves under the reader — which was the whole reason to
  decide this rather than reach for the obvious library.
- One code path on all four targets. There is no `.web.ts` half of this and no second renderer to
  keep in step.
- There is nothing to sandbox. No script engine, no navigation, no HTML: a label is characters in a
  `Text` and an `<a>` inside one is the literal characters somebody typed. `securityLevel: 'strict'`
  has no equivalent here because it has no equivalent problem.
- Nothing was added to the bundle. `react-native-svg` and `marked` were both already in it.

**What this costs, stated plainly.**

- **The subset is a subset.** A `sequenceDiagram` is a listing, not a picture. `\begin{align}` is a
  listing. A `subgraph` makes the whole diagram a listing rather than drawing it without the
  grouping — refusing is deliberate, because a picture that quietly leaves out what the author asked
  for is worse than the source.
- **Inline mathematics is set on one line.** `$\frac{a}{b}$` is `a/b`, not a stacked fraction, and it
  cannot be otherwise: React Native will not lay a `View` out inside a `Text` on Android, so an
  expression that lives inside a sentence cannot have boxes at all. Brackets are added wherever the
  extent would otherwise be ambiguous.
- **A superscript that Unicode cannot reach is spelled rather than raised.** `x^{\alpha}` comes out
  as `x^(α)`. Drawing it as a smaller run on the baseline — what a naive nested `Text` produces —
  would read as a _subscript_, which says the wrong thing.
- **An unknown LaTeX command fails the whole expression.** That is the point: dropping it would
  silently change what the mathematics says.
- **Widening the subset is our work now**, and every diagram type somebody wants is a parser, a
  layout and a renderer rather than a version bump. The fallback is what makes that acceptable:
  until the work is done, the reader loses a picture and keeps the text.

If the subset ever stops being enough, the replacement is option 2 rather than option 1 — a real
renderer with the box size declared up front — because the displacement, not the bundle, is the
thing this record is about.
