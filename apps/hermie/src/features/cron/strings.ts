/**
 * Every literal the Crons feature paints.
 *
 * The gateway calls these cron jobs and so does its dashboard, so Hermie calls
 * them crons too: a second name for the same thing only costs the reader a
 * translation step when they go looking for one in `hermes cronjob list`. The
 * identifiers in this feature still say `cron`, which they always did.
 *
 * Its own file rather than `src/i18n/strings.ts`, for the same reason the chat
 * kit keeps `chat-ui/strings.ts`: the feature is self-contained, and copy that
 * lives next to the screen it belongs to moves with it.
 */
export const cronStrings = {
  title: 'Crons',
  subtitle: 'A little progress, on repeat.',
  sections: {
    active: 'ACTIVE',
    paused: 'PAUSED'
  },
  list: {
    add: 'New cron',
    empty: 'No crons yet. Create one to have a bot work while you are away.',
    loading: 'Loading crons…',
    failed: (reason: string) => `Could not load the crons: ${reason}`,
    nextRun: (when: string) => `Next: ${when}`,
    neverRun: 'Never run',
    noNextRun: 'Not scheduled',
    lastRun: (when: string) => `Last run ${when}`,
    refreshedNever: 'Not refreshed yet',
    refreshedAt: (when: string) => `Refreshed ${when}`,
    /** Which bot's cron store a job lives in. Two profiles may name a cron the same thing. */
    profile: (name: string) => `Profile: ${name}`
  },
  gatewayBanner: 'Crons will not run: the Hermes gateway process is not running',
  status: {
    ok: 'Success',
    failed: 'Failed',
    paused: 'Paused',
    pending: 'Waiting',
    running: 'Running'
  },
  detail: {
    back: 'Crons',
    nextRun: 'NEXT RUN',
    instructions: 'Instructions',
    noPrompt: 'This cron runs a script and has no prompt.',
    schedule: 'Schedule',
    scheduleLabel: 'Schedule',
    deliverLabel: 'Delivers to',
    repeatLabel: 'Repeat',
    repeatForever: 'Until removed',
    modelLabel: 'Model',
    skillsLabel: 'Skills',
    stateLabel: 'State',
    lastRunLabel: 'Last run',
    lastStatusLabel: 'Last status',
    pausedReasonLabel: 'Paused because',
    errorLabel: 'Last error',
    details: 'DETAILS',
    actions: 'ACTIONS',
    runNow: 'Run now',
    running: 'Starting…',
    pause: 'Pause',
    resume: 'Resume',
    edit: 'Edit',
    delete: 'Delete cron',
    runHistory: 'RUN HISTORY',
    noRuns: 'This cron has not run yet.',
    runsFailed: (reason: string) => `Could not load the run history: ${reason}`,
    loadingRuns: 'Loading runs…',
    loading: 'Loading…',
    unknown: '—'
  },
  confirmDelete: {
    eyebrow: 'DELETE CRON',
    title: (name: string) => `Delete “${name}”?`,
    body: 'The schedule is removed from the gateway. Run transcripts already recorded stay where they are.',
    confirm: 'Delete',
    cancel: 'Keep it'
  },
  run: {
    back: 'Cron',
    title: 'Run',
    empty: 'This run recorded no messages.',
    failed: (reason: string) => `Could not load this run: ${reason}`,
    loading: 'Loading the run…',
    readOnly: 'Read-only: a cron run cannot be continued from here.'
  },
  editor: {
    createEyebrow: 'NEW CRON',
    editEyebrow: 'EDIT CRON',
    createTitle: 'New cron',
    editTitle: 'Edit cron',
    name: 'Name',
    namePlaceholder: 'Morning briefing',
    prompt: 'Instructions',
    promptPlaceholder: 'Summarize overnight updates and list three takeaways.',
    deliver: 'Delivers to',
    deliverLocal: 'Local (save only)',
    profile: 'Profile',
    profileHint: 'Whose cron store the job is written to. It runs as that bot.',
    /** The profile `hermes serve` itself was launched with; the gateway's own default. */
    profileDefault: 'This gateway',
    profileLocked: 'A cron cannot be moved to another profile after it is created.',
    schedule: 'Schedule',
    preview: (schedule: string) => `Sends to the gateway as: ${schedule}`,
    nextRunHint: 'The gateway decides the next run; it appears here once saved.',
    save: 'Save cron',
    saving: 'Saving…',
    cancel: 'Cancel',
    nameRequired: 'Give the cron a name.',
    promptRequired: 'Write the instructions the bot should follow.',
    saveFailed: (reason: string) => `The gateway refused the cron: ${reason}`
  },
  schedule: {
    mode: 'Repeat',
    modes: {
      interval: 'Interval',
      daily: 'Daily',
      cron: 'Cron',
      once: 'Once'
    },
    everyLabel: 'Every',
    units: {
      minutes: 'minutes',
      hours: 'hours',
      days: 'days'
    },
    time: 'Time',
    timePlaceholder: '09:00',
    days: 'Days',
    daysHint: 'No day selected means every day.',
    cronExpression: 'Cron expression',
    cronPlaceholder: '0 9 * * 1-5',
    cronHint: 'Five fields: minute, hour, day of month, month, day of week.',
    once: 'When',
    oncePlaceholder: 'in 2h',
    onceHint: 'A delay such as “in 2h”, or a date and time such as 2026-09-20T09:00.',
    weekdayInitials: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
    weekdayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    errors: {
      interval: 'Enter how many minutes, hours or days between runs.',
      time: 'Enter a time as HH:MM, for example 09:00.',
      cronFieldCount: 'A cron expression has five fields, for example 0 9 * * 1-5.',
      cronField: (field: string, value: string) => `The ${field} field does not accept “${value}”.`,
      once: 'Enter a delay such as “in 2h”, or a date and time such as 2026-09-20T09:00.'
    }
  },
  relative: {
    now: 'now',
    inSeconds: (value: number) => `in ${value}s`,
    inMinutes: (value: number) => `in ${value} min`,
    inHours: (value: number) => `in ${value}h`,
    inDays: (value: number) => `in ${value}d`,
    secondsAgo: (value: number) => `${value}s ago`,
    minutesAgo: (value: number) => `${value} min ago`,
    hoursAgo: (value: number) => `${value}h ago`,
    daysAgo: (value: number) => `${value}d ago`
  }
} as const
