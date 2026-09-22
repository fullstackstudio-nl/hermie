/**
 * The German catalogue, one file per English string table.
 *
 * Same rules as `../nl/index.ts`: types only, no English values, and the
 * glossary in `docs/i18n.md`. German addresses the reader as `du`, matching the
 * Dutch `je` rather than the formal register a German product would often pick
 * — Hermie is somebody's own bots on somebody's own machine.
 */
import { app } from './app'

/** Every tree, by the name `catalogue.ts` knows it as. */
export const de = { app }
