/**
 * Every literal the memory browser paints.
 *
 * Its own file rather than `src/i18n/strings.ts`, for the reason
 * `features/cron/strings.ts` gives: a self-contained feature keeps its copy
 * next to the screen it belongs to.
 *
 * Two of these are worth reading before they are changed. **"Not browsable"**
 * is not an apology for a missing feature — an external provider offers
 * `prefetch(query)` and no call that returns entries, so there is nothing to
 * list and saying so is the accurate answer. And the **missing-plugin** copy
 * names a version because the capability is what is missing rather than the
 * plugin: a gateway can have an older Hermie plugin installed and enabled and
 * still have no memory routes at all.
 */
export const memoryStrings = {
  title: 'Memory',
  /** The row on the bot profile sheet, and the entry in Settings. */
  rowTitle: 'Memory',
  rowHint: 'What this bot remembers about its work, and about you.',
  /** The Settings entry, which is a list of bots rather than one bot's memory. */
  botsTitle: 'Memory',
  botsHint: 'Read and edit what each bot remembers.',
  botsEmpty: 'No bots yet.',
  forBot: (name: string) => `${name}'s memory`,

  tabs: {
    entries: 'Entries',
    graph: 'Graph'
  },

  sections: {
    memory: 'MEMORY',
    user: 'USER'
  },
  sectionHint: {
    memory: "What the bot has written down about its work. Hermes' own MEMORY.md.",
    user: 'What the bot has written down about you. USER.md.'
  },

  loading: 'Reading memory…',
  /** The gateway answered, and answered with nothing in this file. */
  empty: {
    memory: 'Nothing written down yet.',
    user: 'Nothing written down about you yet.'
  },
  failed: (reason: string) => `Could not read this memory: ${reason}`,
  retry: 'Try again',

  /** The bar. `chars` is the store's own count, delimiter included. */
  usage: (chars: number, limit: number) => `${chars} of ${limit} characters`,
  usageUnbounded: (chars: number) => `${chars} characters`,
  usageLabel: (target: string, percent: number) => `${target} is ${percent}% full`,

  search: {
    placeholder: 'Search this memory',
    clear: 'Clear',
    searching: 'Searching…',
    none: (query: string) => `Nothing matches “${query}”.`,
    count: (found: number) => (found === 1 ? '1 entry' : `${found} entries`),
    /** The plugin matches every word, in any order, as plain text. */
    hint: 'Every word has to appear somewhere in the entry. Order does not matter.'
  },

  add: {
    placeholder: 'Write something down',
    action: 'Add',
    label: (target: string) => `Add to ${target}`
  },

  edit: {
    action: 'Edit',
    save: 'Replace',
    cancel: 'Cancel',
    label: (index: number) => `Edit entry ${index + 1}`
  },

  remove: {
    action: 'Remove',
    label: (index: number) => `Remove entry ${index + 1}`,
    confirmTitle: 'Remove this entry?',
    confirmBody: 'The bot stops being told this. Hermes keeps no history of a memory file.',
    confirm: 'Remove',
    cancel: 'Keep it'
  },

  /** The advert says browsing is offered and editing is not. */
  readOnly:
    'This gateway lets memory be read and not written. Switch on the plugin’s memory.edit for this profile to change that.',

  providers: {
    header: 'PROVIDERS',
    notBrowsable: 'Not browsable',
    /** Said once, under the list, because it is the same reason for every row. */
    hint: 'An external memory provider answers a bot with text for one turn. It offers no call that lists what it holds, so there is nothing here to show.'
  },

  missing: {
    title: 'The Hermie plugin has no memory browser',
    /**
     * The capability and not the plugin, because those are different states.
     *
     * A gateway may have an older plugin installed, enabled and happily sending
     * notifications, and still answer nothing here.
     */
    body: 'Reading a bot’s memory needs the hermie plugin, version 0.5.0 or newer, installed on the gateway and enabled for this profile.',
    install: 'ON THE GATEWAY',
    guide: 'Read the guide',
    /** A roster has not arrived yet; "not installed" would be a guess. */
    unknown: 'Waiting for the gateway to say what is installed…'
  }
} as const
