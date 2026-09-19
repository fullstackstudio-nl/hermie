/**
 * Every literal the Routines feature paints.
 *
 * Its own file rather than `src/i18n/strings.ts`, for the same reason the chat
 * kit keeps `chat-ui/strings.ts`: the feature is self-contained, and copy that
 * lives next to the screen it belongs to moves with it.
 */
export const cronStrings = {
  title: 'Routines',
  subtitle: 'A little progress, on repeat.',
  sections: {
    active: 'ACTIVE',
    paused: 'PAUSED'
  },
  list: {
    add: 'New routine',
    empty: 'No routines yet. Create one to have a bot work while you are away.',
    loading: 'Loading routines…',
    failed: (reason: string) => `Could not load the routines: ${reason}`,
    nextRun: (when: string) => `Next: ${when}`,
    neverRun: 'Never run',
    noNextRun: 'Not scheduled',
    lastRun: (when: string) => `Last run ${when}`,
    refreshedNever: 'Not refreshed yet',
    refreshedAt: (when: string) => `Refreshed ${when}`
  },
  gatewayBanner: 'Routines will not run: the Hermes gateway process is not running',
  status: {
    ok: 'Success',
    failed: 'Failed',
    paused: 'Paused',
    pending: 'Waiting',
    running: 'Running'
  },
  detail: {
    back: 'Routines',
    nextRun: 'NEXT RUN',
    instructions: 'Instructions',
    noPrompt: 'This routine runs a script and has no prompt.',
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
    delete: 'Delete routine',
    runHistory: 'RUN HISTORY',
    noRuns: 'This routine has not run yet.',
    runsFailed: (reason: string) => `Could not load the run history: ${reason}`,
    loadingRuns: 'Loading runs…',
    loading: 'Loading…',
    unknown: '—'
  },
  confirmDelete: {
    eyebrow: 'DELETE ROUTINE',
    title: (name: string) => `Delete “${name}”?`,
    body: 'The schedule is removed from the gateway. Run transcripts already recorded stay where they are.',
    confirm: 'Delete',
    cancel: 'Keep it'
  },
  run: {
    back: 'Routine',
    title: 'Run',
    empty: 'This run recorded no messages.',
    failed: (reason: string) => `Could not load this run: ${reason}`,
    loading: 'Loading the run…',
    readOnly: 'Read-only: a routine run cannot be continued from here.'
  },
  editor: {
    createEyebrow: 'NEW ROUTINE',
    editEyebrow: 'EDIT ROUTINE',
    createTitle: 'New routine',
    editTitle: 'Edit routine',
    name: 'Name',
    namePlaceholder: 'Morning briefing',
    prompt: 'Instructions',
    promptPlaceholder: 'Summarize overnight updates and list three takeaways.',
    deliver: 'Delivers to',
    deliverLocal: 'Local (save only)',
    schedule: 'Schedule',
    preview: (schedule: string) => `Sends to the gateway as: ${schedule}`,
    nextRunHint: 'The gateway decides the next run; it appears here once saved.',
    save: 'Save routine',
    saving: 'Saving…',
    cancel: 'Cancel',
    nameRequired: 'Give the routine a name.',
    promptRequired: 'Write the instructions the bot should follow.',
    saveFailed: (reason: string) => `The gateway refused the routine: ${reason}`
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
