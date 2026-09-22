/**
 * What each language CLAIMS to cover, and the keys it is excused from.
 *
 * The completeness test (`coverage.test.ts`) is driven entirely from here, and
 * the shape is two lists rather than one because they answer two different
 * questions:
 *
 *  - `TRANSLATED_TREES` is the claim. A tree listed here must be complete, and
 *    a new English key under it fails the build until somebody translates it.
 *    That is the whole point: English is the source, translations drift, and a
 *    round that adds copy should find out in CI rather than from a reader.
 *  - `UNTRANSLATED_KEYS` is the escape hatch, one key at a time. It exists so a
 *    round CAN add an English string today and translate it next week without
 *    either dropping the tree's claim or blocking the commit — the price is
 *    that the key has to be named, so the list is a to-do somebody can read.
 *
 * The test also fails on a STALE entry: a key that has since been translated
 * has to leave this list. An allow-list nobody prunes stops being an allow-list
 * and becomes a hole.
 */
import type { TreeName } from './catalogue'
import { TREE_NAMES } from './trees'
import type { Locale } from './locales'

export type TranslatedLocale = Exclude<Locale, 'en'>

/**
 * Which trees each language claims.
 *
 * Empty while the layer itself lands: a claim is a promise the completeness
 * test enforces, and the two catalogues do not yet have anything to promise.
 * Each language adds its trees in the commit that translates them, which is
 * also what makes that commit's test fail without its change.
 */
export const TRANSLATED_TREES: Record<TranslatedLocale, readonly TreeName[]> = {
  nl: [],
  de: []
}

/** Every tree there is, for a language that claims the lot. */
export const ALL_TREES: readonly TreeName[] = TREE_NAMES

/**
 * Keys a language deliberately does not answer, as `tree.path.to.key`.
 *
 * Two kinds live here and both are legitimate:
 *
 *  - A string that is the SAME in that language. A translation that repeats the
 *    English word buys nothing and costs a line somebody has to keep in step;
 *    `mcp.title` is "MCP servers" in Dutch too.
 *  - A shell command, a config key or a URL. `hermes plugins install kanban` is
 *    typed into a terminal, and a terminal does not speak Dutch.
 *
 * Anything else in this list is a to-do.
 */
export const UNTRANSLATED_KEYS: Record<TranslatedLocale, readonly string[]> = {
  nl: [],
  de: []
}

/** The allow-list for one tree, with the tree prefix stripped, as a set. */
export function excusedKeys(locale: TranslatedLocale, tree: TreeName): Set<string> {
  const prefix = `${tree}.`

  return new Set(
    UNTRANSLATED_KEYS[locale].filter(entry => entry.startsWith(prefix)).map(entry => entry.slice(prefix.length))
  )
}
