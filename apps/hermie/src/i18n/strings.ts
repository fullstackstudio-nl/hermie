/**
 * Every user-visible string in one plain object.
 *
 * There is no i18n library yet and no locale negotiation: the app ships in
 * English. What this module buys today is a single place to read the app's
 * voice, and a seam that a real catalogue can slot into later without touching
 * a screen. Strings that interpolate are functions rather than templates with
 * placeholders, so the type checker catches a missing argument.
 *
 * The chat UI kit keeps its own copy in `src/chat-ui/strings.ts`. That is on
 * purpose and not an oversight: the kit is a self-contained set of components
 * with its own gallery, and a component that travels with its wording can be
 * lifted out without dragging this file along. Everything a SCREEN says lives
 * here; everything a KIT COMPONENT says lives there.
 */

const list = (items: string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  const head = items.slice(0, -1).join(', ')

  return `${head} or ${items[items.length - 1]}`
}

export const strings = {
  app: {
    name: 'Hermie',
    loading: 'Starting…'
  },

  common: {
    back: 'Back',
    cancel: 'Cancel',
    continue: 'Continue',
    retry: 'Try again',
    signIn: 'Sign in',
    done: 'Done',
    add: 'Add',
    remove: 'Remove',
    openInBrowser: 'Open in browser instead'
  },

  onboarding: {
    stepCounter: (current: number, total: number) => `Step ${current} of ${total}`,

    welcome: {
      title: 'Welcome to Hermie',
      body: 'Hermie is a client for Hermes Agent. It talks to one gateway at a time — the machine running `hermes serve` — and chats with the bots that live there.',
      note: 'Nothing is stored until the connection has been tested.',
      action: 'Set up a gateway'
    },

    address: {
      title: 'Gateway address',
      subtitle: 'The address you would open in a browser to reach the gateway dashboard.',
      label: 'ADDRESS',
      placeholder: 'hermes.example.com',
      hint: 'Without a scheme, Hermie assumes https://.',
      advanced: 'Advanced',
      advancedHint:
        'Extra request headers are sent with every call and with the sign-in page. An access proxy such as Cloudflare Access needs them here.',
      headerName: 'Header',
      headerValue: 'Value',
      addHeader: 'Add a header',
      showValue: 'Show value',
      hideValue: 'Hide value',
      removeHeader: (name: string) => `Remove the ${name || 'empty'} header`,
      probing: 'Checking…',
      signInRequired: (version: string, providers: string[]) =>
        `Hermes ${version || 'gateway'} · sign-in required via ${list(providers)}`,
      signInRequiredNoProviders: (version: string) =>
        `Hermes ${version || 'gateway'} · sign-in required, but this gateway lists no identity providers. Configure one on the gateway.`,
      sessionTokenRequired: (version: string) => `Hermes ${version || 'gateway'} · session token required`
    },

    signIn: {
      title: 'Sign in',
      subtitleNative:
        'The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device.',
      subtitleToken:
        'This gateway is not gated by an identity provider; it authenticates with the session token it prints at startup.',
      chooseProvider: 'PROVIDER',
      signInWith: (provider: string) => `Sign in with ${provider}`,
      signedInAs: (user: string) => `Signed in as ${user}`,
      signedIn: 'Signed in',
      signOutAndRetry: 'Sign in again',
      blockedTitle: 'This gateway is too old for native sign-in',
      blockedBody:
        'It requires a sign-in but does not advertise the native_pkce flow, which is the only one a mobile app can complete. Update Hermes on the gateway.',
      tokenLabel: 'SESSION TOKEN',
      tokenHelp: 'Paste the session token printed by `hermes serve`.',
      tokenPlaceholder: 'Session token',
      showToken: 'Show token',
      hideToken: 'Hide token',

      webview: {
        title: 'Sign in',
        loading: 'Opening the sign-in page…',
        exchanging: 'Completing sign-in…',
        timeout: 'The sign-in page was open for ten minutes without finishing. Start again when you are ready.',
        cancelled: 'Sign-in was cancelled.',
        unavailable:
          'The in-app browser is not available on this platform. Open the sign-in page in your browser, then paste the address it fails to open back here.',
        headersWithheld:
          'This gateway needs extra headers, and Android\u2019s in-app browser would forward them to your identity provider. Sign in in your browser instead, then paste the address it fails to open back here.',
        fallbackLabel: 'FAILED ADDRESS',
        fallbackPlaceholder: 'http://127.0.0.1:38007/callback?code=…',
        fallbackHelp:
          'The browser will fail to load a 127.0.0.1 address — that is expected. Copy it out of the address bar and paste it here.',
        fallbackSubmit: 'Use this address',
        stateMismatch:
          'The sign-in response did not belong to this attempt and was discarded. Start the sign-in again.',
        noCode: 'The sign-in finished without an authorization code. Start the sign-in again.',
        providerError: (error: string, description: string) =>
          description
            ? `The gateway refused the sign-in: ${description} (${error})`
            : `The gateway refused the sign-in: ${error}`,
        httpError: (status: number) => `The sign-in page answered HTTP ${status}. Check the gateway's public address.`,
        loadError: (message: string) => `The sign-in page could not be loaded: ${message}`
      }
    },

    test: {
      title: 'Test connection',
      subtitle: 'Hermie checks the REST surface and then opens the WebSocket, exactly as it will during use.',
      run: 'Test connection',
      running: 'Testing…',
      required: 'Run the test before finishing setup.',
      invalidated: 'Something changed since the last test. Run it again.',
      connectedAs: (user: string, bots: number) => `Connected as ${user} · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      connected: (bots: number) => `Connected · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      noBots: 'The connection works, but this gateway has no bot profiles yet.'
    },

    done: {
      title: 'Ready',
      subtitle: 'Hermie will store the gateway address on this device and the credentials in the system secret store.',
      gateway: 'GATEWAY',
      finish: 'Start chatting',
      saving: 'Saving…',
      saveFailed: (message: string) => `The settings could not be saved: ${message}`
    }
  },

  bots: {
    title: 'Chats',
    empty: 'This gateway has no bot profiles yet. Create one with `hermes profile create`.',
    loading: 'Reading the roster…',
    failed: (message: string) => `The bot list could not be loaded: ${message}`,
    noPreview: 'No messages yet',
    running: 'working',
    unread: 'New',
    needsInput: 'Needs your input',
    defaultBot: 'Default',
    search: 'Search chats',
    section: 'MESSAGES',
    conversations: (count: number) => (count === 1 ? '1 conversation' : `${count} conversations`),
    noMatches: (query: string) => `No conversation matches “${query}”.`,
    unreadLabel: (count: number) => (count === 1 ? '1 unread message' : `${count} unread messages`),
    offline: 'Offline — showing the last saved list.',
    footnote: 'Your conversations stay with your gateway.',
    sidebarHeader: 'CHATS',
    newCron: 'New cron',
    filters: {
      all: 'All',
      unread: 'Unread',
      working: 'Working',
      needsInput: 'Needs input'
    },
    noneMatchFilter: 'No conversation is in that state right now.'
  },

  /**
   * The four presence states, in words.
   *
   * The bead never carries the state on colour alone — these are what the row
   * and the chat header say out loud, and what a screen reader reads.
   */
  presence: {
    online: 'Online',
    working: 'Working…',
    needsInput: 'Needs input',
    offline: 'Offline',
    offlineSince: (time: string) => `Offline · last seen ${time}`
  },

  /** Arranging the list. All of it is local to this device — see ADR-0012. */
  layout: {
    edit: 'Edit',
    done: 'Done',
    editHint: 'Reorder rows and move them between sections.',
    addDivider: 'Add divider',
    newDividerName: 'New section',
    rename: 'Rename',
    remove: 'Remove',
    dividerName: 'Section name',
    moveUp: 'Move up',
    moveDown: 'Move down',
    topGroup: 'No section',
    moveToSection: (section: string) => `Move to ${section}`,
    archive: 'Archive',
    unarchive: 'Unarchive',
    archived: (count: number) => `Archived (${count})`,
    archivedPreview: 'Archived · excluded from filters and counts',
    colour: 'Colour',
    colourOf: (name: string) => `Colour for ${name}`,
    accents: {
      default: 'Default',
      indigo: 'Indigo',
      violet: 'Violet',
      magenta: 'Magenta',
      red: 'Red',
      orange: 'Orange',
      teal: 'Teal',
      green: 'Green',
      graphite: 'Graphite'
    },
    rowActions: (name: string) => `Actions for ${name}`,
    close: 'Close'
  },

  /**
   * The signed-out state, which used to be a small link in a corner and was not
   * noticed. It is now the only thing in the content column.
   */
  signedOut: {
    title: 'Signed out',
    body: (host: string) => `Your session on ${host} has expired, so Hermie cannot reach your bots until you sign in.`,
    bodyNoHost: 'Your session has expired, so Hermie cannot reach your bots until you sign in.',
    signIn: 'Sign in',
    changeGateway: 'Change gateway',
    listNote: 'Showing the last saved list.'
  },

  gateway: {
    connectionSettings: 'Connection settings',
    latency: (ms: number) => `${ms} ms`,
    noHost: 'No gateway'
  },

  activity: {
    title: 'Activity',
    subtitle: 'Messages between your bots, and the agents they put to work.',
    empty:
      'Your bots have not talked to each other yet. When one messages another or delegates a task, it shows up here.',
    emptyOffline: 'Nothing to show while the gateway is out of reach.',
    loading: 'Reading every conversation…',
    failed: (message: string) => `The timeline could not be loaded: ${message}`,
    today: 'Today',
    yesterday: 'Yesterday',
    counters: {
      working: 'Bots working',
      subagents: 'Sub-agents',
      deliveries: 'Deliveries out'
    },
    /** `researcher → writer`. */
    to: (from: string, to: string) => `${from} → ${to}`,
    /**
     * `writer ↩ researcher`.
     *
     * The variation selector is load-bearing: iOS gives U+21A9 an EMOJI
     * presentation by default, so the arrow renders as a blue glyph in the
     * middle of a sentence unless it is explicitly asked for as text.
     */
    reply: (from: string, to: string) => `${from} \u21a9\ufe0e ${to}`,
    spawned: (bot: string, count: number) => `${bot} spawned ${count} ${count === 1 ? 'agent' : 'agents'}`,
    groupStatus: {
      dispatched: 'dispatched',
      running: 'running',
      done: 'done',
      failed: 'failed'
    } as Record<string, string>,
    openChat: (bot: string) => `Open the chat with ${bot}`
  },

  tabs: {
    chats: 'Chats',
    activity: 'Activity',
    routines: 'Crons',
    settings: 'Settings'
  },

  chat: {
    send: 'Send',
    stop: 'Stop',
    hydrating: 'Loading the conversation…',
    /** Not a failure: the chat opens itself once the socket is up, so there is nothing to press. */
    waitingForConnection: 'Waiting for the gateway. This conversation opens as soon as it answers.',
    offlineCopy: 'Showing the last saved copy of this conversation.',
    stale: 'This conversation lost its connection to the gateway. It reattaches on the next open.',
    failed: (message: string) => `This conversation could not be opened: ${message}`,
    empty: 'Nothing has been said in this chat yet.',
    unknownAuthor: 'Someone else started a turn…',
    thinking: 'Thinking',
    toolRunning: 'running',
    approvalTitle: 'Approval requested',
    clarifyTitle: 'The bot has a question',
    answered: (answer: string) => `Answered: ${answer}`,
    cancelled: 'Withdrawn',
    subagents: (count: number) => (count === 1 ? '1 subagent running' : `${count} subagents running`),
    retry: 'Try again',
    pickBot: 'Pick a conversation to start reading.',
    subtitle: {
      working: 'Working…',
      queued: 'Queued',
      connected: 'Connected',
      offline: 'Offline',
      reconnecting: 'Reconnecting…',
      connecting: 'Connecting…',
      signedOut: 'Signed out'
    },
    attach: {
      photo: 'Photo library',
      file: 'File',
      cancel: 'Cancel',
      title: 'Add an attachment',
      failed: (message: string) => `The attachment could not be added: ${message}`,
      permission: 'Hermie needs access to your photo library to attach an image. Allow it in Settings.',
      openSettings: 'Open Settings'
    },
    expensiveModel: (message: string) => message || 'This model costs more than the current one.'
  },

  settings: {
    title: 'Settings',
    gateway: 'GATEWAY',
    address: 'Address',
    provider: 'Provider',
    version: 'Version',
    user: 'Signed in as',
    authModeToken: 'Session token',
    status: 'Status',
    account: 'ACCOUNT',
    signOut: 'Sign out',
    signOutHint: 'Clears the stored credentials and keeps the gateway address.',
    changeGateway: 'Change gateway',
    changeGatewayHint: 'Forgets this gateway completely and starts setup again.',
    changeGatewayConfirm: 'Forget this gateway and everything stored for it?',
    confirm: 'Forget it',
    keepIt: 'Keep it',
    developer: 'DEVELOPER',
    connectionTest: 'Connection test',
    unknown: 'Unknown',
    chat: 'CHAT',
    defaultVerbosity: 'Default verbosity',
    defaultVerbosityHint:
      'How much of a bot’s working-out a new conversation shows. A conversation with its own setting keeps it.',
    showBotToBot: 'Show bot-to-bot',
    showThinking: 'Show thinking',
    appearance: 'APPEARANCE',
    theme: 'Theme',
    themeOptions: { system: 'System', light: 'Light', dark: 'Dark' },
    wallpaper: 'Wallpaper',
    wallpaperOptions: { blue: 'Blue', warm: 'Warm', graphite: 'Graphite' }
  },

  connection: {
    status: {
      disconnected: 'Disconnected',
      probing: 'Checking the gateway…',
      authenticating: 'Authenticating…',
      connecting: 'Connecting…',
      ready: 'Connected',
      reconnecting: 'Reconnecting…',
      paused: 'Paused',
      offline: 'Offline',
      needs_signin: 'Signed out',
      incompatible: 'Not supported'
    },
    reauth: {
      message: 'Your session on this gateway has expired.',
      action: 'Sign in',
      tokenAction: 'Update token',
      saving: 'Signing in…'
    }
  },

  errors: {
    network: (host: string) =>
      `Could not reach ${host}. Check the address, and that the gateway is running and reachable from this device.`,
    tls: (host: string) =>
      `The TLS certificate for ${host} was rejected. A self-signed certificate has to be trusted by this device before Hermie can use it.`,
    timeout: (host: string) => `${host} did not answer in time. It may be starting up or behind a slow link.`,
    notHermes: (host: string) =>
      `${host} answered, but not like a Hermes gateway. Check the address and any path prefix.`,
    authProxy: (status: number) =>
      `An access proxy answered HTTP ${status} before the gateway did. Add its headers under Advanced, or exempt /api/status, /auth/* and /login from it.`,
    server: (status: number) => `The gateway answered HTTP ${status}. It is running but unhealthy; check its logs.`,
    providersUnavailable:
      'The gateway requires a sign-in but reports no identity providers. Configure one on the gateway and try again.',
    signedOut: 'The gateway rejected the credentials. Sign in again.',
    closeAuth: 'The gateway rejected the credentials when the WebSocket opened. Sign in again.',
    closeHost:
      'The gateway does not trust this address. Set its `dashboard.public_url` to the address you entered and restart it.',
    closeTakenOver: 'Another client took this connection over. Close the other client and test again.',
    closeChatOff: 'Chat is switched off on this gateway.',
    closeAbnormal:
      'The WebSocket closed without a reason. A proxy in front of the gateway usually has to be configured to pass WebSocket upgrades through.',
    incompatible: 'This gateway is too old for Hermie. Update Hermes on the gateway.',
    unknown: 'Something went wrong.'
  }
} as const
