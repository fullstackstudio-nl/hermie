/**
 * `i18n/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { Translation } from '../catalogue'
import type { strings } from '../strings'

export const app: Translation<typeof strings> = {
  settings: {
    language: 'Sprache',
    languageFollowDevice: 'Gerät folgen',
    languageHint:
      'Hermie ist auf Englisch geschrieben. Niederländisch und Deutsch sind Übersetzungen davon; was noch nicht übersetzt ist, bleibt Englisch.'
  }
}
