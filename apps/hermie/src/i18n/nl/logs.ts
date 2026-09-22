/**
 * `features/logs/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { logStrings } from '../../features/logs/strings'
import type { Translation } from '../catalogue'

export const logs: Translation<typeof logStrings> = {
  settings: {
    hint: 'Wat de gateway heeft opgeschreven'
  },

  title: 'Gateway-logs',
  back: 'Instellingen',

  loading: 'Het logbestand lezen…',
  failed: (reason: string) => `Kon het logbestand niet lezen: ${reason}`,

  unexpected: (saw: string) => `De gateway antwoordde ${saw} in plaats van een logpagina.`,
  unexpectedHint:
    'Deze pagina kan een lijst met regels lezen, een object dat er een bevat, of één blok tekst. Kijk na wat de gateway serveert:',

  empty: 'Dit logbestand is leeg.',
  noMatches: 'Geen enkele regel past bij deze filters.',

  absent: 'Deze gateway serveert zijn logs niet via de API.',
  absentHint: 'Lees ze op de machine die hem draait:',

  file: 'BESTAND',
  files: {
    errors: 'Fouten',
    mcp: 'MCP-uitvoer'
  },

  level: 'NIVEAU',
  levelAll: 'Alle',

  componentAll: 'Alle',

  search: 'Zoeken',
  searchPlaceholder: 'Zoek in deze regels',

  tail: 'Volgen',
  tailOn: 'Volgt',
  tailOff: 'Pauze',
  tailHint:
    'Volgen leest het bestand elke paar seconden opnieuw. De gateway biedt geen live stream, dus dit is een poll.',

  copy: 'Kopiëren',
  copied: 'Gekopieerd.',

  truncated: (count: number) => `Toont de laatste ${count} regels — meer geeft de API niet.`,
  lineCount: (count: number) => `${count} ${count === 1 ? 'regel' : 'regels'}`
}
