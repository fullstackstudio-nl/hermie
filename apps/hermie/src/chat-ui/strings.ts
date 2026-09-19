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
  /** The `Show more` / `Show less` pair, shared by every fold in the kit. */
  fold: {
    more: 'Show more',
    less: 'Show less'
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
    /** The collapsed line's own label: `Message to @writer`. */
    lineTo: (handle: string) => `Message to @${handle}`,
    replied: (name: string) => `${name} replied`,
    sending: 'Sending…',
    queued: 'Queued · waiting for the current task',
    delivered: 'Delivered ✓',
    failed: 'Failed',
    ambiguous: 'Ambiguous target',
    unknown: 'Sent',
    showMore: 'Show more',
    showLess: 'Show less',
    /**
     * The reply marker at the right of a collapsed line. Always present, always
     * static: §5's motion rule puts waiting on a hollow dot, not a blink.
     */
    marker: {
      // U+FE0E after the arrow. Without the text variation selector iOS gives
      // U+21A9 its emoji presentation and a blue glyph lands in the middle of a
      // metadata line — the same trap the Activity timeline hit.
      replied: '↩︎ replied',
      waiting: 'Delivered · waiting for reply',
      failed: 'Failed'
    },
    /** The roll-up more than three consecutive lines collapse into. */
    rollup: (count: number, handle: string, replies: number) =>
      `${count} messages to @${handle} · ${replies} ${replies === 1 ? 'reply' : 'replies'}`,
    /** The same roll-up where the run went to more than one teammate. */
    rollupMixed: (count: number, replies: number) =>
      `${count} messages · ${replies} ${replies === 1 ? 'reply' : 'replies'}`,
    /** The one place a DM line is allowed to navigate away from this chat. */
    openChat: (handle: string) => `Open @${handle}’s chat`,
    sent: 'Sent',
    reply: 'Reply',
    answered: '↩︎ answered',
    senderChip: (name: string) => `${name} · bot`,
    header: (from: string, to: string) => `@${from} → @${to}`,
    chip: (target: string) => `Message to ${target}`,
    inChip: (name: string) => `Message from ${name}`,
    /** Shown under a pending dispatch while the recipient's turn is running. */
    targetTyping: (handle: string) => `@${handle} is writing…`,
    openTarget: (target: string) => `Opens the chat with ${target}`,
    openSender: (name: string) => `Opens the chat with ${name}`
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
    transcriptTitle: (goal: string) => `Transcript · ${goal}`,
    transcriptLive: 'Live tail · refreshing every few seconds',
    transcriptStored: 'The child’s own transcript, read-only.',
    transcriptEmpty: 'This agent has not written anything readable yet.',
    transcriptBack: 'Back to the agents',
    steerQueued: 'Steer queued',
    steerRejected: 'Too late to steer — the agent had already finished its last batch.',
    stopped: 'Stopping…',
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
  /**
   * The scheduled-jobs feature is called CRONS everywhere (§6.5) — the nav
   * label, the list, the card. Not "scheduled jobs" in one place and "Crons" in
   * another.
   */
  cron: {
    eyebrow: 'CRON',
    /**
     * The gateway redacts a job name it could not scrub, and the placeholder it
     * substitutes would read as the job's actual name on a card. So the card says
     * nothing about the name rather than something false.
     */
    unnamed: 'Scheduled job',
    ranAt: (time: string) => `ran ${time} · delivered to this chat`,
    delivered: 'delivered to this chat',
    emptyBody: 'The job delivered nothing to show.',
    open: 'Open cron',
    runNow: 'Run now'
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
    /** The field's accessibility label once the chat knows whose it is. */
    messageTo: (bot: string) => `Message ${bot}`,
    send: 'Send message',
    stop: 'Stop response',
    attach: 'Add attachment',
    photoLibrary: 'Photo library',
    chooseFile: 'Choose file',
    /** Shown under the field only where a bare Return sends. */
    keyHint: 'Enter to send · Shift+Enter for a new line',
    removeAttachment: 'Remove attachment',
    queued: (text: string) => `↳ 1 message queued · “${text}”`,
    slashHint: 'Commands'
  },
  header: {
    back: 'Back to chats',
    options: 'Chat options',
    running: 'Running',
    idle: 'Online',
    needsInput: 'Waiting for you',
    offline: 'Offline',
    offlineAt: (time: string) => `Offline · last seen ${time}`
  },
  approval: {
    eyebrow: (handle: string) => `PERMISSION REQUEST · @${handle.toUpperCase()}`,
    title: 'Allow this command?',
    runsOn: 'Runs on your gateway',
    fine: 'Always allow applies to this exact command on this gateway. Change it later in Settings.',
    answeredElsewhere: 'Answered elsewhere',
    timedOut: 'Timed out',
    answered: (choice: string) => `Answered: ${choice}`,
    // The receipt an answered approval leaves in the transcript. It names the
    // decision, not the button: "once" on its own tells a reader nothing a week
    // later, and `Answered: once` was worse — it did not even say allowed.
    outcomes: {
      once: 'Allowed once',
      session: 'Allowed for the session',
      always: 'Always allowed',
      deny: 'Denied'
    } as Record<string, string>,
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
    // Not "Skip": the button only takes the sheet off the screen. The question
    // stays open on the gateway and stays answerable from the transcript, and
    // a label that promised to skip it would be a lie about what the agent is
    // still waiting for.
    later: 'Later',
    outcome: (answered: number, total: number) =>
      answered >= total ? (total === 1 ? 'Answered' : `Answered all ${total}`) : `Answered ${answered} of ${total}`,
    next: 'Next',
    previous: 'Back',
    multiSelectHint: 'Choose as many as apply'
  },
  options: {
    eyebrow: 'This chat',
    colourHint: 'Tints this chat\u2019s avatar ring, its row in the list and the messages you send.',
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
    close: 'Close'
  }
} as const
