/**
 * The Dutch catalogue, one file per English string table.
 *
 * Nothing here imports an English value — only its TYPE — so a translation can
 * never accidentally ship an English sentence as if it had been translated, and
 * `catalogue.ts` can import this module without a runtime cycle back into the
 * tables it wraps.
 *
 * Glossary and house style live in `docs/i18n.md`. The short version: `je`, not
 * `u`; product words the product itself keeps in English (Bot Chat, gateway,
 * push, skills, MCP, Boards, Crons) are not translated.
 */
import { app } from './app'

/** Every tree, by the name `catalogue.ts` knows it as. */
export const nl = { app }
