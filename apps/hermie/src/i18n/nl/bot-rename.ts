/**
 * `features/bot-rename/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { renameStrings } from '../../features/bot-rename/strings'
import type { Translation } from '../catalogue'

export const botRename: Translation<typeof renameStrings> = {
  displayLabel: 'Weergavenaam',
  displayHint: 'Hoe deze bot op elke client heet. Het profiel houdt zijn eigen naam.',

  profileLabel: 'Profielnaam',
  profileHint: 'De naam waarmee de rest van de app deze bot aanspreekt.',
  profileWarning: 'Hernoemen verandert de profielnaam die andere tools gebruiken',

  placeholder: 'Niet ingesteld',
  clearHint: 'Laat het leeg om terug te vallen op de profielnaam.',

  refused: 'De gateway accepteerde die naam niet.',
  missing: (name: string) => `De gateway heeft geen profiel dat ${name} heet.`,
  failed: 'Die naam kon niet worden opgeslagen.',
  clearRefused: 'Het standaardprofiel heeft een naam nodig.',
  // `parts` staat achteraan, achter een dubbele punt: een werkwoord ervoor zou
  // moeten kiezen tussen enkelvoud en meervoud, en dat hangt van de lijst af.
  partial: (parts: string[]) =>
    `De gateway heeft deze bot hernoemd, maar dit kon niet mee: ${parts.join(' en ')}. Verbind opnieuw om het op te halen.`,
  partialStores: 'de open chats',
  partialCache: 'het bewaarde transcript'
}
