/**
 * `features/logs/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { logStrings } from '../../features/logs/strings'
import type { Translation } from '../catalogue'

export const logs: Translation<typeof logStrings> = {
  settings: {
    hint: 'Was das Gateway mitgeschrieben hat'
  },

  title: 'Gateway-Logs',
  back: 'Einstellungen',

  loading: 'Log wird gelesen…',
  failed: (reason: string) => `Das Log konnte nicht gelesen werden: ${reason}`,

  unexpected: (saw: string) => `Das Gateway antwortete ${saw} statt mit einer Logseite.`,
  unexpectedHint:
    'Diese Seite kann eine Liste von Zeilen lesen, ein Objekt, das eine enthält, oder einen Block Text. Prüfe, was das Gateway ausliefert:',

  empty: 'Dieses Log ist leer.',
  noMatches: 'Keine Zeile passt zu diesen Filtern.',

  absent: 'Dieses Gateway liefert seine Logs nicht über die API aus.',
  absentHint: 'Lies sie auf der Maschine, die es ausführt:',

  file: 'DATEI',
  files: {
    errors: 'Fehler',
    mcp: 'MCP-Ausgabe'
  },

  levelAll: 'Alle',

  component: 'KOMPONENTE',
  componentAll: 'Alle',

  search: 'Suche',
  searchPlaceholder: 'In diesen Zeilen suchen',

  tail: 'Folgen',
  tailOn: 'Folgt',
  tailOff: 'Pausiert',
  tailHint:
    'Folgen liest die Datei alle paar Sekunden neu. Das Gateway bietet keinen Live-Stream, das hier ist also ein Polling.',

  copy: 'Kopieren',
  copied: 'Kopiert.',

  truncated: (count: number) => `Die letzten ${count} Zeilen — mehr liefert die API nicht.`,
  lineCount: (count: number) => `${count} ${count === 1 ? 'Zeile' : 'Zeilen'}`
}
