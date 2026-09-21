/**
 * Every literal the rename field paints.
 *
 * Its own file rather than `src/i18n/strings.ts`, for the reason
 * `features/cron/strings.ts` gives: copy that lives next to the thing it
 * describes moves with it.
 *
 * The wording splits on ONE fact and everything else follows from it. Core's
 * `PATCH /api/profiles/{name}` does two different things depending on which
 * profile it is aimed at — it gives the `default` profile a presentation-only
 * label and keeps its id, and it genuinely RENAMES any other profile, its
 * directory, its wrapper script, its service and the active-profile pointer
 * with it (`docs/DESIGN.md` §8 in the plugin repository, read out of Hermes
 * 0.21.3). A field labelled "Display name" over both would be telling half the
 * readers that a handle their crons and their `@`-mentions use is a label.
 */
export const renameStrings = {
  /** The `default` profile: a label, and the id underneath is untouched. */
  displayLabel: 'Display name',
  displayHint: 'What this bot is called on every client. The profile keeps its own name.',

  /** Any other profile: this IS the handle. */
  profileLabel: 'Profile name',
  profileHint: 'The name the rest of the app addresses this bot by.',
  /**
   * The warning, in the present tense and without a hedge.
   *
   * A separate line rather than part of the hint, because it does not describe
   * the field — it says what pressing Save will do.
   */
  profileWarning: 'Renaming changes the profile name other tools use',

  placeholder: 'Not set',
  /** Only `default` can be cleared, and only back to its own id. */
  clearHint: 'Leave it empty to fall back to the profile name.',

  /** Refusals, named by what the gateway answered rather than by a guess at why. */
  refused: 'The gateway would not take that name.',
  missing: (name: string) => `The gateway has no profile called ${name}.`,
  failed: 'That name could not be saved.',
  /** `rename_profile` refuses an empty new name for `default` before the setter sees it. */
  clearRefused: 'The default profile needs a name.',
  /** The local half went wrong after the gateway had already taken the name. */
  partial: (parts: string[]) =>
    `The gateway renamed this bot, but ${parts.join(' and ')} could not be moved across. Reconnect to pick it up.`,
  partialStores: 'the open chats',
  partialCache: 'the cached transcript'
} as const
