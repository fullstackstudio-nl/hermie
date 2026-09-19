/**
 * Hermes-specific Markdown fixes, applied before the lexer sees the text.
 *
 * This is the subset of `apps/desktop/src/lib/markdown-preprocess.ts` that
 * still applies here. Deliberately dropped: everything about math. The desktop
 * app renders KaTeX; Hermie has no math renderer, so normalising `$$` fences
 * and escaping currency dollars would only churn text nobody looks at
 * differently. Dropped for the same reason: preview targets, session-ref
 * linkification and the HTML nesting clamp — all three route into desktop-only
 * renderers that do not exist on this side.
 *
 * What is ported, and why each one matters while a reply is still streaming:
 *
 *   - Reasoning blocks (`<think>…`). Runs on the ACCUMULATED text on every
 *     flush, so an unterminated block has to be hidden here. Otherwise the
 *     chain of thought paints as prose until the close tag lands and then the
 *     whole span vanishes in one frame.
 *   - Fence normalisation. An unterminated fence mid-stream must already read
 *     as a code block, not as prose that turns into code a second later.
 *   - `MEDIA:` delivery tags, which the gateway emits as a bare line and which
 *     are a link, not literal text.
 *   - Table spacing. Models routinely emit a table with no blank line above
 *     it; GFM then reads the header row as the tail of the paragraph and the
 *     table renders as pipes.
 */

// Same tag set as the upstream scrubber, plus the desktop-only `scratchpad`
// and `analysis`.
const REASONING_TAGS = 'think|thinking|reasoning|thought|reasoning_scratchpad|scratchpad|analysis'

// A run of adjacent closed blocks is one match, so the seam check below sees
// the prose on either side of the whole run rather than the previous block's
// closing tag.
const REASONING_BLOCK_RE = new RegExp(`(?:<(${REASONING_TAGS})>[\\s\\S]*?<\\/\\1>\\s*)+`, 'gi')

// An open tag that starts its own block with no close tag yet. The
// block-boundary requirement is what lets a real reasoning preamble (always its
// own block) vanish while prose that merely mentions `<thinking>` mid-sentence
// survives.
const OPEN_REASONING_BLOCK_RE = new RegExp(`(^|\\n)[ \\t]*<(${REASONING_TAGS})>[\\s\\S]*$`, 'i')

// A half-arrived open tag (`<thin`) at a block boundary is not a tag yet, so
// without this it paints as prose for one frame and is then erased.
const REASONING_TAG_PREFIXES = Array.from(
  new Set(REASONING_TAGS.split('|').flatMap(tag => Array.from({ length: tag.length }, (_, i) => tag.slice(0, i + 1))))
).join('|')

const PARTIAL_OPEN_REASONING_TAG_RE = new RegExp(`(^|\\n)[ \\t]*<(?:${REASONING_TAG_PREFIXES})?$`, 'i')

const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/
const EMPTY_FENCE_BLOCK_RE = /(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/g
const CODE_FENCE_SPLIT_RE = /((?:```|~~~)[\s\S]*?(?:```|~~~|$))/g
const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g
const URL_ONLY_LINE_RE = /^\s*https?:\/\/\S+\s*$/i
const VALID_LANGUAGE_RE = /^[a-z0-9][a-z0-9+#-]*$/i

// `[1]` / `[1, 2]` glued to the end of a word: a citation marker from a search
// tool, not a link and not a footnote we can resolve.
const CITATION_MARKER_RE = /(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:\d+(?:\s*,\s*\d+)*)\](?!\()/gu

// Bare-URL autolink. The character classes exclude `*` so a URL that abuts
// emphasis with no separating space (`**see https://x**`, a very common model
// pattern) does not swallow the trailing `**` into the href.
const RAW_URL_RE = /https?:\/\/[^\s<>"'`*]+[^\s<>"'`*.,;:!?]/g

// Mirrors `MEDIA_DELIVERY_EXTS` in the gateway's `platforms/base.py`: the
// extensions a `MEDIA:` tag is allowed to end on. Anchoring on the extension is
// what lets an unquoted path contain spaces.
const MEDIA_DELIVERY_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'svg',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  '3gp',
  'mp3',
  'm2a',
  'wav',
  'ogg',
  'opus',
  'm4a',
  'flac',
  'pdf',
  'docx',
  'doc',
  'odt',
  'rtf',
  'txt',
  'md',
  'epub',
  'xlsx',
  'xls',
  'ods',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'kmz',
  'kml',
  'geojson',
  'gpx',
  'pptx',
  'ppt',
  'odp',
  'key',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'apk',
  'ipa',
  'html',
  'htm'
]

// Longest first, so the alternation never matches a short extension as the
// prefix of a longer one.
const MEDIA_EXT_ALTERNATION = [...MEDIA_DELIVERY_EXTS].sort((a, b) => b.length - a.length).join('|')

const MEDIA_PATH_ANCHORED =
  `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${MEDIA_EXT_ALTERNATION})` +
  `(?=[\\s\`"'*_,;:)\\]}]|MEDIA:|$)`

const MEDIA_VALUE = `\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${MEDIA_PATH_ANCHORED}|\\S+`

const MEDIA_LINE_RE = new RegExp(`(^|\\n)[\\t ]*[\`"']?MEDIA:\\s*(${MEDIA_VALUE})[\`"']?[\\t ]*(\\n|$)`, 'g')
const MEDIA_TAG_RE = new RegExp(`[\`"']?MEDIA:\\s*(${MEDIA_VALUE})[\`"']?`, 'g')

// A GFM delimiter row: `|---|:--:|`. The header row above it is whatever line
// precedes it, which is exactly why the blank line matters.
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const TABLE_ROW_RE = /\|/

function sanitizeLanguageTag(tag: string): string {
  const first = tag.trim().split(/\s/, 1)[0] ?? ''

  return VALID_LANGUAGE_RE.test(first) && first.length <= 16 ? first.toLowerCase() : ''
}

function stripReasoningBlocks(text: string): string {
  // Removing a closed block between two words keeps one space, so `no` and
  // `Hermes` do not fuse into `noHermes`.
  const closed = text.replace(REASONING_BLOCK_RE, (match, _tag: string, offset: number, whole: string) => {
    const previous = whole[offset - 1]
    const next = whole[offset + match.length]

    return previous && next && !/\s/.test(previous) && !/\s/.test(next) ? ' ' : ''
  })

  return closed.replace(OPEN_REASONING_BLOCK_RE, '$1').replace(PARTIAL_OPEN_REASONING_TAG_RE, '$1')
}

function unquoteMediaPath(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]

  return quote && quote === trimmed.at(-1) && ['"', "'", '`'].includes(quote) ? trimmed.slice(1, -1) : trimmed
}

function mediaLabel(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path

  return base || path
}

function mediaLink(value: string): string {
  const path = unquoteMediaPath(value)

  // The label is the file name; the href stays the raw path. Hermie cannot
  // open a path on the gateway's disk, so the link renders as an inert,
  // copyable filename rather than a dead `file://` anchor.
  return `[${mediaLabel(path)}](${path})`
}

/** `MEDIA:/srv/out/report.pdf` → `[report.pdf](/srv/out/report.pdf)`. */
export function renderMediaTags(text: string): string {
  if (!text.includes('MEDIA:')) {
    return text
  }

  return text
    .replace(MEDIA_LINE_RE, (_match, lead: string, value: string, trailer: string) => {
      return `${lead}${mediaLink(value)}${trailer}`
    })
    .replace(MEDIA_TAG_RE, (_match, value: string) => mediaLink(value))
}

/** The raw `MEDIA:` values in `text`, quotes intact. */
export function mediaTagValues(text: string): string[] {
  return [...text.matchAll(MEDIA_TAG_RE)].map(match => match[1] ?? '')
}

function stripEmptyFenceBlocks(text: string): string {
  return text.replace(EMPTY_FENCE_BLOCK_RE, '$1')
}

function isUrlOnlyBlock(lines: string[]): boolean {
  const nonEmpty = lines.filter(line => line.trim())

  return nonEmpty.length > 0 && nonEmpty.every(line => URL_ONLY_LINE_RE.test(line))
}

function findClosingFence(lines: string[], start: number, marker: string): number {
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const closeMatch = (lines[cursor] ?? '').match(FENCE_LINE_RE)

    if (!closeMatch) {
      continue
    }

    const closeMarker = closeMatch[2] ?? ''
    const closeInfo = (closeMatch[3] ?? '').trim()

    if (!closeInfo && closeMarker[0] === marker[0] && closeMarker.length >= marker.length) {
      return cursor
    }
  }

  return -1
}

/**
 * Rewrite every fence to `marker + sanitized language`, drop empty and
 * URL-only fences, and leave an unterminated fence open so the lexer still
 * reads it as code. That last part is the whole point during streaming: the
 * half-arrived block paints as a code block from the first line and stays one.
 */
function normalizeFenceBlocks(text: string): string {
  const sourceLines = text.split('\n')
  const out: string[] = []
  let index = 0

  while (index < sourceLines.length) {
    const line = sourceLines[index] ?? ''
    const match = line.match(FENCE_LINE_RE)

    if (!match) {
      out.push(line)
      index += 1

      continue
    }

    const indent = match[1] ?? ''
    const marker = match[2] ?? '```'
    const infoRaw = (match[3] ?? '').trim()
    const languageToken = infoRaw.split(/\s+/, 1)[0] ?? ''
    const language = sanitizeLanguageTag(languageToken)

    // An info string that is not a language tag at all (`\`\`\`- a bullet`) is
    // prose the model fenced by accident.
    if (infoRaw && !language) {
      out.push(`${indent}${infoRaw}`.trimEnd())
      index += 1

      continue
    }

    const closeIndex = findClosingFence(sourceLines, index, marker)
    const bodyLines = sourceLines.slice(index + 1, closeIndex === -1 ? sourceLines.length : closeIndex)
    const body = bodyLines.join('\n')

    if (closeIndex !== -1 && !body.trim()) {
      index = closeIndex + 1

      continue
    }

    if (closeIndex !== -1 && isUrlOnlyBlock(bodyLines)) {
      out.push(...bodyLines)
      index = closeIndex + 1

      continue
    }

    if (closeIndex === -1) {
      if (!body.trim()) {
        index += 1

        continue
      }

      out.push(`${indent}${marker}${language}`, ...bodyLines)

      break
    }

    out.push(`${indent}${marker}${language}`, ...bodyLines, `${indent}${marker}`)
    index = closeIndex + 1
  }

  return out.join('\n')
}

/**
 * Insert the blank line GFM wants above a table, and below it when the next
 * line is ordinary prose. A table is recognised by its delimiter row, because
 * that is the only row whose shape is unambiguous.
 */
function spaceTableBlocks(text: string): string {
  if (!text.includes('|')) {
    return text
  }

  const lines = text.split('\n')
  const out: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const previous = lines[index - 1]
    const delimiterFollows = TABLE_DELIMITER_RE.test(lines[index + 1] ?? '') && (lines[index + 1] ?? '').includes('-')

    // A header row: it has pipes, the next line is the delimiter row, and the
    // line above is prose rather than a blank.
    if (
      delimiterFollows &&
      TABLE_ROW_RE.test(line) &&
      previous !== undefined &&
      previous.trim() &&
      !TABLE_ROW_RE.test(previous)
    ) {
      out.push('')
    }

    out.push(line)

    // Closing seam: the last row of the table followed directly by prose.
    const next = lines[index + 1]

    if (
      TABLE_ROW_RE.test(line) &&
      !TABLE_DELIMITER_RE.test(line) &&
      next !== undefined &&
      next.trim() &&
      !TABLE_ROW_RE.test(next) &&
      out.some(candidate => TABLE_DELIMITER_RE.test(candidate) && candidate.includes('-'))
    ) {
      out.push('')
    }
  }

  return out.join('\n')
}

function rewriteProseSegment(segment: string): string {
  const withoutCitations = segment.replace(CITATION_MARKER_RE, '')

  return withoutCitations.replace(RAW_URL_RE, (url: string, index: number) => {
    const previous = withoutCitations[index - 1] ?? ''
    const beforePrevious = withoutCitations[index - 2] ?? ''

    // Already an autolink, or already the target of a markdown link.
    if (previous === '<' || (beforePrevious === ']' && previous === '(')) {
      return url
    }

    return `<${url}>`
  })
}

function normalizeVisibleProse(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part => (part.startsWith('`') ? part : rewriteProseSegment(part)))
    .join('')
}

/**
 * The one entry point. Safe to call on every streaming flush: it is pure, and
 * every transform is written so that a half-arrived construct settles into its
 * final shape rather than flipping between two renderings.
 */
export function preprocessMarkdown(text: string): string {
  const cleaned = stripReasoningBlocks(text)
  const normalizedFences = normalizeFenceBlocks(cleaned)
  const withoutEmptyFences = stripEmptyFenceBlocks(normalizedFences)

  return withoutEmptyFences
    .split(CODE_FENCE_SPLIT_RE)
    .map(part => {
      // Fenced blocks pass through untouched: a `[1]` or a bare URL inside a
      // listing is the listing's own text.
      if (/^(?:```|~~~)/.test(part)) {
        return part
      }

      return spaceTableBlocks(normalizeVisibleProse(renderMediaTags(part)))
    })
    .join('')
}
