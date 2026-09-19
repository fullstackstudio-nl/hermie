/**
 * Every literal the chat kit paints.
 *
 * Deliberately its own file rather than `src/i18n/strings.ts`: the kit is a
 * self-contained set of components with its own gallery, and keeping its
 * copy next to it means a component and its wording move together.
 */
export const chatStrings = {
  receipt: {
    sending: 'Sending…',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read'
  },
  assistant: {
    thoughtFor: (seconds: number) => `Thought for ${seconds}s`,
    thinking: 'Thinking',
    replyTo: (handle: string) => `Reply to @${handle}`,
    interim: 'Interim note',
    retry: 'Retry',
    reconnecting: 'Reconnecting…',
    errorTitle: 'Something went wrong',
    footer: (parts: string[]) => parts.join(' · '),
    tokens: (input: string, output: string) => `${input} in · ${output} out`
  },
  tool: {
    running: 'Running…',
    generating: 'Preparing…',
    arguments: 'Arguments',
    result: 'Result',
    rawArguments: 'Arguments (raw)',
    rawResult: 'Result (raw)',
    showMore: 'Show more',
    showLess: 'Show less',
    noResult: 'No result recorded',
    failed: 'Failed',
    riskTitle: 'Untrusted output',
    redacted: 'Redacted before it reached the model',
    expand: 'Expand tool call',
    collapse: 'Collapse tool call'
  },
  botDm: {
    to: (target: string) => `→ ${target}`,
    replied: (name: string) => `${name} replied`,
    sending: 'Sending…',
    queued: 'Queued · waiting for the current task',
    delivered: 'Delivered ✓',
    failed: 'Failed',
    ambiguous: 'Ambiguous target',
    unknown: 'Sent',
    showMore: 'Show more',
    showLess: 'Show less',
    senderChip: (name: string) => `${name} · bot`,
    header: (from: string, to: string) => `@${from} → @${to}`,
    chip: (target: string) => `Message to ${target}`,
    inChip: (name: string) => `Message from ${name}`
  },
  subagents: {
    title: 'Agents',
    working: (count: number, elapsed: string) => `${count} ${count === 1 ? 'agent' : 'agents'} working · ${elapsed}`,
    idle: 'No agents running',
    goals: (count: number) => `${count} ${count === 1 ? 'goal' : 'goals'}`,
    steer: 'Steer',
    steerPlaceholder: 'Send a correction…',
    stop: 'Stop',
    openTranscript: 'Open transcript',
    status: {
      queued: 'Queued',
      running: 'Running',
      completed: 'Done',
      failed: 'Failed',
      interrupted: 'Stopped'
    },
    groupStatus: {
      dispatched: 'Dispatched',
      running: 'Running',
      done: 'Done',
      failed: 'Failed'
    }
  },
  transcript: {
    jumpToLatest: 'Jump to latest',
    newMessages: (count: number) => `${count} new`,
    empty: 'No messages yet',
    answer: 'Answer',
    answered: 'answered'
  },
  composer: {
    placeholder: 'Message',
    send: 'Send message',
    stop: 'Stop response',
    attach: 'Add attachment',
    removeAttachment: 'Remove attachment',
    queued: (text: string) => `↳ 1 message queued · “${text}”`,
    slashHint: 'Commands'
  },
  header: {
    back: 'Back to chats',
    options: 'Chat options',
    running: 'Running',
    idle: 'Idle',
    needsInput: 'Waiting for you'
  },
  approval: {
    eyebrow: (handle: string) => `PERMISSION REQUEST · @${handle.toUpperCase()}`,
    title: 'Allow this command?',
    runsOn: 'Runs on your gateway',
    fine: 'Always allow applies to this exact command on this gateway. Change it later in Settings.',
    answeredElsewhere: 'Answered elsewhere',
    timedOut: 'Timed out',
    answered: (choice: string) => `Answered: ${choice}`,
    // The gateway's own vocabulary (`tools/approval_prompt.py`): once, session,
    // always, deny. An unknown choice keeps its own name rather than being
    // dropped — the buttons are exactly what the server offered.
    choices: {
      once: 'Allow once',
      session: 'Allow for this session',
      always: 'Always allow',
      deny: 'Deny'
    } as Record<string, string>
  },
  clarify: {
    eyebrow: 'A QUESTION FOR YOU',
    title: 'Before I continue',
    step: (current: number, total: number) => `Question ${current} of ${total}`,
    freeText: 'Or answer in your own words',
    freeTextPlaceholder: 'Type an answer…',
    lock: 'Lock answer',
    locked: 'Locked',
    submit: 'Submit',
    skip: 'Skip',
    next: 'Next',
    previous: 'Back',
    multiSelectHint: 'Choose as many as apply'
  },
  options: {
    title: 'Chat options',
    done: 'Done',
    subtitle: (bot: string) => `For this conversation with ${bot}`,
    yolo: 'YOLO mode',
    yoloHint: 'Skip approval requests',
    fast: 'Fast mode',
    fastHint: 'Prioritize response speed',
    reasoning: 'Reasoning effort',
    model: 'Model',
    modelSearch: 'Search models',
    verbosity: 'Verbosity',
    verbosityOptions: { quiet: 'Quiet', normal: 'Normal', verbose: 'Verbose' },
    showBotToBot: 'Show bot-to-bot',
    showThinking: 'Show thinking',
    viewHeader: 'What this conversation shows',
    useDefault: 'Use the default view',
    usingDefault: 'Following the default set in Settings.',
    usingOverride: 'This conversation has its own view.',
    expensiveTitle: 'This model costs more',
    expensiveConfirm: 'Use it anyway',
    cancel: 'Cancel'
  },
  sheet: {
    close: 'Close',
    grabber: 'Drag handle'
  }
} as const
