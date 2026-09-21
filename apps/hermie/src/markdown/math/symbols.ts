/**
 * The LaTeX commands this renderer knows, as the characters they stand for.
 *
 * A table rather than a font. KaTeX draws its symbols from four bundled font
 * faces; shipping those to a phone costs a megabyte of assets and a font-loading
 * state the inverted list would have to survive — see ADR-0020. Unicode already
 * carries every glyph a chat agent actually writes, and the platform's own body
 * face already has them, so a command is resolved to a character and drawn like
 * any other character.
 *
 * The consequence is stated plainly because it is real: a command that is NOT in
 * this table makes the whole expression unrenderable, and the block falls back to
 * its source. That is deliberate. Dropping an unknown command would silently
 * change what the mathematics says, and printing it literally would put
 * `\mathbb` in the middle of an equation — both are worse than showing the reader
 * the LaTeX the model wrote.
 */

/** Greek, which is most of what a model writes. */
const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω'
}

/** Relations, operators and the arrows that show up in a derivation. */
const OPERATORS: Record<string, string> = {
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  cdot: '·',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  vdots: '⋮',
  ddots: '⋱',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '∙',
  oplus: '⊕',
  ominus: '⊖',
  otimes: '⊗',
  odot: '⊙',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  equiv: '≡',
  approx: '≈',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  propto: '∝',
  ll: '≪',
  gg: '≫',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  in: '∈',
  notin: '∉',
  ni: '∋',
  cup: '∪',
  cap: '∩',
  setminus: '∖',
  emptyset: '∅',
  varnothing: '∅',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  neg: '¬',
  lnot: '¬',
  land: '∧',
  wedge: '∧',
  lor: '∨',
  vee: '∨',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  therefore: '∴',
  because: '∵',
  degree: '°',
  prime: '′',
  hbar: 'ℏ',
  ell: 'ℓ',
  Re: 'ℜ',
  Im: 'ℑ',
  aleph: 'ℵ'
}

/** Arrows, which a model uses for limits and for derivations alike. */
const ARROWS: Record<string, string> = {
  to: '→',
  rightarrow: '→',
  Rightarrow: '⇒',
  leftarrow: '←',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  longrightarrow: '⟶',
  longleftarrow: '⟵',
  mapsto: '↦',
  uparrow: '↑',
  downarrow: '↓',
  implies: '⟹',
  iff: '⟺'
}

/**
 * The big operators, which take limits above and below in display style.
 *
 * Listed separately from `OPERATORS` because the renderer treats them
 * differently: a `\sum_{i=1}^{n}` in a block puts its limits under and over the
 * sigma rather than beside it, which is the difference between mathematics and a
 * line of characters.
 */
export const BIG_OPERATORS: Record<string, string> = {
  sum: '∑',
  prod: '∏',
  coprod: '∐',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  oint: '∮',
  bigcup: '⋃',
  bigcap: '⋂',
  bigoplus: '⨁',
  bigotimes: '⨂',
  bigvee: '⋁',
  bigwedge: '⋀',
  lim: 'lim',
  max: 'max',
  min: 'min',
  sup: 'sup',
  inf: 'inf',
  argmax: 'arg max',
  argmin: 'arg min'
}

/**
 * Function names, which are set upright rather than italic.
 *
 * `sin(x)` in italics reads as the product of three variables, which is the one
 * typographic distinction in mathematics that changes the meaning rather than
 * the look.
 */
export const FUNCTION_NAMES = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'log',
  'ln',
  'lg',
  'exp',
  'det',
  'dim',
  'ker',
  'deg',
  'gcd',
  'mod',
  'Pr'
])

/** Delimiters, including the ones `\left` and `\right` take. */
export const DELIMITERS: Record<string, string> = {
  '{': '{',
  '}': '}',
  lbrace: '{',
  rbrace: '}',
  langle: '⟨',
  rangle: '⟩',
  lceil: '⌈',
  rceil: '⌉',
  lfloor: '⌊',
  rfloor: '⌋',
  vert: '|',
  Vert: '‖',
  '|': '|',
  '.': ''
}

/**
 * Spacing commands, as the space they produce.
 *
 * Every one of them is a space of some width and this renderer has one width,
 * because a thin space and a medium space differ by two points at body size and
 * nothing in a chat bubble is measured that finely.
 */
export const SPACING = new Set([',', ':', ';', '!', ' ', 'quad', 'qquad', 'thinspace', 'enspace'])

/** Every command that resolves to exactly one character. */
export const SYMBOLS: Record<string, string> = { ...GREEK, ...OPERATORS, ...ARROWS }

/** An accent, as the combining character that draws it. */
export const ACCENTS: Record<string, string> = {
  hat: '̂',
  bar: '̄',
  vec: '⃗',
  dot: '̇',
  ddot: '̈',
  tilde: '̃',
  acute: '́',
  grave: '̀',
  check: '̌',
  breve: '̆',
  overline: '̄'
}

/** Commands that take one group and change how it is SET rather than what it says. */
export const FONT_COMMANDS: Record<string, 'roman' | 'bold' | 'italic' | 'mono'> = {
  text: 'roman',
  textrm: 'roman',
  mathrm: 'roman',
  operatorname: 'roman',
  textbf: 'bold',
  mathbf: 'bold',
  boldsymbol: 'bold',
  textit: 'italic',
  mathit: 'italic',
  texttt: 'mono',
  mathtt: 'mono',
  // Blackboard and calligraphic have no reliable Unicode coverage in a UI face,
  // so they are set upright rather than approximated with letters that may be
  // missing glyphs and render as boxes.
  mathbb: 'roman',
  mathcal: 'roman',
  mathfrak: 'roman',
  mathsf: 'roman'
}
