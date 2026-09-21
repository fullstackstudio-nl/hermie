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
    openInBrowser: 'Open in browser instead',
    /**
     * The accessible name of a sheet's backdrop — the layer a tap anywhere
     * outside the panel lands on.
     *
     * In `common` rather than in the sheet kit because every sheet in the app
     * shares one backdrop, and because it was the string that proved the
     * tables were not the only place names come from: it was a literal in
     * `ui/BottomSheet.tsx`.
     */
    dismiss: 'Dismiss'
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
      // The resolver really does try both, https first (`resolveGatewayAddress`
      // in packages/gateway-client). Until this said so, the behaviour existed
      // and nobody knew about it, so an address that only answers on http read
      // as a typo.
      hint: 'Leave the scheme out and Hermie tries https:// first, then http://. Type a scheme yourself to pin it.',
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
      /** Which scheme is in flight, so the wait is not a silent one. */
      probingScheme: (scheme: string) => `Checking ${scheme}…`,
      probingBoth: 'Checking https://, then http://…',
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
      subtitleCookie:
        'The gateway hosts the sign-in page. Your browser keeps the session it hands back; Hermie never sees it.',
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

      // Browser build only: the cookie flow.
      servedFrom: (host: string) => `Served by Hermie Web, talking to ${host}.`,
      servedFromUnknown: 'Served by Hermie Web.',
      probingGateway: 'Reading the gateway…',
      checkingSession: 'Checking whether you are already signed in…',
      leavingForProvider: 'Taking you to the sign-in page…',
      passwordUser: 'USER NAME',
      passwordSecret: 'PASSWORD',
      /*
       * The same two fields, said quietly, for the accessible name.
       *
       * Section headers in this app are written in capitals and the sign-in
       * form follows them, which is right on screen and wrong in an ear: a
       * screen reader given a control named `USER NAME` either shouts it or
       * spells it out a letter at a time. These are what the fields are CALLED;
       * the pair above is what is drawn.
       */
      passwordUserLabel: 'User name',
      passwordSecretLabel: 'Password',
      passwordSubmit: 'Sign in',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      cookieBlockedTitle: 'This gateway is too old for browser sign-in',
      cookieBlockedBody:
        'It requires a sign-in but does not advertise the cookie flow, which is the only one a browser tab can complete. Update Hermes on the gateway.',
      /**
       * Browser build only, and a dead end rather than a fault.
       *
       * A session-token gateway is perfectly current and the native apps sign
       * in to it happily. A browser tab cannot: there is no keychain, and
       * anything a page can write a page can read — which is why this build
       * carries no bearer token at all and authenticates with the gateway's own
       * cookie instead. Until this said so, the wizard simply showed a Continue
       * that could never be pressed, with nothing on the screen to do.
       */
      tokenBlockedTitle: 'This gateway cannot be used from a browser',
      tokenBlockedBody:
        'It authenticates with a session token, and a browser tab has nowhere safe to keep one — anything running in the page could read it. Use the Hermie app, or put the gateway behind an identity provider so it can issue a browser session.',
      signOutOfSession: 'Sign out',

      webview: {
        title: 'Sign in',
        loading: 'Opening the sign-in page…',
        exchanging: 'Completing sign-in…',
        timeout: 'The sign-in page was open for ten minutes without finishing. Start again when you are ready.',
        cancelled: 'Sign-in was cancelled.',
        unavailable:
          'The in-app browser is not available on this platform. Open the sign-in page in your browser, then paste the address it fails to open back here.',
        // Said when the reader ASKED for the browser. Telling them the in-app
        // page is unavailable would be a plain untruth, and it is the sentence
        // they would read while wondering what went wrong.
        chosen:
          'Open the sign-in page in your browser, then paste the address it fails to open back here. You can go back and use the in-app page instead.',
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
      running: 'Testing\u2026',
      retry: 'Try again',
      required: 'The connection has not been tested yet.',
      invalidated: 'Something changed since the last test, so it is running again.',
      connectedAs: (user: string, bots: number) => `Connected as ${user} · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      connected: (bots: number) => `Connected · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      noBots: 'The connection works, but this gateway has no bot profiles yet.',

      /**
       * The three things the test actually exercises, in the order it does
       * them. They are a checklist rather than one line because when a test
       * fails, WHICH half failed is the whole diagnosis: REST refused is a
       * credential, the socket refused is a reverse proxy.
       */
      checklist: {
        rest: 'REST',
        socket: 'WebSocket',
        profiles: 'Profiles'
      }
    },

    /**
     * The step between a working connection and a finished wizard.
     *
     * It has two faces because the gateway has two states, and they ask for
     * opposite things. With the plugin installed there is a switch to move and
     * the only question is whether to move it now. Without it there is nothing
     * the app can do at all, so the screen's whole job is to hand over two
     * commands and get out of the way — and to be skippable, because the person
     * setting the app up on a train is not the person with a shell open.
     */
    notifications: {
      title: 'Notifications',
      subtitle: 'Your gateway can tell this device when a bot answers, asks for something, or finishes a long task.',
      enable: 'Turn on notifications',
      enabling: 'Asking…',
      enabled: 'Notifications are on for this device.',
      denied: 'Permission was refused. You can turn it on later in your device settings.',
      skip: 'You can turn this on later in Settings.',

      missingTitle: 'Get push notifications',
      missingSubtitle:
        'This gateway has no Hermie plugin, so nothing there can send a notification. It installs with two commands on the machine running `hermes serve`.',
      missingHint:
        'Hermie never talks to the plugin. It reads what your gateway already knows, so there is no second address and nothing new to expose.',
      install: 'ON THE GATEWAY',
      copy: 'Copy',
      copied: 'Copied',
      guide: 'Open guide',
      fallback:
        'Already running Hermie Web with --push? That keeps working, and you can turn notifications on now. Do not run both — they would notify this device twice.'
    },

    done: {
      title: 'Ready',
      subtitle: 'Hermie will store the gateway address on this device and the credentials in the system secret store.',
      // Browser build: there is no credential to store. The session is a cookie
      // the gateway set and the browser keeps, and saying otherwise would
      // promise a keychain that is not there.
      subtitleCookie:
        'Hermie will remember this gateway in this browser. The session itself stays where the gateway put it \u2014 in a cookie Hermie cannot read.',
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

    /**
     * The second half of the search, and the one sentence that has to be right.
     *
     * The gateway answers one hit per conversation (see
     * `packages/gateway-client/src/session-search.ts`), so this heading counts
     * CHATS and never messages. "3 messages" over three rows that are three
     * different chats would be a number nobody could check.
     */
    messagesHeader: 'IN MESSAGES',
    messagesSearching: 'Searching messages…',
    messagesNone: 'No messages match.',
    messagesHint: 'Only the best match per chat is shown.',
    messageOpen: (bot: string) => `Open ${bot}’s chat at this message`,

    unreadLabel: (count: number) => (count === 1 ? '1 unread message' : `${count} unread messages`),
    offline: 'Offline — showing the last saved list.',
    footnote: 'Your conversations stay with your gateway.',
    sidebarHeader: 'CHATS',
    newCron: 'New cron'
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
    // Never seeded INTO the field — only ever the placeholder, and only ever the
    // heading a divider nobody has named yet shows. An older build pre-filled
    // the field with "New section", so the first thing typed was appended to it
    // and the owner's device still carries a section literally called
    // "New sectionFinance".
    unnamedSection: 'Untitled section',
    rename: 'Rename',
    remove: 'Remove',
    removeSection: (name: string) => `Remove the ${name || 'untitled'} section`,
    dividerName: 'Section name',
    editDividerHint: 'Type to rename this section.',
    sectionEmpty: 'No chats in this section',
    moveUp: 'Move up',
    moveDown: 'Move down',
    topGroup: 'No section',
    moveToSection: (section: string) => `Move to ${section}`,
    // The submenu's own heading, so its lines can be bare section names. The
    // sentence form above is still what the fallback sheet's flat rows say.
    moveToSectionMenu: 'Move to section',
    openChat: 'Open',
    markRead: 'Mark as read',
    addDividerAbove: 'Add divider above',
    dragHint: 'Hold and drag to reorder.',
    dragging: (name: string) => `Moving ${name}`,
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
      graphite: 'Graphite',
      slate: 'Slate',
      lime: 'Lime'
    },
    rowActions: (name: string) => `Actions for ${name}`,
    close: 'Close',

    /**
     * The rail's control, which says what the tap will DO rather than where it is.
     *
     * There is no matching `hideSidebar` here: the rail only ever shows, and the
     * only thing that hides is the chat column's button, whose wording travels
     * with the kit that draws it (`src/chat-ui/strings.ts`). One label per control
     * rather than a pair each has to pick from.
     */
    showSidebar: 'Show sidebar',
    /** The rail's own name, for the reader who lands on it with VoiceOver. */
    sidebarRail: 'Sidebar, hidden'
  },

  /**
   * The Mac's menu bar.
   *
   * Here rather than in Swift for the same reason every other string is: one
   * place to read the app's voice. `HermieMenuBar` is handed these and holds no
   * wording of its own, so a translation reaches the menu bar for free.
   */
  menuBar: {
    chats: 'Chats',
    search: 'Search…',
    settings: 'Settings…',
    close: 'Close',
    /**
     * Title Case, unlike everything else in this file, because a Mac menu bar is
     * the one surface where sentence case looks wrong next to the standard items
     * it sits among — View ▸ Enter Full Screen is Apple's, and `Hide sidebar`
     * beside it reads as a typo.
     */
    hideSidebar: 'Hide Sidebar',
    showSidebar: 'Show Sidebar'
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
    listNote: 'Showing the last saved list.',
    /**
     * One calm sentence naming what actually ended the session, shown under the
     * body when the auth ring knows.
     *
     * A session that ends without explanation reads as the app's fault, and the
     * only honest way to say otherwise is to say which thing happened. These are
     * kept apart on purpose: "the gateway rejected the saved sign-in" is
     * something only a new sign-in fixes, while "renewing did not complete" is a
     * network story that may well have fixed itself by the time it is read.
     */
    reason: {
      refreshRejected: 'The gateway rejected the saved sign-in, so the session could not be renewed.',
      refreshFailed: 'Renewing the session did not complete, so Hermie could not stay signed in.',
      noRefreshToken: 'There was nothing saved to renew the session with.',
      rejectedAfterRefresh: 'The gateway rejected the sign-in Hermie had just renewed.',
      tokenUnreadable: 'Hermie could not read the saved sign-in from the keychain.'
    }
  },

  /**
   * What the app says about a cleartext gateway.
   *
   * None of these is a refusal, and only the last one is a warning. A Hermes
   * gateway on a tailnet is normally served over plain http, because WireGuard
   * has already done the encrypting — telling that user off is how a warning
   * stops being read.
   */
  transport: {
    foundOverHttp: 'Found over http://',
    /** Said only when the reader left the scheme out, so the answer was in doubt. */
    foundOverHttps: 'Found over https://',
    httpLoopback: 'Plain http://, and this connection never leaves this machine.',
    httpLocalNetwork: 'Plain http://, to an address on a local network. It is not reachable from outside that network.',
    httpTailnet:
      'Plain http://, over a tailnet address. WireGuard has already encrypted the path between this device and the gateway.',
    httpExposed:
      'Plain http:// to a public address. Anyone on the path can read your messages and your sign-in. Use https://, or reach the gateway over a private network such as Tailscale.',
    useHttps: 'Use https instead'
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
    /**
     * The connection, said in the chat rather than in a banner.
     *
     * Not a failure and nothing to dismiss: the chat opens itself once the
     * socket is up. `connecting` names the gateway because on a first open it
     * is the only thing on screen and "Connecting…" on its own could be about
     * anything; the other two are what the header's subtitle already says, and
     * saying it differently two inches apart reads as two different facts.
     */
    connection: {
      connecting: 'Connecting to your gateway…',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
      /** Reset the backoff and dial now. Harmless at any time — see `retryNow`. */
      retry: 'Try now'
    },
    offlineCopy: 'Showing the last saved copy of this conversation.',
    stale: 'This conversation lost its connection to the gateway. It reattaches on the next open.',
    failed: (message: string) => `This conversation could not be opened: ${message}`,
    empty: 'Nothing has been said in this chat yet.',
    /**
     * A search hit opened this chat and the row is not in it.
     *
     * The gateway matched the conversation, not a row — it does not say which
     * one — so this is what honesty sounds like: the chat is the right one, the
     * message is further back than the transcript has, and the reader can scroll.
     */
    findMissed: (query: string) => `“${query}” is in this chat, further back than it has loaded.`,
    /**
     * The same miss, after paging back as far as this is willing to go.
     *
     * A different sentence from `findMissed` because it is a different fact. The
     * transcript now reaches the start of the conversation, or the search walked
     * back further than any reader would have, and in both cases the honest
     * thing is that the words the gateway matched are not in the projection this
     * app searches — a hit on a tool's arguments, for instance, which the FTS
     * index carries and the rendered item does not.
     */
    findExhausted: (query: string) =>
      `“${query}” was matched by the gateway, but it is not in the visible text of this chat.`,
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
    /**
     * The line under the bot's name.
     *
     * The top half is what the BOT is doing, from `turnActivity`, and the
     * bottom half is what the CONNECTION is doing. `working` is the honest
     * gap between the two: a turn has started and has not yet said which of
     * the others it is.
     *
     * `idle` says Online rather than Connected, because the reader is being
     * told about a bot and not about a socket — and it is the word the chat
     * list's own presence line already uses, which is the point.
     */
    subtitle: {
      working: 'Working…',
      thinking: 'Thinking…',
      typing: 'Typing…',
      /** `Running terminal…` — the tool's own name, as the gateway spells it. */
      running: (tool: string) => `Running ${tool}…`,
      waiting: 'Waiting for you',
      delegating: 'Delegating…',
      queued: 'Queued',
      idle: 'Online',
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
      /** Already a whole sentence from `FileUploadError`; this only frames it. */
      uploadFailed: (message: string) => `The file was not sent. ${message}`,
      permission: 'Hermie needs access to your photo library to attach an image. Allow it in Settings.',
      openSettings: 'Open Settings',
      /**
       * Chip-sized reasons. A file chip is about 260pt wide, so the typed
       * error's whole sentence does not fit — it stays in the notice, and the
       * chip says the part that decides what to do next.
       */
      chipTooLarge: (megabytes: number) => `Too large · ${megabytes} MB max`,
      chipNoWorkspace: 'No workspace to upload into',
      chipRefused: 'The gateway refused it',
      chipFailed: 'Upload failed'
    },
    expensiveModel: (message: string) => message || 'This model costs more than the current one.'
  },

  auth: {
    /**
     * A sign-in that produced no refresh token.
     *
     * One sentence, and every word of it is load-bearing: what will happen
     * ("cannot be refreshed"), where the cause is (the gateway's provider, not
     * this app or this device), and what fixes it (the `offline_access` scope).
     * A vaguer version of this reads as "something is wrong" and sends people
     * to re-install the app.
     */
    noRefreshToken:
      'This sign-in cannot be refreshed \u2014 it ends when its access token expires. The gateway\u2019s provider needs the offline_access scope.',
    noRefreshTokenLink: 'How to fix this'
  },

  settings: {
    title: 'Settings',
    gateway: 'GATEWAY',
    address: 'Address',
    /**
     * Browser build only, under the gateway's address.
     *
     * The row shows the GATEWAY's host while the address bar shows this app's,
     * and without this line the two read as a contradiction.
     */
    viaHermieWeb: 'via Hermie Web',
    provider: 'Provider',
    version: 'Version',
    user: 'Signed in as',
    authModeToken: 'Session token',

    /** Browser build only: the Hermie Web server this page came from. */
    webUpdate: {
      header: 'HERMIE WEB',
      running: 'Running',
      state: 'Update',
      checking: 'Checking\u2026',
      upToDate: 'Up to date',
      available: (version: string) => `${version} available`,
      apply: 'Update',
      updating: 'Downloading and installing\u2026',
      restarting: 'Restarting\u2026',
      failed: (reason: string) => `The update failed: ${reason}`,
      needsSignIn: 'Sign in to the gateway before updating Hermie Web.',
      restartTimedOut: 'Hermie Web did not come back within a minute. Check its logs.'
    },
    status: 'Status',
    plugin: 'Plugin',
    pluginInstalled: (version: string) => (version ? `Hermie plugin ${version}` : 'Hermie plugin'),
    pluginAbsent: 'Not installed',
    pluginUnknown: 'Checking…',

    /**
     * ADR-0017. The wording is doing a job: a reader has to be able to tell,
     * from this screen alone, that the notification will say a bot's NAME and
     * nothing else unless they say otherwise.
     */
    notifications: {
      header: 'NOTIFICATIONS',
      enabled: 'Notifications',
      enabledHint:
        'The Hermie plugin runs inside your gateway and sends a notification when a bot has news. Hermie Web with --push does the same job from outside, if a plugin cannot be installed.',
      denied: 'Notifications are turned off for Hermie in your device settings. Turn them on there first.',
      unavailable: 'This device cannot register for notifications. Nothing has been sent.',
      webInsecure: 'The browser only offers notifications when Hermie Web is served over https.',
      types: 'TELL ME ABOUT',
      typeMessage: 'New message',
      typeRequest: 'Needs input',
      typeCron: 'Routines',
      typeTurnDone: 'Finished working',
      typeTurnFailed: 'Something went wrong',
      typesHint:
        'A bot answering, a bot asking permission, a routine’s delivery, and a long task reaching its end either way. A turn you stopped yourself is never one of these.',
      preview: 'Show a preview',
      previewHint:
        'Off, a notification says which bot and what happened. On, it carries the message as well — and a lock screen is where it will be read.',

      /**
       * What this device's registration actually IS, in one row.
       *
       * The owner's gateway held a push section with a live heartbeat and no
       * registrations at all, and the app said nothing, because every way of
       * failing to obtain a token looked the same from above. Each line below
       * names one of them, and the ones worth trying again get the button.
       */
      status: 'Registration',
      statusOff: 'Off. This device is not registered.',
      statusPending: 'Asking the platform for an address…',
      statusRegistered: (tail: string) => `Registered · …${tail}`,
      statusDenied: 'Permission denied. Turn notifications on for Hermie in your device settings.',
      /*
        The Mac build, where no dialog is ever raised. It names the pane rather
        than describing it, and the button under it opens exactly that pane —
        the owner had to find it by hand before this existed, and until they
        did the switch looked broken.
      */
      statusSystemSettings: 'Turn on notifications for Hermie in System Settings → Notifications',
      openSystemSettings: 'Open Notifications settings',
      openSystemSettingsHint: 'Hermie stays switched on here and registers as soon as macOS allows it.',
      statusNoProject: 'This build has no EAS project id, so it cannot be given a push token. It needs rebuilding.',
      statusFailed: (message: string) => `Token request failed: ${message}`,
      statusUnsupported: (detail: string) => `This device cannot register: ${detail}`,
      retry: 'Retry',
      retryHint: 'Asks for permission again and re-requests a push token.'
    },

    /**
     * The device context the gateway plugin renders into a bot's prompt.
     *
     * Two jobs for the wording here, and the second is the harder one. The
     * first is to say what a bot will be told. The second is to be honest about
     * WHERE it is kept: this is not a setting on the phone, it is a section in
     * the gateway's own profile, and on a gateway shared with other people they
     * can read it. So the device facts are shown back verbatim rather than
     * described, and on a gateway with accounts nothing is written at all until
     * the reader has read that sentence and said yes.
     */
    context: {
      header: 'CONTEXT',
      hint: 'Your bots are told who they are talking to and what you are on. It is added to the start of a conversation, not to the messages.',
      unavailable: 'A gateway has to be connected before there is anywhere to keep this.',

      noticeTitle: 'Before this is shared',
      notice:
        'Stored in the gateway profile; everyone with access to this gateway can read it. That includes your name, your device and anything you write below.',
      noticeConfirm: 'I understand — share it',
      noticeDecline: 'Not now',
      noticePending: 'Nothing has been shared yet.',

      displayName: 'Use my name',
      displayNameHint: (name: string) => `Bots are told they are talking to ${name}.`,
      displayNameUnknown: 'The gateway has not said who you are, so there is no name to use.',

      about: 'About me / this device',
      aboutHint: 'Off by default. Anything here is added to every conversation on this gateway.',
      aboutPlaceholder: 'What a bot should know about you',
      aboutCount: (used: number, limit: number) => `${used} of ${limit} characters`,

      device: 'THIS DEVICE',
      deviceHint: 'Always sent, so a bot can answer with the right time and the right language.',
      deviceModel: 'Device',
      deviceOs: 'System',
      deviceApp: 'Hermie',
      deviceTimezone: 'Timezone',
      deviceLocale: 'Language',
      deviceUnknown: '—',

      perBot: 'PER CONVERSATION',
      perBotHint: 'A note only that bot sees, on top of everything above.',
      perBotPlaceholder: 'Nothing extra',
      perBotEmpty: 'No bots on this gateway yet.'
    },

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
    themeHint: 'System follows the device; Light and Dark pin the app either way.',
    preset: 'THEME',
    presetOptions: { blue: 'Blue', graphite: 'Graphite', lime: 'Lime' },
    /** Said under the cards, because a card shows the theme rather than naming it. */
    presetHint: 'Each theme has a light and a dark face; the setting above picks which one is showing.',

    /**
     * Themes the reader made.
     *
     * Kept behind a disclosure rather than under the cards: creating a theme is a
     * rare thing to want and a long thing to look at, and the six cards above are
     * the answer for everybody who does not want it.
     */
    themes: {
      header: 'YOUR THEMES',
      advanced: 'Advanced',
      advancedHint: 'Start from a theme above and change its colours.',
      back: 'Back to settings',
      create: 'New theme',
      createFrom: (preset: string) => `From ${preset}`,
      untitled: 'Untitled theme',
      name: 'Name',
      namePlaceholder: 'Theme name',
      rename: 'Rename',
      delete: 'Delete',
      deleteConfirm: (name: string) => `Delete “${name || 'Untitled theme'}”?`,
      deleteHint: 'The theme is removed everywhere this gateway is signed in.',
      keepIt: 'Keep it',
      empty: 'No themes of your own yet. Start one from a preset and edit its colours.',
      editing: (scheme: string) => `Editing the ${scheme} face`,
      editingHint: 'Switch the setting above to edit the other face.',
      background: 'Background',
      accentFill: 'Accent',
      accentBubble: 'Your bubbles',
      followPreset: 'Follow the preset',
      colourPlaceholder: '#RRGGBB',
      /** The contrast guard, in the reader's words. */
      rejected: (reason: string) => `That colour is not used: ${reason}`,
      reasonMalformed: 'a colour is six hex digits after a #.',
      reasonBubble: (ratio: string) => `white text on it measures ${ratio} : 1, and needs 4.5 : 1.`,
      reasonBackground: (ratio: string) => `the app’s text on it measures ${ratio} : 1, and needs 4.5 : 1.`,
      reasonAccentFill: (ratio: string) =>
        `it measures ${ratio} : 1 against the surface behind it, and a mark needs 3 : 1.`
    },
    about: 'ABOUT',
    licences: 'Licences',
    licencesHint: 'The open-source packages Hermie is built from, and what each one asks for.',
    licencesSummary: (count: number) =>
      count === 1
        ? '1 package ships inside Hermie.'
        : `${count} packages ship inside Hermie. Tap one to read its licence.`,
    licencesBack: 'Back to settings',
    licencesLoading: 'Loading the licences…',
    licencesFailed: (message: string) => `The licence list could not be loaded: ${message}`,
    licencesRetry: 'Try again',
    /** A package that names no licence at all. The text it ships is then the whole statement. */
    licencesUndeclared: 'no licence declared',
    licencesNoText: 'This package ships no licence file. The identifier above is everything it declares.',
    licencesScope: (excluded: number) =>
      `Production dependencies only; development tooling and Hermie's own ${excluded} workspace packages are not in the list.`,
    licencesGeneratedBy: (script: string) => `Generated by ${script}, alongside THIRD_PARTY_LICENSES.md.`
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
    /**
     * The same failure, for an address the reader pinned `https://` on
     * themselves. React Native's fetch discards the underlying error, so a
     * certificate this device will not accept and a host that never answered
     * arrive here as the same flat failure — and only one of the two is worth
     * checking the gateway over. Both are named, and so is the way out that
     * costs nothing to try, because the resolver never looked at http:// for a
     * scheme the reader pinned.
     */
    networkOverHttps: (host: string) =>
      `Could not reach ${host} over https://. It is either not answering there, or serving a certificate this device does not trust. Leave the https:// off and Hermie will try http:// as well.`,
    /**
     * Covers both halves of a failed handshake: a certificate this device will
     * not accept, and a port that is not speaking TLS at all. The second is
     * common on a private network, and naming only the certificate sent people
     * looking for one that was never offered.
     */
    tls: (host: string) =>
      `The secure connection to ${host} failed. A self-signed certificate has to be trusted by this device first — or, if the gateway serves plain http there, leave the https:// off and let Hermie find it.`,
    timeout: (host: string) => `${host} did not answer in time. It may be starting up or behind a slow link.`,
    notHermes: (host: string) =>
      `${host} answered, but not like a Hermes gateway. Check the address and any path prefix.`,
    /**
     * Where the answer came from.
     *
     * The iOS URL cache keeps a 301 keyed by bundle id and it survives deleting
     * the app, so a gateway that moved domains once left a redirect behind that
     * a fresh install's first probe was answered out of — silently, months
     * later, reaching a host the owner had left. Nothing is read from it now,
     * and the sentence names the host so the offer under it can be pressed.
     */
    redirected: (from: string, to: string) =>
      `${from} redirected to ${to}, which is a different host. Nothing was read from it.`,
    useRedirectTarget: (host: string) => `Use ${host} instead`,
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
