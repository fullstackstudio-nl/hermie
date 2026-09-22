/**
 * `i18n/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { Translation } from '../catalogue'
import type { strings } from '../strings'

export const app: Translation<typeof strings> = {
  settings: {
    language: 'Taal',
    languageFollowDevice: 'Volg apparaat',
    languageHint:
      'Hermie is in het Engels geschreven. Nederlands en Duits zijn vertalingen daarvan; wat nog niet vertaald is blijft Engels.'
  }
}
