/**
 * A model id, written the way its maker writes it.
 *
 * A gateway reports wire ids — `claude-haiku-4-5-20251001`,
 * `openrouter/anthropic/claude-opus-5`, `qwen3-235b` — and every surface that
 * showed one showed it raw: the usage line under a reply, the options sheet's
 * Model row, the picker, a cron's detail. They are not wrong, they are just not
 * what anybody calls these things, and three of them side by side in a picker is
 * a wall of hyphens.
 *
 * ## What this is NOT
 *
 * It is not a catalogue. A table of known ids would be out of date by the next
 * release and silently wrong for every self-hosted model, so this is a set of
 * PATTERNS: a family word gets the spelling its maker uses, a run of version
 * numbers joins with dots, a parameter count gets a capital B, a date suffix is
 * dropped, and anything it does not recognise is Title-Cased with its numbers
 * left alone. An id it has never seen still comes out readable, which is the
 * property a table cannot have.
 *
 * The wire id is never changed and never thrown away: `parseModelId` hands it
 * back, and the two places a reader might need to type or paste one — the model
 * picker and the connection debug screen — print it underneath the name.
 *
 * ## The provider is a separate answer
 *
 * `anthropic/claude-opus-5` and `openrouter/anthropic/claude-opus-5` are the same
 * model reached two ways, and the routing is not part of the name. Everything
 * before the last `/` is the provider, and GitLab's `duo-chat-` prefix is one too
 * — it is a namespace written with a hyphen because that provider has no slash in
 * its ids.
 */

/** A model id, taken apart. The name is never blank unless the id was. */
export interface ParsedModelId {
  /** The id exactly as it arrived. */
  id: string
  /** What to show a reader. */
  name: string
  /** The route the id named, or null: `openai`, `openrouter/anthropic`, `duo-chat`. */
  provider: string | null
}

/**
 * Families, and the spelling each one's maker uses.
 *
 * Only entries whose casing cannot be derived are here. `opus`, `sonnet`, `pro`
 * and `flash` are absent on purpose: Title Case already gets them right, and a
 * list that contains what it does not need is a list nobody trusts.
 */
const FAMILIES: Record<string, string> = {
  anthropic: 'Anthropic',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  codellama: 'CodeLlama',
  codestral: 'Codestral',
  deepseek: 'DeepSeek',
  doubao: 'Doubao',
  ernie: 'ERNIE',
  gemini: 'Gemini',
  gemma: 'Gemma',
  glm: 'GLM',
  gpt: 'GPT',
  grok: 'Grok',
  hunyuan: 'Hunyuan',
  jamba: 'Jamba',
  kimi: 'Kimi',
  llama: 'Llama',
  minimax: 'MiniMax',
  ministral: 'Ministral',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  openai: 'OpenAI',
  qwen: 'Qwen',
  qwq: 'QwQ',
  sonar: 'Sonar',
  yi: 'Yi'
}

/** Words that are an acronym rather than a word, and are not a family. */
const ACRONYMS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  hd: 'HD',
  moe: 'MoE',
  oss: 'OSS',
  tts: 'TTS',
  vl: 'VL'
}

/** Small words that stay small when they are not the first thing said. */
const JOINERS = new Set(['and', 'for', 'of', 'the', 'with'])

/**
 * Families whose version rides on a hyphen rather than a space.
 *
 * `GPT-5.5` and `GLM-4.6`, because that is how OpenAI and Zhipu write them —
 * against `Claude Opus 5` and `Gemini 2.5 Pro`, which are spaced. It is two
 * entries rather than a rule because there is no rule: it is a house style per
 * house.
 */
const HYPHENATED = new Set(['glm', 'gpt'])

/** GitLab's Duo writes its provider as a prefix on the id, with no slash. */
const PREFIXES: [string, string][] = [['duo-chat-', 'duo-chat']]

const SEPARATORS = /[\s\-_:]+/

/** `o1`, `o3`, `o4-mini`: OpenAI's reasoning line is lower case, deliberately. */
const O_SERIES = /^o\d+$/

/** `4`, `4.6`, `2.5`, `4o` — something that reads as a version rather than a word. */
const VERSIONISH = /^\d+(\.\d+)*[a-z]?$/

/** `70b`, `8x7b`, `1.5b` — a parameter count. */
const PARAMETERS = /^(\d+(\.\d+)?(x\d+(\.\d+)?)?)b$/

/** `32k`, `128k` — a context window. */
const CONTEXT = /^(\d+)k$/

/** `v3`, `r1`, `k2.5` — a letter and a number that belong together. */
const LETTER_VERSION = /^([a-z]+)(\d+(\.\d+)*)$/

/** A whole number, or a dotted one. */
const NUMBER = /^\d+(\.\d+)*$/

/** `20251001`, and only in this century — `2411` is a Mistral version, not a date. */
const DATE_STAMP = /^(19|20)\d{6}$/

const YEAR = /^(19|20)\d{2}$/
const TWO_DIGITS = /^\d{2}$/

/** The whole point, in one call: what to show for this id. */
export function prettyModelName(id: string): string {
  return parseModelId(id).name
}

export function parseModelId(id: string): ParsedModelId {
  const trimmed = id.trim()

  if (trimmed === '') {
    return { id, name: '', provider: null }
  }

  const route = trimmed.split('/')
  let model = route[route.length - 1] ?? trimmed
  const providers = route.slice(0, -1)

  for (const [prefix, provider] of PREFIXES) {
    if (model.toLowerCase().startsWith(prefix)) {
      model = model.slice(prefix.length)
      providers.push(provider)
      break
    }
  }

  const tokens = dropDateSuffix(model.split(SEPARATORS).filter(part => part !== ''))
  const joined = joinVersionRuns(tokens)

  return {
    id,
    // A name is never empty: an id made of nothing but separators still has to
    // say something, and the only honest thing left to say is the id itself.
    name: assemble(joined) || trimmed,
    provider: providers.length > 0 ? providers.join('/') : null
  }
}

/**
 * Drop the release date a provider pins a snapshot with.
 *
 * Both spellings: `-20251001` in one token, and `-2025-10-01` in three. What is
 * NOT dropped is a bare four-digit number — `mistral-large-2411` is a version,
 * and a rule that cannot tell them apart would eat it.
 */
function dropDateSuffix(tokens: readonly string[]): string[] {
  const rest = [...tokens]
  const last = rest[rest.length - 1] ?? ''

  if (rest.length > 1 && DATE_STAMP.test(last)) {
    rest.pop()

    return rest
  }

  if (
    rest.length > 3 &&
    TWO_DIGITS.test(last) &&
    TWO_DIGITS.test(rest[rest.length - 2] ?? '') &&
    YEAR.test(rest[rest.length - 3] ?? '')
  ) {
    rest.splice(-3, 3)
  }

  return rest
}

/**
 * `4`, `6` → `4.6`.
 *
 * A maker who writes `claude-sonnet-4-6` and a maker who writes
 * `claude-sonnet-4.6` mean the same model, and a reader should not have to know
 * which gateway they are on to recognise it. Only a RUN of bare numbers joins,
 * so `grok-code-fast-1` keeps its single one and `llama-3.1-70b` is left alone.
 */
function joinVersionRuns(tokens: readonly string[]): string[] {
  const out: string[] = []

  for (const token of tokens) {
    const previous = out[out.length - 1]

    if (previous !== undefined && NUMBER.test(token) && NUMBER.test(previous)) {
      out[out.length - 1] = `${previous}.${token}`

      continue
    }

    out.push(token)
  }

  return out
}

function assemble(tokens: readonly string[]): string {
  if (tokens.length === 0) {
    return ''
  }

  const words = tokens.map((token, index) => displayWord(token, index))
  const family = (tokens[0] ?? '').toLowerCase()
  const second = tokens[1] ?? ''

  if (HYPHENATED.has(family) && words.length > 1 && VERSIONISH.test(second)) {
    return [`${words[0]}-${words[1]}`, ...words.slice(2)].join(' ')
  }

  return words.join(' ')
}

function displayWord(token: string, index: number): string {
  const lower = token.toLowerCase()

  if (O_SERIES.test(lower)) {
    return lower
  }

  const family = FAMILIES[lower]

  if (family !== undefined) {
    return family
  }

  const acronym = ACRONYMS[lower]

  if (acronym !== undefined) {
    return acronym
  }

  if (index > 0 && JOINERS.has(lower)) {
    return lower
  }

  const parameters = PARAMETERS.exec(lower)

  if (parameters) {
    return `${parameters[1]}B`
  }

  const context = CONTEXT.exec(lower)

  if (context) {
    return `${context[1]}K`
  }

  if (NUMBER.test(lower)) {
    return lower
  }

  const letterVersion = LETTER_VERSION.exec(lower)

  if (letterVersion) {
    const [, letters = '', digits = ''] = letterVersion
    // `qwen3` is a family that has grown a number; `k3` and `v3` are a letter
    // standing for one. Both keep the number welded on, which is how they are
    // written, and only the letters differ in how they are spelled.
    const head = FAMILIES[letters] ?? (letters.length === 1 ? letters.toUpperCase() : capitalise(letters))

    return `${head}${digits}`
  }

  return capitalise(token)
}

/** First letter up, everything after it left exactly as the id wrote it. */
function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
