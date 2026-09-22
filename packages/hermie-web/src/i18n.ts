/**
 * The three server-rendered pages' own languages: `/setup`, `/admin` and
 * `/oidc`, negotiated on `Accept-Language`.
 *
 * These pages are NOT part of the app bundle — they are painted by this package
 * before anything is configured, and on the morning the bundle does not load —
 * so they cannot reach into `apps/hermie/src/i18n/`. They carry their own small
 * tables instead, and keep the same three rules that file tree keeps
 * (`docs/i18n.md`):
 *
 *  - **English is the source, not a fallback of last resort.** Every sentence is
 *    authored in English; a catalogue supplies another language for the strings
 *    somebody has got to, and a key with no translation paints the English one.
 *    That is what lets a round add copy without stopping to translate it.
 *  - **The KIND of a key is not optional.** A key that interpolates is a
 *    function, and a catalogue that answers it with a bare string is ignored:
 *    a missing argument would be a sentence with a hole in it.
 *  - **The glossary holds.** `Hermie`, `Hermes`, `gateway`, `token`, `OIDC`,
 *    `VAPID`, `push`, `scrypt`, every URL, every path and every shell command
 *    stay in English in all three languages, because a reader who translates
 *    them here has to translate them back the moment they open the gateway's
 *    own dashboard.
 *
 * Zero dependencies, on purpose and permanently: the released artefact is a
 * self-contained CommonJS `dist/server` with no `node_modules` beside it, so
 * nothing outside this package may be imported except `node:` builtins.
 *
 * ## Why the device's language and not a setting
 *
 * There is no language picker here and there should not be one. A reader meets
 * `/oidc/authorize` once per sign-in and has nowhere to keep a preference; the
 * operator meets `/setup` once in the life of a deployment. `Accept-Language`
 * is the only thing either of them has already said.
 */
import type { IncomingMessage } from 'node:http'

/** The languages these pages are painted in. English is the source. */
export type WebLocale = 'en' | 'nl' | 'de'

export const WEB_LOCALES: readonly WebLocale[] = ['en', 'nl', 'de']

const isWebLocale = (value: string): value is WebLocale => (WEB_LOCALES as readonly string[]).includes(value)

/** One entry of an `Accept-Language` header, once it has been read. */
interface LanguageRange {
  /** The primary subtag, lowercased: `nl-BE` is `nl`, because there is no Flemish copy. */
  language: string
  /** The `;q=` weight, `1` where the entry carried none. */
  quality: number
  /** Where it stood in the header, so equal weights keep the order the client wrote. */
  position: number
}

/**
 * Read `Accept-Language` and answer one of the three languages.
 *
 * A real parse rather than a `startsWith`, because the header a browser sends
 * is routinely `nl-BE,nl;q=0.9,en-US;q=0.8,en;q=0.7` and everything that
 * matters is in the parts a prefix match throws away: the weights decide the
 * order rather than the position, `q=0` is a REFUSAL rather than a weak
 * preference, and the region is dropped because Hermie has no Flemish or
 * Austrian copy and pretending otherwise would mean catalogues that are 99%
 * the same.
 *
 * Every way of being wrong ends in English: an empty header, a header of
 * punctuation, a weight that is not a number, a language nobody here speaks.
 * That is the same answer the app gives a device it does not recognise, and it
 * is the safe one — English is the language every sentence here was written in,
 * so it is the only one that is complete by construction.
 */
export function negotiateLocale(header: string | undefined | null): WebLocale {
  if (!header) {
    return 'en'
  }

  const ranges: LanguageRange[] = []

  header.split(',').forEach((entry, position) => {
    const parts = entry.split(';')
    const tag = (parts[0] ?? '').trim().toLowerCase()

    // `*` is "anything you have", which is what the default already is.
    if (!tag || tag === '*') {
      return
    }

    const language = tag.split('-')[0] ?? ''

    if (!/^[a-z]{2,8}$/.test(language)) {
      return
    }

    let quality = 1

    for (const parameter of parts.slice(1)) {
      const match = /^\s*q\s*=\s*(\d+(?:\.\d+)?)\s*$/i.exec(parameter)

      // A parameter that is not a weight — `;level=1` and friends — says
      // nothing about preference, so it is passed over rather than fatal.
      if (!match) {
        continue
      }

      const value = Number(match[1])

      // A weight outside 0..1 is not a weight. The entry carrying it is dropped
      // rather than guessed at, which is how a malformed header ends up
      // answering English.
      if (!Number.isFinite(value) || value > 1) {
        return
      }

      quality = value
    }

    // `q=0` means "not this one", and a refused language can never be chosen,
    // not even when it is the only one left in the header.
    if (quality === 0) {
      return
    }

    ranges.push({ language, quality, position })
  })

  ranges.sort((left, right) => right.quality - left.quality || left.position - right.position)

  for (const range of ranges) {
    if (isWebLocale(range.language)) {
      return range.language
    }
  }

  return 'en'
}

/** The language one incoming request asked for. */
export function localeOf(request: IncomingMessage): WebLocale {
  const raw = request.headers['accept-language']

  return negotiateLocale(Array.isArray(raw) ? raw[0] : raw)
}

/** What goes in `<html lang="…">`. The primary subtag, because that is all these pages know. */
export function htmlLang(locale: WebLocale): string {
  return locale
}

/**
 * Every human-readable sentence on the three pages.
 *
 * A function wherever the copy interpolates, so a translation can put the value
 * where its own grammar wants it rather than where English wanted it.
 *
 * **Interpolated values arrive already escaped.** Several of these sentences
 * carry markup of their own — `<code>`, `<strong>`, `<em>` — so a table is
 * trusted source and the values handed to it are run through `escapeHtml` by
 * the caller first. A catalogue is source code in this repository; a user id is
 * not.
 */
export interface WebStrings {
  common: {
    signIn: string
    save: string
    /** The `<h1>` of both administration pages. */
    administration: string
    /** Their `<title>`, which is longer because a tab strip has no context. */
    administrationTitle: string
    administratorSecret: string
    yes: string
    no: string
  }
  setup: {
    /** Both the `<title>` and the `<h1>`. */
    title: string
    intro: string
    gatewayHeading: string
    gatewayIntro: string
    addressLabel: string
    probeButton: string
    loginHeading: string
    loginIntro: string
    loginNote: string
    providerLabel: string
    providerPlaceholder: string
    saveHeading: string
    saveIntro: string
    adminSecretLabel: string
    adminSecretNote: string
    saveButton: string
    footer: (version: string) => string
    /**
     * The sentences the inline script says.
     *
     * Injected into the page as one JSON literal rather than spliced in one at
     * a time, so there is a single place where the escaping has to be right.
     * The two that interpolate are rendered with `{name}` markers and filled in
     * by the script: a function cannot cross into a `<script>` element, and a
     * translation has to stay free to reorder the pieces around the value.
     */
    script: {
      probing: (address: string) => string
      probed: (version: string, flows: string) => string
      noSignIn: string
      didNotWork: string
      asking: string
      saving: string
      savedNothingCanAdmin: string
      savedOpening: string
      loginStored: string
    }
    /** The page the gateway's redirect lands on at the end of the service login. */
    callback: {
      nothingWaitingTitle: string
      nothingWaitingDetail: string
      failedTitle: string
      noCode: string
      signedInTitle: string
      signedInDetail: string
      back: string
    }
  }
  admin: {
    signIn: {
      intro: string
      secretNote: string
      wrongSecret: string
    }
    forbidden: {
      title: string
      knownAs: (viewer: string) => string
      unknown: string
      note: string
    }
    header: (version: string, gatewayUrl: string) => string
    service: {
      heading: string
      version: string
      upToDate: string
      updateAvailable: (version: string) => string
      serviceLogin: string
      pushDaemon: string
      running: string
      notRunning: string
      vapidKey: string
      messageCache: string
      cacheOff: string
      cacheFill: (entries: number, used: string, cap: string) => string
      cacheHits: string
      hitRate: (percent: number, total: number) => string
      nothingAsked: string
      userList: string
      fromGateway: string
      fromSeen: string
      updateButton: string
      updateUnavailable: string
    }
    push: {
      heading: string
      intro: string
      previewLabel: string
      previewDevice: string
      previewNever: string
      saveButton: string
    }
    cache: {
      heading: string
      retentionLabel: string
      capNote: string
      clearButton: string
    }
    identity: {
      heading: string
      on: (issuer: string, accounts: number) => string
      off: string
      link: string
    }
    branding: {
      heading: string
      intro: string
      nameLabel: string
      accentLabel: string
      themeLabel: string
      note: string
      saveButton: string
    }
    features: {
      heading: string
      userChats: string
      messageCache: string
      selfUpdate: string
      saveButton: string
    }
    people: {
      heading: string
      intro: string
      empty: string
      who: string
      lastSeen: string
      bots: string
      readOnly: string
      push: string
      administrator: string
      allowedBotsLabel: string
      pushAllowed: string
      administratorBox: string
      addLabel: string
      addButton: string
      signedInAs: (viewer: string) => string
      signedInLocally: string
    }
  }
  oidc: {
    signIn: {
      title: (issuerName: string) => string
      heading: string
      username: string
      password: string
      totp: string
      recovery: string
      verify: string
      notRight: string
      tooManyAttempts: string
    }
    error: {
      title: string
      inviteSpent: string
      passwordSet: string
      enrolmentGone: string
      codeNotRight: string
      twoFactorOn: string
    }
    signedOut: {
      title: string
      detail: (issuerName: string) => string
      note: string
    }
    invite: {
      title: string
      password: string
      again: string
      submit: string
      note: string
      tooShort: string
      mismatch: string
    }
    enrol: {
      title: string
      heading: string
      addToAuthenticator: string
      orOpen: string
      typeTheCode: string
      totp: string
      confirm: string
      recoveryHeading: string
      recoveryNote: string
    }
  }
}

/** The source. Every other language is a partial answer to this. */
const EN: WebStrings = {
  common: {
    signIn: 'Sign in',
    save: 'Save',
    administration: 'Administration',
    administrationTitle: 'Hermie Web administration',
    administratorSecret: 'Administrator secret',
    yes: 'yes',
    no: 'no'
  },
  setup: {
    title: 'Set up Hermie Web',
    intro:
      'This page exists once. When the gateway is saved it answers 404, and everybody else only ever sees a sign-in.',
    gatewayHeading: '1. The gateway',
    gatewayIntro: 'The Hermes gateway this server proxies. It is fixed once it is saved.',
    addressLabel: 'Address',
    probeButton: 'Probe',
    loginHeading: '2. The service login',
    loginIntro:
      'One sign-in that belongs to this <em>server</em>, not to you. Hermie Web spends it on a gateway connection ' +
      'of its own, and uses that connection for two things: push notifications, and the message cache that makes a ' +
      'chat paint the moment it opens. It is not the sign-in the app will ask you for.',
    loginNote:
      'Optional here. Without it the app still works; push and the cache do not. You can also do it from a terminal ' +
      "with <code>hermie-web login</code>, which is the route to take if your provider will not accept this server's " +
      'own address as a redirect.',
    providerLabel: 'Provider',
    providerPlaceholder: "leave empty for the gateway's default",
    saveHeading: '3. Save',
    saveIntro: "Saving writes the gateway to this server's state directory and closes this page for good.",
    adminSecretLabel: 'Administrator secret (optional)',
    adminSecretNote:
      'Only needed on a gateway with no accounts. With accounts, whoever is signed in right now becomes this ' +
      "service's first administrator and this can stay empty. Stored as a scrypt hash; <code>/admin</code> never " +
      'shows it back.',
    saveButton: 'Save and finish',
    footer: version => `Hermie Web ${version}`,
    script: {
      probing: address => `Probing ${address} …`,
      probed: (version, flows) => `Hermes ${version} — ${flows}.`,
      noSignIn: 'no sign-in required',
      didNotWork: 'That did not work.',
      asking: 'Asking the gateway for a sign-in address …',
      saving: 'Saving …',
      savedNothingCanAdmin: 'Saved, but nothing can open /admin: this gateway named nobody and no secret was set.',
      savedOpening: 'Saved. Opening Hermie …',
      loginStored: 'The service login was stored.'
    },
    callback: {
      nothingWaitingTitle: 'Nothing was waiting',
      nothingWaitingDetail: 'Start the service sign-in from the setup page.',
      failedTitle: 'Sign-in failed',
      noCode: 'That redirect did not carry the code this server was waiting for.',
      signedInTitle: 'The service is signed in',
      signedInDetail: 'Hermie Web stored the sign-in it uses for push and for the message cache.',
      back: 'Back to setup'
    }
  },
  admin: {
    signIn: {
      intro:
        'This service has no gateway accounts to recognise you by, so it asks for the administrator secret set ' +
        'during setup.',
      secretNote: 'Stored as a scrypt hash. This page never shows it back.',
      wrongSecret: 'That secret was not right.'
    },
    forbidden: {
      title: 'Not an administrator',
      knownAs: viewer =>
        `The gateway knows you as <code>${viewer}</code>, and that id is not on this service’s administrator list.`,
      unknown: 'This gateway did not say who you are, so this service has nobody to check against.',
      note:
        'An existing administrator can add an id on this page. On a service with no gateway accounts, the ' +
        'administrator secret set during setup is the way in.'
    },
    header: (version, gatewayUrl) => `Hermie Web ${version} · <code>${gatewayUrl}</code>`,
    service: {
      heading: 'Service',
      version: 'Version',
      upToDate: 'up to date',
      updateAvailable: version => `<strong>${version} available</strong>`,
      serviceLogin: 'Service login',
      pushDaemon: 'Push daemon',
      running: 'running',
      notRunning: 'not running',
      vapidKey: 'VAPID key',
      messageCache: 'Message cache',
      cacheOff: 'off',
      cacheFill: (entries, used, cap) => `${entries} entries · ${used} of ${cap}`,
      cacheHits: 'Cache hits',
      hitRate: (percent, total) => `${percent}% of ${total}`,
      nothingAsked: 'nothing asked yet',
      userList: 'User list',
      fromGateway: 'from the gateway',
      fromSeen: 'people this service has seen sign in',
      updateButton: 'Update and restart',
      updateUnavailable: 'not available here'
    },
    push: {
      heading: 'Push',
      intro:
        'A ceiling, not a second opt-in: a device still has to have asked. Turning one off silences it for everybody.',
      previewLabel: 'Preview policy',
      previewDevice: 'Each device decides',
      previewNever: 'Never include message text',
      saveButton: 'Save push settings'
    },
    cache: {
      heading: 'Message cache',
      retentionLabel: 'Drop entries unread for (hours, 0 = size cap only)',
      capNote: 'The size cap is <code>--cache-max-mb</code> and is set at start-up, not here.',
      clearButton: 'Clear the cache now'
    },
    identity: {
      heading: 'Identity',
      on: (issuer, accounts) =>
        `This service is signing people in itself, as <code>${issuer}</code>, for ${accounts} account` +
        `${accounts === 1 ? '' : 's'}. <strong>That makes it the identity root of your gateway.</strong>`,
      off:
        'This service can sign people in itself, for a deployment with no identity provider of its own. It is ' +
        '<strong>off</strong>.',
      link: 'Identity settings, accounts and the gateway snippet →'
    },
    branding: {
      heading: 'Branding',
      intro: 'Served in <code>/hermie/config.json</code> and read by the app before it draws anything.',
      nameLabel: 'Name',
      accentLabel: 'Accent',
      themeLabel: 'Default theme preset',
      note: 'A reader who has chosen their own keeps it; this is the starting point, not an override.',
      saveButton: 'Save branding'
    },
    features: {
      heading: 'Features',
      userChats: 'Private chats beside the shared Bot Chat',
      messageCache: 'Serve the message cache to the app',
      selfUpdate: 'Offer the update button in the app',
      saveButton: 'Save features'
    },
    people: {
      heading: 'People',
      intro:
        '<strong>These are service-level settings, not gateway permissions.</strong> Push and the message cache are ' +
        'this service’s own and are enforced completely. Read-only refuses every mutating HTTP request; it cannot ' +
        'police the gateway WebSocket, which is a byte pipe by design — so it is a guard rail, not a boundary.',
      empty: 'Nobody has signed in through this service yet.',
      who: 'Who',
      lastSeen: 'Last seen',
      bots: 'Bots',
      readOnly: 'Read-only',
      push: 'Push',
      administrator: 'administrator',
      allowedBotsLabel: 'Allowed bots (blank = all)',
      pushAllowed: 'Push allowed',
      administratorBox: 'Administrator',
      addLabel: 'Add somebody by gateway user id',
      addButton: 'Add',
      signedInAs: viewer => `You are signed in as <code>${viewer}</code>. The last administrator cannot be removed.`,
      signedInLocally: 'You are signed in with the local administrator secret.'
    }
  },
  oidc: {
    signIn: {
      title: issuerName => `Sign in to ${issuerName}`,
      heading: 'Sign in',
      username: 'Username',
      password: 'Password',
      totp: 'Six-digit code',
      recovery: '…or one recovery code',
      verify: 'Verify',
      notRight: 'That sign-in was not right.',
      tooManyAttempts: 'Too many attempts. Wait a few minutes and try again.'
    },
    error: {
      title: 'Sign-in failed',
      inviteSpent: 'That invitation has been used or has expired.',
      passwordSet: 'Your password is set. Go back to the application and sign in with it.',
      enrolmentGone: 'That enrolment is no longer in progress.',
      codeNotRight: 'That code was not right. Go back and try the next one the app shows.',
      twoFactorOn: 'Two-factor is on for this account. Go back to the application and sign in.'
    },
    signedOut: {
      title: 'Signed out',
      detail: issuerName => `Your sign-in to ${issuerName} has been forgotten on this server.`,
      note: 'The application you came from may keep its own session until it expires.'
    },
    invite: {
      title: 'Choose a password',
      password: 'Password',
      again: 'Again',
      submit: 'Set the password',
      note:
        'This link works once and then stops. Nobody else, including whoever invited you, ever sees what you type ' +
        'here.',
      tooShort: 'Use at least twelve characters. Length is what makes a password hard to guess.',
      mismatch: 'Those two did not match.'
    },
    enrol: {
      title: 'Set up two-factor',
      heading: 'Two-factor',
      addToAuthenticator: 'Add this to your authenticator:',
      orOpen: 'Or open',
      typeTheCode: 'Type the code it shows, to prove it works.',
      totp: 'Six-digit code',
      confirm: 'Confirm',
      recoveryHeading: 'Recovery codes',
      recoveryNote: 'Each works once, in place of a code from the app. This is the only time they are shown.'
    }
  }
}

/**
 * A catalogue: the same shape as `WebStrings`, optional all the way down.
 *
 * Every key is optional, so a partial catalogue is a working catalogue from its
 * first line — which is the point, and why a round may add English copy today
 * and translate it next week. What is NOT optional is the KIND: a key that
 * interpolates stays a function here, because the type refusing a bare string
 * is cheaper than a sentence rendered with a hole in it.
 */
export type WebCatalogue<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => string ? T[K] : T[K] extends object ? WebCatalogue<T[K]> : T[K]
}

/**
 * Dutch. Informal throughout: `je`, never `u` — this is somebody's own bots on
 * somebody's own machine, not a bank (`docs/i18n.md`).
 *
 * The keys that are absent are absent deliberately: `Hermie Web 1.2.3` and
 * `Hermes 1.2.3 — cookie.` read the same in Dutch, so the fallback says them.
 */
const NL: WebCatalogue<WebStrings> = {
  common: {
    signIn: 'Inloggen',
    save: 'Opslaan',
    administration: 'Beheer',
    administrationTitle: 'Hermie Web-beheer',
    administratorSecret: 'Beheerderswachtwoord',
    yes: 'ja',
    no: 'nee'
  },
  setup: {
    title: 'Hermie Web instellen',
    intro:
      'Deze pagina bestaat één keer. Zodra de gateway is opgeslagen antwoordt hij 404, en ziet iedereen verder ' +
      'alleen nog een inlogscherm.',
    gatewayHeading: '1. De gateway',
    gatewayIntro: 'De Hermes gateway waar deze server naartoe proxyt. Die ligt vast zodra hij is opgeslagen.',
    addressLabel: 'Adres',
    probeButton: 'Testen',
    loginHeading: '2. De service-login',
    loginIntro:
      'Eén login die van deze <em>server</em> is, niet van jou. Hermie Web gebruikt hem voor een eigen ' +
      'gateway-verbinding, en die verbinding voor twee dingen: push-notificaties, en de berichtencache die een chat ' +
      'meteen laat verschijnen als je hem opent. Dit is niet de login waar de app je om vraagt.',
    loginNote:
      'Hier optioneel. Zonder werkt de app gewoon; push en de cache niet. Je kunt het ook vanuit een terminal doen ' +
      'met <code>hermie-web login</code>, en dat is de route als je provider het eigen adres van deze server niet ' +
      'als redirect accepteert.',
    providerPlaceholder: 'leeg laten voor de standaard van de gateway',
    saveHeading: '3. Opslaan',
    saveIntro: 'Opslaan schrijft de gateway naar de state-map van deze server en sluit deze pagina voorgoed.',
    adminSecretLabel: 'Beheerderswachtwoord (optioneel)',
    adminSecretNote:
      'Alleen nodig op een gateway zonder accounts. Mét accounts wordt degene die nu is ingelogd de eerste ' +
      'beheerder van deze service en kan dit leeg blijven. Opgeslagen als scrypt-hash; <code>/admin</code> laat hem ' +
      'nooit meer zien.',
    saveButton: 'Opslaan en afronden',
    script: {
      probing: address => `${address} testen …`,
      noSignIn: 'geen login nodig',
      didNotWork: 'Dat werkte niet.',
      asking: 'De gateway om een inlogadres vragen …',
      saving: 'Opslaan …',
      savedNothingCanAdmin:
        'Opgeslagen, maar niets kan /admin openen: deze gateway noemde niemand en er is geen ' +
        'beheerderswachtwoord ingesteld.',
      savedOpening: 'Opgeslagen. Hermie openen …',
      loginStored: 'De service-login is opgeslagen.'
    },
    callback: {
      nothingWaitingTitle: 'Er stond niets te wachten',
      nothingWaitingDetail: 'Start de service-login vanaf de setup-pagina.',
      failedTitle: 'Inloggen mislukt',
      noCode: 'Die redirect droeg niet de code waar deze server op wachtte.',
      signedInTitle: 'De service is ingelogd',
      signedInDetail: 'Hermie Web heeft de login opgeslagen die het gebruikt voor push en voor de berichtencache.',
      back: 'Terug naar setup'
    }
  },
  admin: {
    signIn: {
      intro:
        'Deze service heeft geen gateway-accounts om je aan te herkennen, dus vraagt hij om het ' +
        'beheerderswachtwoord dat tijdens de setup is ingesteld.',
      secretNote: 'Opgeslagen als scrypt-hash. Deze pagina laat hem nooit meer zien.',
      wrongSecret: 'Dat wachtwoord klopte niet.'
    },
    forbidden: {
      title: 'Geen beheerder',
      knownAs: viewer =>
        `De gateway kent je als <code>${viewer}</code>, en dat id staat niet op de beheerderslijst van deze service.`,
      unknown: 'Deze gateway heeft niet gezegd wie je bent, dus deze service heeft niemand om tegen te controleren.',
      note:
        'Een bestaande beheerder kan hier een id toevoegen. Op een service zonder gateway-accounts is het ' +
        'beheerderswachtwoord uit de setup de weg naar binnen.'
    },
    service: {
      heading: 'Service',
      version: 'Versie',
      upToDate: 'up-to-date',
      updateAvailable: version => `<strong>${version} beschikbaar</strong>`,
      serviceLogin: 'Service-login',
      pushDaemon: 'Push-daemon',
      running: 'draait',
      notRunning: 'draait niet',
      vapidKey: 'VAPID-sleutel',
      messageCache: 'Berichtencache',
      cacheOff: 'uit',
      cacheFill: (entries, used, cap) => `${entries} items · ${used} van ${cap}`,
      cacheHits: 'Cache-hits',
      hitRate: (percent, total) => `${percent}% van ${total}`,
      nothingAsked: 'nog niets gevraagd',
      userList: 'Gebruikerslijst',
      fromGateway: 'van de gateway',
      fromSeen: 'mensen die deze service heeft zien inloggen',
      updateButton: 'Bijwerken en herstarten',
      updateUnavailable: 'hier niet beschikbaar'
    },
    push: {
      heading: 'Push',
      intro:
        'Een plafond, geen tweede opt-in: een apparaat moet er nog steeds zelf om gevraagd hebben. Eentje uitzetten ' +
        'legt hem voor iedereen stil.',
      previewLabel: 'Previewbeleid',
      previewDevice: 'Elk apparaat beslist zelf',
      previewNever: 'Nooit berichttekst meesturen',
      saveButton: 'Push-instellingen opslaan'
    },
    cache: {
      heading: 'Berichtencache',
      retentionLabel: 'Ongelezen items weggooien na (uren, 0 = alleen de maximale grootte)',
      capNote: 'De maximale grootte is <code>--cache-max-mb</code> en wordt bij het starten ingesteld, niet hier.',
      clearButton: 'Cache nu legen'
    },
    identity: {
      heading: 'Identiteit',
      on: (issuer, accounts) =>
        `Deze service logt mensen zelf in, als <code>${issuer}</code>, voor ${accounts} account` +
        `${accounts === 1 ? '' : 's'}. <strong>Daarmee is het de identiteitswortel van je gateway.</strong>`,
      off:
        'Deze service kan mensen zelf inloggen, voor een deployment zonder eigen identity provider. Hij staat ' +
        '<strong>uit</strong>.',
      link: 'Identiteitsinstellingen, accounts en het gateway-snippet →'
    },
    branding: {
      heading: 'Branding',
      intro: 'Wordt geserveerd in <code>/hermie/config.json</code> en door de app gelezen voordat hij iets tekent.',
      nameLabel: 'Naam',
      accentLabel: 'Accent',
      themeLabel: 'Standaard themapreset',
      note: 'Wie zelf iets gekozen heeft, houdt dat; dit is het startpunt, geen overschrijving.',
      saveButton: 'Branding opslaan'
    },
    features: {
      heading: 'Functies',
      userChats: 'Privé-chats naast de gedeelde Bot Chat',
      messageCache: 'De berichtencache aan de app serveren',
      selfUpdate: 'De update-knop in de app aanbieden',
      saveButton: 'Functies opslaan'
    },
    people: {
      heading: 'Mensen',
      intro:
        '<strong>Dit zijn instellingen van de service, geen gateway-permissies.</strong> Push en de berichtencache ' +
        'zijn van deze service zelf en worden volledig afgedwongen. Alleen-lezen weigert elk wijzigend ' +
        'HTTP-verzoek; het kan de gateway-WebSocket niet bewaken, want dat is met opzet een bytepijp — het is dus ' +
        'een vangrail, geen grens.',
      empty: 'Er heeft nog niemand via deze service ingelogd.',
      who: 'Wie',
      lastSeen: 'Laatst gezien',
      readOnly: 'Alleen-lezen',
      administrator: 'beheerder',
      allowedBotsLabel: 'Toegestane bots (leeg = alle)',
      pushAllowed: 'Push toegestaan',
      administratorBox: 'Beheerder',
      addLabel: 'Iemand toevoegen op gateway-gebruikers-id',
      addButton: 'Toevoegen',
      signedInAs: viewer =>
        `Je bent ingelogd als <code>${viewer}</code>. De laatste beheerder kan niet worden verwijderd.`,
      signedInLocally: 'Je bent ingelogd met het lokale beheerderswachtwoord.'
    }
  },
  oidc: {
    signIn: {
      title: issuerName => `Inloggen bij ${issuerName}`,
      heading: 'Inloggen',
      username: 'Gebruikersnaam',
      password: 'Wachtwoord',
      totp: 'Zescijferige code',
      recovery: '…of één herstelcode',
      verify: 'Controleren',
      notRight: 'Die login klopte niet.',
      tooManyAttempts: 'Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.'
    },
    error: {
      title: 'Inloggen mislukt',
      inviteSpent: 'Die uitnodiging is al gebruikt of verlopen.',
      passwordSet: 'Je wachtwoord staat ingesteld. Ga terug naar de applicatie en log ermee in.',
      enrolmentGone: 'Die aanmelding loopt niet meer.',
      codeNotRight: 'Die code klopte niet. Ga terug en probeer de volgende die de app laat zien.',
      twoFactorOn: 'Tweefactor staat aan voor dit account. Ga terug naar de applicatie en log in.'
    },
    signedOut: {
      title: 'Uitgelogd',
      detail: issuerName => `Je login bij ${issuerName} is op deze server vergeten.`,
      note: 'De applicatie waar je vandaan kwam kan zijn eigen sessie nog houden tot die verloopt.'
    },
    invite: {
      title: 'Kies een wachtwoord',
      password: 'Wachtwoord',
      again: 'Nog een keer',
      submit: 'Wachtwoord instellen',
      note:
        'Deze link werkt één keer en stopt dan. Niemand anders, ook niet wie je uitnodigde, ziet ooit wat je hier ' +
        'typt.',
      tooShort: 'Gebruik minstens twaalf tekens. Lengte is wat een wachtwoord moeilijk te raden maakt.',
      mismatch: 'Die twee kwamen niet overeen.'
    },
    enrol: {
      title: 'Tweefactor instellen',
      heading: 'Tweefactor',
      addToAuthenticator: 'Zet dit in je authenticator:',
      orOpen: 'Of open',
      typeTheCode: 'Typ de code die hij laat zien, om te bewijzen dat het werkt.',
      totp: 'Zescijferige code',
      confirm: 'Bevestigen',
      recoveryHeading: 'Herstelcodes',
      recoveryNote: 'Elke code werkt één keer, in plaats van een code uit de app. Dit is de enige keer dat je ze ziet.'
    }
  }
}

/**
 * German. Informal throughout: `du`, never `Sie` — matching the Dutch `je`
 * rather than the formal register a German product would usually pick, for the
 * same reason (`docs/i18n.md`).
 */
const DE: WebCatalogue<WebStrings> = {
  common: {
    signIn: 'Anmelden',
    save: 'Speichern',
    administration: 'Verwaltung',
    administrationTitle: 'Hermie Web-Verwaltung',
    administratorSecret: 'Administrator-Passwort',
    yes: 'ja',
    no: 'nein'
  },
  setup: {
    title: 'Hermie Web einrichten',
    intro:
      'Diese Seite gibt es einmal. Sobald das gateway gespeichert ist, antwortet sie mit 404, und alle anderen ' +
      'sehen nur noch eine Anmeldung.',
    gatewayHeading: '1. Das gateway',
    gatewayIntro: 'Das Hermes gateway, zu dem dieser Server weiterleitet. Es liegt fest, sobald es gespeichert ist.',
    addressLabel: 'Adresse',
    probeButton: 'Prüfen',
    loginHeading: '2. Die Dienst-Anmeldung',
    loginIntro:
      'Eine Anmeldung, die diesem <em>Server</em> gehört, nicht dir. Hermie Web verwendet sie für eine eigene ' +
      'gateway-Verbindung und diese Verbindung für zwei Dinge: push-Benachrichtigungen und den Nachrichten-Cache, ' +
      'der einen Chat sofort beim Öffnen zeichnet. Es ist nicht die Anmeldung, nach der die App dich fragt.',
    loginNote:
      'Hier optional. Ohne sie funktioniert die App weiterhin; push und der Cache nicht. Du kannst es auch im ' +
      'Terminal mit <code>hermie-web login</code> machen — der Weg, wenn dein Provider die eigene Adresse dieses ' +
      'Servers nicht als Redirect akzeptiert.',
    providerPlaceholder: 'leer lassen für die Vorgabe des gateway',
    saveHeading: '3. Speichern',
    saveIntro:
      'Speichern schreibt das gateway in das Statusverzeichnis dieses Servers und schließt diese Seite endgültig.',
    adminSecretLabel: 'Administrator-Passwort (optional)',
    adminSecretNote:
      'Nur nötig auf einem gateway ohne Konten. Mit Konten wird die Person, die gerade angemeldet ist, der erste ' +
      'Administrator dieses Dienstes, und dies kann leer bleiben. Als scrypt-Hash gespeichert; <code>/admin</code> ' +
      'zeigt es nie wieder an.',
    saveButton: 'Speichern und fertig',
    script: {
      probing: address => `${address} wird geprüft …`,
      noSignIn: 'keine Anmeldung nötig',
      didNotWork: 'Das hat nicht geklappt.',
      asking: 'Das gateway wird nach einer Anmeldeadresse gefragt …',
      saving: 'Wird gespeichert …',
      savedNothingCanAdmin:
        'Gespeichert, aber nichts kann /admin öffnen: dieses gateway hat niemanden genannt und es wurde kein ' +
        'Passwort gesetzt.',
      savedOpening: 'Gespeichert. Hermie wird geöffnet …',
      loginStored: 'Die Dienst-Anmeldung wurde gespeichert.'
    },
    callback: {
      nothingWaitingTitle: 'Es wartete nichts',
      nothingWaitingDetail: 'Starte die Dienst-Anmeldung auf der Setup-Seite.',
      failedTitle: 'Anmeldung fehlgeschlagen',
      noCode: 'Dieser Redirect trug nicht den Code, auf den dieser Server gewartet hat.',
      signedInTitle: 'Der Dienst ist angemeldet',
      signedInDetail:
        'Hermie Web hat die Anmeldung gespeichert, die es für push und für den Nachrichten-Cache verwendet.',
      back: 'Zurück zum Setup'
    }
  },
  admin: {
    signIn: {
      intro:
        'Dieser Dienst hat keine gateway-Konten, an denen er dich erkennen könnte, und fragt deshalb nach dem ' +
        'Administrator-Passwort aus dem Setup.',
      secretNote: 'Als scrypt-Hash gespeichert. Diese Seite zeigt es nie wieder an.',
      wrongSecret: 'Dieses Passwort war nicht richtig.'
    },
    forbidden: {
      title: 'Kein Administrator',
      knownAs: viewer =>
        `Das gateway kennt dich als <code>${viewer}</code>, und diese id steht nicht auf der Administratorenliste ` +
        'dieses Dienstes.',
      unknown: 'Dieses gateway hat nicht gesagt, wer du bist, also hat dieser Dienst niemanden zum Abgleichen.',
      note:
        'Ein vorhandener Administrator kann hier eine id hinzufügen. Auf einem Dienst ohne gateway-Konten ist das ' +
        'im Setup gesetzte Administrator-Passwort der Weg hinein.'
    },
    service: {
      heading: 'Dienst',
      version: 'Version',
      upToDate: 'aktuell',
      updateAvailable: version => `<strong>${version} verfügbar</strong>`,
      serviceLogin: 'Dienst-Anmeldung',
      pushDaemon: 'Push-Daemon',
      running: 'läuft',
      notRunning: 'läuft nicht',
      vapidKey: 'VAPID-Schlüssel',
      messageCache: 'Nachrichten-Cache',
      cacheOff: 'aus',
      cacheFill: (entries, used, cap) => `${entries} Einträge · ${used} von ${cap}`,
      cacheHits: 'Cache-Treffer',
      hitRate: (percent, total) => `${percent}% von ${total}`,
      nothingAsked: 'noch nichts abgefragt',
      userList: 'Benutzerliste',
      fromGateway: 'vom gateway',
      fromSeen: 'Menschen, die dieser Dienst sich hat anmelden sehen',
      updateButton: 'Aktualisieren und neu starten',
      updateUnavailable: 'hier nicht verfügbar'
    },
    push: {
      heading: 'Push',
      intro:
        'Eine Obergrenze, kein zweites Opt-in: ein Gerät muss trotzdem selbst gefragt haben. Eines abzuschalten ' +
        'legt es für alle still.',
      previewLabel: 'Vorschau-Regel',
      previewDevice: 'Jedes Gerät entscheidet selbst',
      previewNever: 'Nie Nachrichtentext mitschicken',
      saveButton: 'Push-Einstellungen speichern'
    },
    cache: {
      heading: 'Nachrichten-Cache',
      retentionLabel: 'Ungelesene Einträge verwerfen nach (Stunden, 0 = nur die Größengrenze)',
      capNote: 'Die Größengrenze ist <code>--cache-max-mb</code> und wird beim Start gesetzt, nicht hier.',
      clearButton: 'Cache jetzt leeren'
    },
    identity: {
      heading: 'Identität',
      on: (issuer, accounts) =>
        `Dieser Dienst meldet Menschen selbst an, als <code>${issuer}</code>, für ${accounts} ` +
        `Kont${accounts === 1 ? 'o' : 'en'}. <strong>Damit ist er die Identitätswurzel deines gateway.</strong>`,
      off:
        'Dieser Dienst kann Menschen selbst anmelden, für eine Installation ohne eigenen Identity Provider. Er ist ' +
        '<strong>aus</strong>.',
      link: 'Identitätseinstellungen, Konten und das gateway-Snippet →'
    },
    branding: {
      heading: 'Branding',
      intro: 'Wird in <code>/hermie/config.json</code> ausgeliefert und von der App gelesen, bevor sie etwas zeichnet.',
      nameLabel: 'Name',
      accentLabel: 'Akzent',
      themeLabel: 'Standard-Themenvorgabe',
      note: 'Wer selbst etwas gewählt hat, behält es; das hier ist der Anfang, keine Übersteuerung.',
      saveButton: 'Branding speichern'
    },
    features: {
      heading: 'Funktionen',
      userChats: 'Private Chats neben dem gemeinsamen Bot Chat',
      messageCache: 'Den Nachrichten-Cache an die App ausliefern',
      selfUpdate: 'Den Update-Knopf in der App anbieten',
      saveButton: 'Funktionen speichern'
    },
    people: {
      heading: 'Menschen',
      intro:
        '<strong>Das sind Einstellungen des Dienstes, keine gateway-Berechtigungen.</strong> Push und der ' +
        'Nachrichten-Cache gehören diesem Dienst selbst und werden vollständig durchgesetzt. Nur-Lesen weist jede ' +
        'verändernde HTTP-Anfrage ab; den gateway-WebSocket kann es nicht überwachen, denn der ist mit Absicht eine ' +
        'Byte-Leitung — es ist also eine Leitplanke, keine Grenze.',
      empty: 'Über diesen Dienst hat sich noch niemand angemeldet.',
      who: 'Wer',
      lastSeen: 'Zuletzt gesehen',
      readOnly: 'Nur-Lesen',
      administrator: 'Administrator',
      allowedBotsLabel: 'Erlaubte Bots (leer = alle)',
      pushAllowed: 'Push erlaubt',
      administratorBox: 'Administrator',
      addLabel: 'Jemanden über die gateway-Benutzer-id hinzufügen',
      addButton: 'Hinzufügen',
      signedInAs: viewer =>
        `Du bist als <code>${viewer}</code> angemeldet. Der letzte Administrator kann nicht entfernt werden.`,
      signedInLocally: 'Du bist mit dem lokalen Administrator-Passwort angemeldet.'
    }
  },
  oidc: {
    signIn: {
      title: issuerName => `Bei ${issuerName} anmelden`,
      heading: 'Anmelden',
      username: 'Benutzername',
      password: 'Passwort',
      totp: 'Sechsstelliger Code',
      recovery: '…oder ein Wiederherstellungscode',
      verify: 'Prüfen',
      notRight: 'Diese Anmeldung war nicht richtig.',
      tooManyAttempts: 'Zu viele Versuche. Warte ein paar Minuten und versuch es noch einmal.'
    },
    error: {
      title: 'Anmeldung fehlgeschlagen',
      inviteSpent: 'Diese Einladung wurde bereits benutzt oder ist abgelaufen.',
      passwordSet: 'Dein Passwort ist gesetzt. Geh zurück zur Anwendung und melde dich damit an.',
      enrolmentGone: 'Diese Einrichtung läuft nicht mehr.',
      codeNotRight: 'Dieser Code war nicht richtig. Geh zurück und probier den nächsten, den die App zeigt.',
      twoFactorOn: 'Zwei-Faktor ist für dieses Konto an. Geh zurück zur Anwendung und melde dich an.'
    },
    signedOut: {
      title: 'Abgemeldet',
      detail: issuerName => `Deine Anmeldung bei ${issuerName} wurde auf diesem Server vergessen.`,
      note: 'Die Anwendung, aus der du kamst, behält ihre eigene Sitzung womöglich, bis sie abläuft.'
    },
    invite: {
      title: 'Wähle ein Passwort',
      password: 'Passwort',
      again: 'Noch einmal',
      submit: 'Passwort setzen',
      note:
        'Dieser Link funktioniert einmal und hört dann auf. Niemand sonst, auch nicht wer dich eingeladen hat, ' +
        'sieht jemals, was du hier tippst.',
      tooShort: 'Nimm mindestens zwölf Zeichen. Länge ist, was ein Passwort schwer zu raten macht.',
      mismatch: 'Die beiden stimmten nicht überein.'
    },
    enrol: {
      title: 'Zwei-Faktor einrichten',
      heading: 'Zwei-Faktor',
      addToAuthenticator: 'Trag das in deinen Authenticator ein:',
      orOpen: 'Oder öffne',
      typeTheCode: 'Tipp den Code, den er zeigt, um zu beweisen, dass es funktioniert.',
      totp: 'Sechsstelliger Code',
      confirm: 'Bestätigen',
      recoveryHeading: 'Wiederherstellungscodes',
      recoveryNote:
        'Jeder funktioniert einmal, anstelle eines Codes aus der App. Dies ist das einzige Mal, dass sie gezeigt ' +
        'werden.'
    }
  }
}

const CATALOGUES: Record<WebLocale, WebCatalogue<WebStrings> | null> = { en: null, nl: NL, de: DE }

/**
 * Lay a catalogue over the English source, branch by branch.
 *
 * English wins on three counts, and they are all the same count: the catalogue
 * is silent, the catalogue holds the wrong KIND (a string where a function
 * belongs, or the reverse), or it holds an object where a sentence belongs. A
 * half-written catalogue can therefore never render `undefined` or
 * `[object Object]` on a page somebody is trying to sign in through.
 */
function layOver(english: unknown, translation: unknown): unknown {
  if (typeof english === 'function') {
    return typeof translation === 'function' ? translation : english
  }

  if (typeof english === 'string') {
    return typeof translation === 'string' ? translation : english
  }

  if (!translation || typeof translation !== 'object') {
    return english
  }

  const over = translation as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(english as Record<string, unknown>).map(([key, value]) => [key, layOver(value, over[key])])
  )
}

/**
 * Merged once per language and kept, because these tables are read on every
 * render of every page and nothing in them depends on the request.
 */
const MERGED = new Map<WebLocale, WebStrings>()

/** The copy for one language, with the English sentence wherever it is silent. */
export function webStrings(locale: WebLocale): WebStrings {
  if (locale === 'en') {
    return EN
  }

  const held = MERGED.get(locale)

  if (held) {
    return held
  }

  const merged = layOver(EN, CATALOGUES[locale]) as WebStrings

  MERGED.set(locale, merged)

  return merged
}

/** The copy one incoming request asked for, and the language it was chosen in. */
export function webCopy(request: IncomingMessage): { locale: WebLocale; strings: WebStrings } {
  const locale = localeOf(request)

  return { locale, strings: webStrings(locale) }
}
