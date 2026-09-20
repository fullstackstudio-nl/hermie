# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


### Added

- **A secondary click opens the platform's own context menu.** A right click on a chat row, on a
  message, on a section heading or on a cron — and a press and hold on a touch screen — now opens a
  real `UIMenu` through `UIContextMenuInteraction`, not a sheet the app drew. The system's glass and
  placement, the row lifting into a preview, arrow-key navigation, Return to choose and Escape to
  dismiss all come with it and are not our code. React Native has no secondary-click event at all,
  so this is a host view in the local `hermie-mac` module (`HermieContextMenuView`) that the call
  site wraps its existing tree in. The chat list's bottom sheet stays exactly as it was and is the
  Android path.
- **Hold a chat row and drag it where you want it.** Long press for 300ms, then move: the row lifts
  with a shadow, a line shows where it will land, the list scrolls itself when you reach an edge, and
  dividers are drop targets so dragging across one changes a chat's section. Long press and hold
  STILL, without moving, and you get the context menu instead — the two separate by themselves, the
  way they do in the Files app. In edit mode the grab handle drags immediately, and Move up / Move
  down stay for anyone who would rather not drag. No gesture library: `PanResponder` and `Animated`,
  both already in React Native.
- **Desktop keyboard shortcuts, and Hermie's own menu in the Mac's menu bar.** ⌘K focuses the search
  field, ⌘, opens Settings, ⌘1…9 opens the nth visible chat, ⌘↑/⌘↓ and ⌃Tab step between chats, and
  ⌘W closes one level exactly as Escape does. The Mac menu bar gains a **Chats** menu carrying the
  same commands and the first nine chats by name, built with `UIMenuBuilder`; the keyboard and the
  menu bar emit the same event, so they cannot drift. Nothing is emitted for an unmodified key, so
  ordinary typing never leaves the native side.
- **`Copy text` and `Copy as Markdown` on a message**, plus a link submenu listing each link the
  message contains, `Open @handle's chat` on a bot-to-bot line and `Show details` where a card has a
  disclosure. A reply IS markdown, and the two destinations want different things.
- **`Mark as read` and `Add divider above`** on a chat row, and `Rename` / `Remove` on a section
  heading without going into edit mode first.
- **The fake gateway streams reasoning.** A scripted reply can now carry `reasoning` deltas, one
  `reasoningAvailable` frame and `tool.generating`, and the default scenario uses all three — so a
  turn arriving as thinking-then-words is reproducible locally. It was not before, which is why the
  transcript bug below survived two rounds.
- **Android is built and run for the first time.** Debug and release APKs both assemble with no
  change to the project, and the release build was driven end to end on an emulator: onboarding
  over plain `http://` to `10.0.2.2`, a chat with every item kind, the approval sheet, the options
  sheet and its pages, Activity, Crons, Settings and Licences, the attach menu, and the two-panel
  layout in landscape. That closes two things that had only ever been read rather than watched —
  that `usesCleartextTraffic` reaches the main manifest and not just the template's debug one, and
  that a pinned theme drives the native night mode and the status bar ink. The release APK is
  debug-signed, as the React Native template leaves it; it is not a shippable artefact.
  [docs/platform-notes.md](docs/platform-notes.md) has what was measured and what was not.
- **The fake gateway reports the session's working directory.** `SessionLiveInfo.cwd` is in the
  contract and this server answered without it, which made its own file-upload route unreachable:
  the client uploads into the session's cwd because `@file:` is expanded with `allowed_root` set to
  that directory, and it refuses rather than guesses when a resume carries no `cwd`. Every attach
  stopped at "No workspace to upload into" before a request was made, so the upload endpoint, the
  absolute-path rule and the 100 MB cap had never been exercised by a run.

### Fixed

- **An attachment sent with nothing typed no longer paints two outgoing bubbles.** Reconciliation
  pairs a locally sent turn with the row the gateway persists for it on what the turn SAYS, because
  `prompt.submit` answers with a status and never a row id. A send carrying only a file says nothing:
  the `@file:` directive is plumbing, and both sides lift it out of the text — so there was nothing
  to pair on, and the row landed beside the bubble a moment later, one naming `ui.xml` and the other
  `8setj4h3-ui.xml`. Pairing now uses the text AND the attachments, and `UserItem.attachments` is one
  contract on both sides of the wire: the reference strings, as the row carries them. A bubble's chip
  is derived from the reference at render time, and so is the key the two sides are compared on — the
  reference's own file name, which is all a client is ever told about an image, since
  `image.attach_bytes` sends the bytes out of band and the gateway alone decides where they land. Two
  sends carrying different files stay two bubbles. An image-only send gets the same treatment, and so
  does a prompt that was only a file when the chat is reopened in the middle of it — that used to
  resume as an empty bubble.
- **Android's back button reaches the surfaces that are not modals.** A `Modal` consumes the press
  itself, so every sheet was already right — including the blocking approval sheet, which correctly
  swallows it. Nothing else heard it: back on Activity, Crons or Settings in the wide layout left
  the app for the launcher with the panel still open, and back from a page Settings opens over
  itself (Licences, the connection test, the gallery) or from a cron's detail popped the whole
  screen instead of returning one level. `useHardwareBack` is a second stack beside `useEscapeKey`
  with the same last-wins rule, so "one level" falls out of mount order as it already did for
  Escape. Back inside the chat options sheet arrives as `onRequestClose` and now pops the page
  rather than closing the sheet.
- **A dimmed button no longer shows its own shadow through itself.** Android paints an elevation
  shadow behind a view and clips nothing, so at `opacity: 0.35` the disabled send button stopped
  hiding its shadow and the platform's polygon approximation of a circle read through the fill as a
  lighter octagon. iOS clips a shadow to outside the view's path and never showed it.

- **The setup wizard is one glass card on the wallpaper.** Every step used to be a flat full-screen
  form: an eyebrow, a title, a paragraph, a tall empty middle, a hairline, and a pinned footer
  holding Continue and Back. It is now a single centred card, at most 520pt wide, whose height
  follows its content, with the step's actions inside it under the content they act on and the
  divider gone. A slim four-segment rail carries the progress, static like every other status
  indicator in the app. On a phone the card takes the window's width; on a Mac or an iPad it is
  centred in both directions. The keyboard behaviour the pinned footer existed for is kept — the
  card scrolls rather than being covered.
- **The address step says what it actually does.** The hint under the field now states the
  behaviour that has been there since ADR-0014 and that nobody could see: leave the scheme out and
  the address is tried over `https://` first and `http://` second, and typing a scheme pins it.
  While the probe is in flight the line names the scheme it is trying; when it answers, it names the
  scheme it found — `Found over https://` as well as `Found over http://`, but only when the reader
  left the scheme out, because that is the only time it was an open question.
- **The connection test is a checklist, not a verdict.** REST, WebSocket and Profiles each get a
  static dot that fills in as the run reaches them, so a failure says WHICH half failed. That
  distinction is the whole value of the step: REST refused is a credential, the socket refused is a
  reverse proxy that does not pass upgrades through.
- **`Open in browser instead` is offered before you need it.** The system-browser sign-in path used
  to exist only inside the in-app web view, behind a caption under a page that may never load. It is
  now a quiet action on the sign-in step itself, and it opens straight onto the same paste-the-
  redirect form Android already gets.
- **Every onboarding step state is addressable** through `--hermieOpen gallery:onboarding-*`,
  including the error states — a probe that found nothing, a gateway that requires a sign-in but
  lists no providers, a gateway too old for native sign-in, and both ways the connection test fails.
  The wizard is the one screen nobody can reach twice, and the states worth looking at need a
  gateway broken in a particular way.

- **A gateway can be reached over plain `http://`, and the app says so.** On a tailnet — Tailscale,
  or Headscale — WireGuard has already encrypted the path, so `http://100.x.y.z:9119` or
  `http://host.tailnet.ts.net` is a complete and correct setup, and until now the operating system
  refused it — on iOS in every configuration, on Android in release builds only, because the
  template grants cleartext in the debug manifest alone. iOS now ships an App Transport
  Security exception and Android `usesCleartextTraffic`, both set from `app.config.ts`; the address
  is only known at runtime, so there is no domain to name in a narrower rule, and
  `NSAllowsLocalNetworking` does not reach a MagicDNS name because it is fully qualified — measured
  on an iOS 27 simulator as `NSURLErrorDomain -1022` against a cleartext FQDN that resolves to a
  private address the same build reached happily by its IP. The exception is exactly ONE key:
  adding `NSAllowsArbitraryLoadsInWebContent` or keeping the template's `NSAllowsLocalNetworking`
  beside it makes iOS ignore `NSAllowsArbitraryLoads` altogether, which is how the first version of
  this fix fixed nothing. [ADR-0014](docs/adr/0014-plain-http-on-private-networks.md) records the
  decision, `docs/platform-notes.md` the measurements, and `docs/release.md` the note App Review
  will ask for.
- **The address step tries both schemes, in the right order, and never silently.** Typed without a
  scheme, an address is probed over `https://` first and over `http://` only when https does not
  answer at all — not when a certificate was rejected, and not when something answered with a
  status. When http is what answered, the probe line says `Found over http://`. An address typed
  with `https://` is probed over https and nothing else.
- **One line about a cleartext connection, in the tone the host deserves.** Loopback, RFC 1918,
  link-local, CGNAT (Tailscale's range), `.ts.net`, `.local` and unqualified names are stated as
  fact; anything else is a warning with a `Use https instead` action beside it that re-probes with
  the scheme spelled out, port and path prefix intact. The classifier is pure and tested — IPv4,
  IPv6 ULA `fc00::/7`, Tailscale's `fd7a:115c:a1e0::/48`, IPv4-mapped addresses, brackets, ports,
  trailing dots and case. Settings shows the same line under the gateway address, and only for the
  case worth acting on.

- **The four sheet interiors, against the mockup.** The approval sheet reads in §6.9's order — who
  is asking and where, then the command well in monospace on the sunk tint, then the consequence —
  rather than the description-above-the-command it had; the buttons are still exactly the server's
  `choices` in the server's order (ADR-0010 is untouched) and `Deny` is the mockup's soft
  destructive tint rather than a saturated red block competing with the primary. The clarify sheet
  puts its step count beside the eyebrow, shows a locked answer as a tinted chip instead of only
  dimming the controls, and leads its actions with the one that answers the question. The agents
  sheet draws its tree on a hairline rail and gives a child's transcript a real PAGE with the shared
  back control — and Escape there now pops the page before the sheet. The cron editor is three named
  groups. The chat options root is four named groups, with verbosity and the two visibility switches
  in one card under the override footer that applies to all three.
- **The agents bar is §5's slim glass pill** — three static pips, the count, a monospace clock and
  `Show` — inset from the panel edge instead of a full-width strip with a bottom rule that read as a
  second header. The clock is `0:42` rather than `1m 12s` because the number ticks once a second in
  a fixed slot and a label that changes width moves the control beside it.
- **The crons list is §6.11's row**: a static status dot, the name over `Every 2 hours · @local`, a
  profile chip where the list spans more than one profile, and a right-hand `NEXT / in 2h` pair. The
  `Paused` divider is a label plus a rule. Four stacked lines per job became one row.
- **Activity is a ledger.** Rows carry the transcript's glyph well, the sentence in `meta`, the clock
  at the right edge and the body indented past the glyph, and the three counters are small static
  glass chips instead of 22pt numerals that led a timeline with a dashboard.
- **A cron card in a chat can open its cron.** `ChatScreen` resolves the card's job NAME against the
  loaded crons, narrowed by this chat's bot — a bot is a Hermes profile — and passes the action only
  where that leaves exactly one job; anything else renders no action rather than a link to the wrong
  cron. Both shells route it: the wide layout opens the crons panel on that cron, the phone pushes
  the route with its id. `Run now` deliberately stays on the cron's own detail behind its confirm.
- **`gallery:chat` renders in the real wide shell** on a wide window — the same gaps, sidebar width
  and two panels `RegularShell` draws — over a seeded fixture roster, so a screenshot of the chat
  screen is a screenshot of a shape the app actually shows.

### Fixed

- **The transcript no longer jumps up and scrolls itself back while a bot is thinking.** The cause
  was one comparison in React Native's own scroll view: `maintainVisibleContentPosition` picks its
  anchor with `origin.y + height > contentOffset.y`, and at the bottom of an inverted list
  `contentOffset.y` is 0 — so a ZERO-height list header fails that test and the anchor falls through
  to the first cell instead. Every change at the bottom then moved that cell's origin, the scroll
  view corrected the offset by the difference, and `autoscrollToTopThreshold` animated back: the jump,
  and the scroll back. It happened on every message sent as well as on every appearance of the typing
  bubble. The header is now a one-point spacer whose height never changes, so it always wins that
  test and the delta is always zero, and the typing bubble is a pinned sibling below the list rather
  than content inside it. `__tests__/chat-ui/transcript-anchor.test.tsx` holds the invariant.
- **A secondary click on a bubble no longer starts a selection as well.** Where the native context
  menu exists the markdown renderer stops passing `selectable`, because `Text selectable` is not a
  selection — it is a long-press edit menu whose only action copies the whole paragraph. Two
  interactions were racing for one gesture, and the menu does the same copy better.
- **A collapsed run of bot-to-bot messages is one line again.** Every transcript row carried the gap
  above it, including the rows a roll-up swallows — so five dispatches collapsed into
  `5 messages to @writer` still left five turn gaps behind them, about 55pt of nothing between that
  one line and the next bubble. A row that draws nothing now takes no space at all.
- **Consecutive bot-to-bot lines sit nine points apart**, the rhythm §6.6 gives them, rather than the
  ten that separates two turns of speech. A dispatch is a ledger line, not a bubble.
- **The typing bubble gets the gap that any new turn gets.** It was the list's header rather than one
  of its rows, so the grouping never saw it and nothing gave it a margin: it sat against the message
  above with its tail reaching into the bubble's bottom corner. Nothing was added below it — the
  space there was always the list's own padding plus the composer's.
- **The Answer button on a question in the transcript is as wide as its label.** On a wide window it
  ran the whole card.
- **A day that changes on a hidden row now stamps the first row the reader can see.** A hidden
  placeholder was advancing the date stamp while drawing nothing, so a day boundary that happened to
  land on one went unmarked entirely.
- **Error cards in the transcript take the column rule instead of spanning it.** "Something went
  wrong" ran the full width of the chat column while every bubble beside it stopped at the bubble
  cap, and its Retry button stretched edge to edge with it. On an iPad Pro 13" in portrait the card
  went from 620pt to 469pt, in line with the bubbles, and Retry is now sized by its label — with the
  44pt minimum touch height intact.
- **The sidebar is 300pt on a window narrower than 1100, and 340 above it.** It was 344 everywhere,
  which is a landscape number: in portrait that is a third of an iPad Pro 13" and two fifths of an
  11". On an 11" in portrait the chat column goes from 448pt to 492pt and the bubble cap from about
  305pt to about 335 — the old number made a tablet read NARROWER than an iPhone 17 Pro, whose
  bubbles cap at 314. It is still tighter than a comfortable measure at that size; a collapsible
  sidebar is the remaining lever and the design board has no control for one yet.
- **The filter pills scroll.** At 300pt of sidebar "Needs input" no longer fits beside the other
  three, and it was already one text-size step from clipping at 344 — so the row scrolls
  horizontally, which also covers a longer translation and a larger Dynamic Type setting.
- **Avatar tints are deep enough to see.** The circle behind a bot's initial sat 1.02–1.20 : 1 from
  the panel behind it, so at iPad width a row read as a letter floating on the glass; the initial
  itself was always fine, which is why measuring only the ink missed it. The circle now separates at
  1.38–1.51 : 1 in light and 1.45–1.67 in dark, with the initial still above 5.7 : 1. A Default chat
  still gets no accent ring — §1.3 gives the ring to the eight curated colours, and that is correct.
- **A keychain that refuses to answer no longer strands the launch on the splash screen.** The
  startup read of the stored credentials had no `try`/`catch` and its caller was invoked without
  `await`, so a rejection — a missing entitlement, a locked keychain — escaped into nothing and the
  app waited for a phase that would never arrive. It now falls through to the wizard, which is a
  worse answer than connecting and a far better one than a spinner with no end.
- **A launch that finds the gateway address but no credential now says which of the two happened.**
  `expo-secure-store` resolves a missing item and an item in an unreadable keychain access group to
  the same `null`, so the ring recorded nothing that could tell them apart after the fact. The auth
  timeline gains `token.absent` for a clean miss, beside the existing `token.read_failed` for a
  refusal. This is what the "signed out after replacing the .app bundle" report needed and did not
  have; `docs/platform-notes.md` records what that investigation could and could not establish.

- **The transport's TLS classification was built on a message that does not exist.**
  `looksLikeTlsFailure` matched `ssl`, `certificate` and the literal `-1200`, with a comment saying
  iOS puts the NSURLError code in the message. Measured on iOS 27: CFNetwork logs
  `-1200 "A TLS error caused the secure connection to fail."` for a request the app reports as
  "Could not reach …", because React Native's `fetch` is `whatwg-fetch` over its own
  `XMLHttpRequest` and the polyfill rejects every transport failure with a flat
  `TypeError('Network request failed')` — the `NSError` never reaches JavaScript, and OkHttp's
  exception does not either. So `GatewayError('tls')` cannot arise from a `fetch` in the app at all,
  and `docs/platform-notes.md` says so rather than leaving a string everyone assumes is in use. The
  predicate now also matches `tls` as a word, and a second one separates a rejected CERTIFICATE from
  a handshake that died because nothing there spoke TLS — the line the scheme fallback is drawn on,
  correct wherever a real message does arrive.

### Changed

- **The iOS build names its keychain access group instead of inheriting one.**
  `keychain-access-groups` is now `$(AppIdentifierPrefix)nl.fullstackstudio.hermie`, the same string
  the implicit default already resolved to and first in the list, so writes go where they always
  went and every existing item stays readable — there is no migration, and nothing a user has to do.
  What changes is that the group is declared by this repository and auditable in `codesign` rather
  than inferred from whatever signing metadata a build happened to produce. It is a precaution
  against the "signed out after replacing the .app bundle" report, not a proven fix for it: see
  `docs/platform-notes.md` for exactly what was and was not established.

- **The wording that made https sound compulsory.** The address hint read "Without a scheme, Hermie
  assumes https://.", which reads as a requirement. It then said https is assumed and http works on
  a private network, and it now goes one step further and states the resolution itself — see the
  address-step entry under Added, which supersedes this wording. The README's "Keep the gateway off the public
  internet" told you to run `tailscale serve` in front of the gateway as though TLS were needed on a
  tailnet: it is optional there, and useful mainly when an identity provider insists on an https
  redirect URI or you want a browser-trusted certificate. "Reach it over HTTPS if it is not on the
  same machine" is now "if it is exposed to the open internet". `SECURITY.md` has a Transport
  section stating the stance, and `dashboard.public_url` must still match the address in use,
  scheme included.

### Fixed

- **Every bot showed "Working" when one bot was working.** Asking a single bot something painted the
  blue working bead on every row in the chat list. `session.active_list` is not profile-scoped,
  however much its parameters suggest otherwise: upstream it is a plain method over every live
  session in the gateway PROCESS and it never reads the `profile` it accepts. The roster called it
  once per bot with that profile and marked the bot running if any row came back busy — which could
  only ever answer the same thing for every bot at once, at a cost of one identical round trip per
  bot per poll. It is now ONE call per poll, and each busy row is attributed to a bot by session id:
  the roster's stored id and lineage tip, the open chat's copies of both, and the runtime id the chat
  is bound to. A busy session this app cannot place — another client's session, a cron run — lights up
  nobody, and `title` is never matched on, because `Bot Chat` is the same title on every profile. A
  bot the user is talking to also shows as working off its own streaming `turn.active`, which is true
  the moment the turn is sent instead of up to one poll later. The fake gateway used to filter on
  `profile` and so agreed with the bug; it now reproduces upstream, with the behaviour pinned in its
  upstream-shapes suite.
- **On a Mac, dragging with the mouse scrolled a list instead of leaving the text alone.** A
  "Designed for iPad" app gets full pointer support and UIKit delivers an indirect-pointer drag to a
  `UIScrollView` as a touch, which its pan recognizer accepts by default. Every list and reading
  surface now restricts that one recognizer to direct touches on a Mac, through a new function in the
  local module: a finger still pans, and a wheel or trackpad scroll is not a touch at all — it is
  gated by `allowedScrollTypesMask`, which is untouched — so scrolling keeps working and only the drag
  stops. No-op on iPhone and iPad, and it cannot throw. Selecting text with that drag is a separate
  request and is NOT delivered: React Native's `Text selectable` is a long-press edit menu whose Copy
  takes the whole block, with no selection range in the component at all, so bubbles are already at
  that ceiling. `docs/platform-notes.md` has what is verified, what is only reasoned — the pointer
  behaviour cannot be exercised on the simulators here — and the three-step manual test for a Mac
  window.
- **The app did not launch on iOS 27.** UIKit refuses to start an app built against the iOS 27 SDK
  that has not adopted the scene life cycle, and it refuses before any of our code runs: an
  `EXC_BREAKPOINT` on the main thread in
  `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Expo SDK 54's template is an
  application-life-cycle app and the SDK line ships no opt-in — scene support arrives in SDK 58, with
  a back-port to 57.0.23 — so the app adopts scenes itself:
  `plugins/with-ios-scene-lifecycle.js` writes the `UIApplicationSceneManifest` and
  `modules/hermie-scene` ships the `HermieSceneDelegate` it names. The scene delegate adopts the
  window the app delegate already created rather than making its own, because expo-dev-launcher
  looks for that window during `didFinishLaunching` and calls `fatalError` when there is none, and
  it hands the app delegate back the URL, user-activity and life-cycle events UIKit stops delivering
  there. `AppState`, the splash hand-over and the dev client are unchanged; the iOS 26.5 simulator,
  the iPad and the Mac build are unchanged. `docs/platform-notes.md` has the crash signature, why
  three rounds of simulator work never saw it, and what is verified where.
- **A pinned theme only coloured half the app.** Pinned to Light while the system was in Dark, every
  glass panel rendered as murky dark glass under light ink — a `UIVisualEffectView` takes its
  appearance from the window's trait collection, and the token set never reaches it. `ThemeProvider`
  now calls `Appearance.setColorScheme` with the scheme that won, which sets
  `overrideUserInterfaceStyle` on every window of every connected scene, and `null` when the choice
  goes back to System so the override is released rather than frozen. The pin is read from the
  settings store rather than from `useColorScheme()`, which reports the override back once it is in
  place. `GlassSurface` passes the same scheme to `expo-glass-effect`'s `colorScheme` prop as well.
  Measured in all four system × pinned combinations: a pinned scheme now draws the identical surface
  whichever way the system is set.
- **The dev menu stopped appearing in Debug builds** once the app adopted the scene life cycle:
  expo-dev-menu builds its own window with no window scene, which UIKit never draws. The scene
  delegate now adopts any window that shows itself without one.
- **Settings said its name twice** in the overlay panel — the panel's bar and a large title directly
  under it. Activity and Crons had already dropped theirs; this was the last one.
- **Activity showed an empty timeline against a working gateway.** A
  `GatewayConnection` — and so the whole chat runtime — exists from the moment a gateway is
  CONFIGURED, long before its socket is up, and Activity's background load ran the instant the screen
  mounted. The roster read under it failed with _"gateway not connected"_, a failed roster is
  swallowed as "no bots", and the screen settled on _"your bots have not talked to each other yet"_ —
  permanently, because nothing asked again. It now waits for the connection to be ready and reads
  again after every reconnect, which is the rule the chat roster already had. Opening the panel
  straight after launch lost that race every time.
- **A cron's run history said `Success` for every run, including the ones that died.** A `/runs` row
  is an ordinary session row, and the sessions table has no status column: the outcome is
  `end_reason`. Reading `status` alone meant the screen always fell through to its "ok" default. A
  missed FIRE was invisible for a related reason — `last_fire_error` is `{at, detail}` rather than a
  string, so it was dropped on the way in; its detail is now shown like any other cron error.
- **Tool cards and the rest of the ledger ran edge to edge on a wide window** while every bubble
  beside them stopped at the §4 cap, so the column read as two layouts stacked on each other. Tool
  rows, thinking, cron cards, DM lines and roll-ups, and the request cards now take the same measured
  column rule a bubble takes. Outside a transcript — the Activity timeline draws the same rows —
  there is no column and no cap, which is what it should be.
- **The fold cuts on a line boundary, and the fade is a fade.** It clipped at a fixed height, so it
  landed wherever that height fell — half a line of x-height under a gradient, which reads as a
  sliced row. The clip is now `lines × leading`, the leading comes from the renderer
  (`markdownLeading`) so the two cannot drift, and a table or fenced code block is never cut through
  at all: the Markdown renderer reports where its blocks are and the fold moves the cut up to such a
  block's top and fades the whole block instead. The mask is two and a half lines tall with an even
  ramp, where the old one reached 85 % opacity at 65 % of a fixed 64pt and read as an edge.
- **A REST route may answer with a JSON array.** `GatewayHttp` parsed every body with
  `parseJsonObject`, which rejects an array — so `GET /api/cron/jobs`, which `hermes serve` answers
  with a bare array and which the cron controller is explicitly written to read in either shape,
  failed with _"answered with JSON that is not an object"_ and the crons list was empty against a
  real gateway. The transport now only asks whether the body is JSON; which shape is acceptable is
  the caller's question. The handshakes that genuinely require an object — the status probe, the
  credential exchange, the token endpoints — still use `parseJsonObject`.
- **Crons and Activity no longer say their own name twice.** Both shells already title the screen —
  the overlay panel's header on the wide layout, the stack's title bar on the phone — and each screen
  printed the same word again underneath it. The cron editor's `NEW CRON` eyebrow over `New cron` is
  gone for the same reason; an eyebrow earns its line where it says something the title does not.
- **The switch and the segmented control are §3's.** The switch's off track was a mid-grey fill that
  read as a third state and was the brightest thing in a dark row; it is the sunk tint with a
  hairline. The selected segment is raised onto the control rung with its own hairline and shadow,
  and its label is `text` rather than the accent.

- **Ink contrast is a check, not a paragraph.** `npm run contrast:check` composites every ink role
  onto every surface the way the surface is actually painted — the thinnest gradient stop over its
  rung or over the worst point of each wallpaper — and fails under 4.5 : 1 for anything read as text
  and 3 : 1 for a mark. It reads `apps/hermie/src/ui/tokens.ts` rather than a copy of the palette,
  which is the whole point, and CI runs it beside `icons:check`. 153 pairs, all clear.
- **`okText`.** `ok` had one value doing two jobs and measured 3.47–4.54 : 1 as ink on almost every
  surface, so a `Success` line was below AA wherever anybody would read one. `ok` is now the status
  dot's fill and `okText` is the ink beside it, the way `danger` and `dangerText` have always been
  split.

- **Every surface can be opened directly from the command line, in development.** The simulators on
  this machine can be launched and photographed and nothing else, so three rounds in a row shipped
  sheets and option pages nobody had ever seen. A Debug build now reads launch arguments —
  `--hermieOpen gallery:sheet-options-model-page --hermieTheme dark` — and `GalleryScreen` is a
  registry of addressable sections rather than a fixed scroll, so one launch is one screenshot. A
  section that names a sheet opens it as it mounts, which is what makes a blocking modal
  photographable at all. Three gates keep it out of a release build: the native constant is inside
  `#if DEBUG`, the JavaScript is behind `__DEV__`, and nothing is registered with the system — no URL
  scheme, no entitlement. CONTRIBUTING.md has the grammar; `__tests__/dev-launch-intent.test.ts`
  pins the gate.
- **The gallery reaches surfaces it never carried**: the cron detail, its paused-and-failing state,
  the run transcript, the schedule builder, the status dots, the cron editor sheet, the connection
  line in all four of its states, and the signed-out panel.
- **A chat-list preview is plain text.** The owner read `## Retry semantics: what actu…` off a row on
  a real device — two characters and a space spent on syntax, and the sentence cut anyway. One pure
  function (`src/markdown/plain-text.ts`) takes headings, emphasis, fences and inline ticks, list and
  task markers, blockquotes, thematic breaks, table pipes and link syntax off a reply and collapses
  what is left to one line. It is used by the chat-list row, the bot-to-bot line and its quoted
  reply, and by `formatPreview`.

- **The wide layout, run and looked at.** Part 1 and Part 2 both shipped without anyone seeing the
  sidebar-plus-detail shell on a real device. It has now been built, installed and driven on an iPad
  Pro 13" simulator against the fake gateway, in both themes, and the notes in
  `docs/platform-notes.md` record what was measured rather than what was intended.
- **One connection line, on every layout** (`src/features/bots/ConnectionLine.tsx`). It sits under
  the `Chats` title, draws nothing at all while the connection is healthy, and reads
  `Connecting…` / `Reconnecting…` / `Offline` when it is not. For `needs_signin` it reads
  `Signed out` in amber and is itself the button that starts the sign-in.
- **The signed-out state is shown inside a chat too**, not only beside one. A reader who was already
  in a conversation when the token expired used to get a transcript that had simply stopped, under
  an error about credentials — neither of which says "sign in". `ChatScreen` now takes the whole
  screen for it on both layouts, which also removes the shell's separate copy of the same rule.
- **Bottom sheets are glass**, with the mockup's grabber, and on the wide layout they are capped at
  560 pt and parked over the content column instead of spanning the window.
- **Pages inside the chat options sheet**, with a back control and a per-chat **colour picker**
  whose nine swatches are the same component the row menu uses. Escape goes back exactly one level:
  the first pops the page, the second closes the sheet.
- **An empty named section keeps its heading and gets a row of its own.** It used to be dropped
  unless the list was in edit mode, so a section whose last chat moved out vanished — and in edit
  mode two headings then met with nothing between them.
- **The fake gateway leaves one bot without an avatar.** Every profile used to answer
  `has_avatar: true` and be served the same 1×1 red PNG, so the generated-initial fallback — what a
  real gateway shows for most bots — was unreachable from a run against it.

### Fixed

- **Bold around an inline code span printed its asterisks, on a device only.** Hermes resolves the
  backreference in marked's `blockSkip` rule as the empty string, so the mask marked lays over inline
  code before it looks for a closing emphasis delimiter covered the wrong span — and because that
  mask has to stay character-aligned with the source, emphasis was not found at all. Every Node test
  passed throughout, which is how it survived two rounds. `src/markdown/marked-compat.ts` rewrites
  the rule without a backreference, and is the only place `marked` is imported from now.
- **A bubble on a wide window was capped at 435pt however wide the column was.** The percentage half
  of the §4 rule lived in the style as `maxWidth: '68%'` on a bubble whose parent was sized by its
  own `maxWidth`, so Yoga had no base to resolve it against and dropped it — leaving the point cap as
  the only rule that ever applied, on every layout. The transcript now measures the chat COLUMN and
  the cap is one number: `min(68 % of the column, 640)` wide, the phone rule compact. On a 1376pt
  iPad window a long reply grew from 435pt to the 640pt ceiling; on an iPhone from 250pt to 313pt.
- **A table cell wrapped mid-word.** `docs.example.org` broke after the `r` and left one letter under
  the row, because every column was 150pt flat. A column is now as wide as its longest value, between
  110 and 280pt; the table already scrolled horizontally, which is what pays for it.
- **A text field on a sheet had no chrome.** `TextField` drew nothing of its own, so the cron
  editor's Name, Instructions and Every fields were placeholder text floating on the glass. It now
  draws the sunk well with its hairline everywhere, and nothing inside an `InsetRow`, where the row
  is already the chrome — read from the row rather than passed, so neither side can forget. The
  connection-test screen's two hand-rolled inputs are the same primitive now.
- **The Default swatch was an unlabelled hollow ring** that read as a hole in the row on a dark
  sheet. It carries its name, and every swatch says whether it is the chosen one with a check mark
  rather than only with a thicker ring.
- **Raw gateway enums reached the screen.** The cron detail printed `ok` two rows under a humanised
  `Success`; the run history and Activity printed whatever the gateway sent. One humaniser gives the
  known statuses the design board's words and makes an unknown one readable rather than dropping it.

- **A resume during a turn this client did not author no longer paints it twice.** `message.start`
  carries no author, so the reducer stands a blank placeholder up and waits for a tail fetch to name
  one. `shownTurn` read that blank text AS the newest prompt — so a cron delivery already in history,
  with the scheduler's turn running over it, failed to match `inflight.user` and the resume stood a
  SECOND card beside the first. That was pinned as a KNOWN GAP in
  `packages/transcript/src/duplicate-cron-turns.test.ts` and is now a passing test. A placeholder is
  a promise of a prompt, not a prompt: it is walked past, so it neither counts as the shown prompt
  nor hides the item that is one, and the resume fills it in place (never appends, which would put
  the prompt below the reply it started) or drops it when the prompt is already on screen.
- **The same hole for a teammate's turn, which had no test at all.** An inbound bot message opens a
  turn here and is drawn as a tinted bubble holding only the BODY under its `Message from 🤖 …`
  signature, while `inflight.user` is the raw row. The comparison now runs through the same parsers
  `rows-to-items` uses, and a resume mid-teammate-turn projects a DM bubble rather than the signature
  line in a user bubble. The plain-user key goes through `stripUserText` for the same reason, so a
  prompt carrying `@file:` directives matches the bubble standing for it.
- **A sheet's title is `sheetTitle` (21/26), not the 28 pt sidebar title.** Every sheet had the
  larger one; it is obvious on a device and invisible in a component test.
- **Naming a page on the chat options sheet now opens it.** The sheet is mounted for the life of the
  screen, so `useState`'s initial value ran long before anyone asked for a page. It re-reads as the
  sheet becomes visible, which also stops an ordinary open landing on the page the last reader left.
- **Every wide-layout panel was painting the wallpaper's own colour over its glass.** `Screen` fills
  with `colors.bg` and adds the safe-area inset, which is right on a phone and wrong inside a
  floating panel that has already done both. Measured on the iPad simulator in the dark theme, the
  chat column sampled `#0A1830` — `elevation.e0`, the wallpaper rung — while the sidebar beside it
  sampled `#1B2744`, the panel rung it should have; after the fix both sit on the panel rung. This
  is why dark mode read as one flat field rather than as an elevation ladder.

### Changed

- **The Part-1 token aliases are gone**, and their users migrated: `bg` → `elevation.e0`,
  `surface` → `elevation.e3c`, `success` and `switchGreen` → `ok`, `border` → `hairline`,
  `bubbleBlue` → `accent`, and `incoming` / `incomingText`, which nothing used. `surfaceRaised` was
  not one rung — light `#E6EEFB` sits between `e2` and `e2s` while dark `#3E5480` IS `e3` — so each
  of its seventeen users took the rung its ROLE names: `e2` for a pressed or hovered row, `e3c` for a
  machine card, `tintSunk` for a code well, a command well and a segmented track. The type aliases
  `display`, `heading`, `callout`, `caption` and `mono` are gone too, onto `title`, `name`,
  `preview`, `meta` and `code`. `title` stays: §3 of the tokens document names it, so it was never an
  alias.
- **`danger` is the fill and `dangerText` is the ink.** `danger` held the ink's value, so the two
  were interchangeable and a `Text` could ask for either. It now carries §1.1's fill (`#C0293A` /
  `#D8465A`), every `Text` that asked for it asks for `dangerText`, and a Delete or Deny button is
  the colour the mockup draws.
- **Adding a divider opens an empty field, focused, whose placeholder is `Section name`.** An older
  build seeded the field with `New section`, so the first thing typed landed after it and the owner's
  device still carries a section called `New sectionFinance`. There is no migration for a build that
  was never released; instead the field is now visibly a field (a hairline, 15 pt, a 34 pt minimum),
  Remove is a bordered chip rather than a bare word beside it, and an unnamed section reads
  `Untitled section` rather than borrowing the old seed as its heading.
- **The sheet eyebrow is the `micro` token** rather than three numbers written out beside it, which
  is how it had drifted to a heavier weight and nearly twice the tracking the scale asks for.

### Removed

- **The gateway card** at the foot of the wide sidebar. It spent a permanent row on the state it is
  in every second of every day, said it in different words from the phone's own line, and carried a
  latency figure the app cannot measure. The footer is the four-tab strip on every layout.

- **The Liquid Glass direction, part 2: the conversation itself.** The transcript, the composer and
  everything the machine says in a chat now follow `design/liquid-glass.html`.
- **A bubble tail that is one shape.** `src/chat-ui/primitives/Bubble.tsx` draws the tail as a single
  SVG path belonging to the bubble (`react-native-svg`), positioned behind it so only the part that
  escapes the bubble's rounded corner is visible, and only on the LAST bubble of a run. The previous
  build built it from positioned `View`s and drew one on every bubble: on the Mac that showed as a
  square of bubble colour protruding past the bottom-right corner with a dark sliver beside it.
- **Grouping and date stamps** (`src/chat-ui/grouping.ts`), computed once per list rather than
  guessed at per row — which bubbles continue a run, which one carries the tail, and where `Today` /
  `Yesterday` / a date goes. A tool row between two replies ends a run: the reader can see it, so the
  replies are not adjacent.
- **Outgoing bubbles take the chat's accent gradient**, incoming ones the frosted glass recipe, and a
  LONG reply the near-opaque reading wash — not a stylistic variant but the only way body-text
  contrast stops depending on the wallpaper behind it. Past about fourteen lines the body folds with
  a gradient mask and `Show more`. The message that is currently streaming is never folded.
- **Per-item disclosure state lives above the list** (`src/chat-ui/expanded.tsx`). Every fold, card
  and roll-up keys its open/closed flag by item id in one set, so scrolling an opened card out of the
  window and back no longer re-collapses it. Nothing scrolls because a disclosure opened.
- **One bubble from start to finish.** The typing dots are now inside the assistant's own bubble as
  soon as it exists. The build drew a bubble of dots AND an empty assistant bubble with a timestamp
  in it — the grey rectangle reported from real use.
- **Cron deliveries are their own card**, not the owner's blue bubble. A clock glyph, the job's name
  and `ran 04:22 · delivered to this chat`, expanding to the report as rendered markdown. The wire
  carries no marker for this, so the projection is a documented heuristic — see
  [ADR-0013](docs/adr/0013-cron-deliveries-in-the-transcript.md).
- **Outgoing bot-to-bot messages are quiet LINES**, not bubbles: an arrow, `Message to @writer`, a
  preview, the time, and a reply marker that is always present — replied, waiting (a static hollow
  dot), or failed. Tapping one expands the exchange IN PLACE; it no longer navigates to the other
  bot's chat and scrolls it. Navigation lives behind one explicit `Open @writer's chat` link, which
  still lands on the matching row. More than three in a row roll up into
  `5 messages to @writer · 4 replies`.
- **Tool rows, thinking, status rows and notices are a quiet ledger** with one silhouette
  (`src/chat-ui/primitives/LedgerRow.tsx`), expanding onto glass cards so the expensive content is
  not mounted until asked for.
- **User bubbles render markdown too**, so a person who typed `**done**` or a path in backticks sees
  what the reply beside them would.
- **The composer is three separate controls** — a round glass `+`, the pill field, a round accent
  send that becomes a red stop square. A button that is not inside the field cannot overflow it.
- **`+` opens an instant in-app glass menu** (_Photo library_, _Choose file_; file first on a Mac).
  It is local state with no `await` in it, so it paints in the same frame as the tap, and the chosen
  entry shows a busy mark for as long as the system picker takes. Measured on the simulator: the
  menu is up in the frame of the tap, the picker follows 0.8–1.6 s later. The long-press placeholder
  for attaching a file is gone.
- **An attachment tray with file chips**: type glyph, the name middle-truncated so the extension
  survives, the size, a remove `×`, a progress ring while uploading, and the reason it was refused
  (`Too large · 100 MB max`). A sent file is a chip under the owner's bubble, never a raw `@file:`
  token.
- **A glass Jump-to-latest pill** with the unread count as an accent badge.
- **Licences, both halves.** `THIRD_PARTY_NOTICES.md` now also lists the upstream Desktop code this
  project ported, and `scripts/generate-third-party-licenses.mjs` walks the production dependency
  tree and writes `THIRD_PARTY_LICENSES.md` plus a bundle the app reads lazily for Settings → About →
  Licences. `npm run licences:check` runs in CI next to the icons check.

### Fixed

- **Bold was lost when a model opened the span with a stray space** — `** \`example.nl\` staat op
  autorenew=off**` rendered its asterisks. That shape is not valid CommonMark, so marked never
  emitted a `strong` token at all; `preprocess.ts` now repairs a run with exactly one broken end,
  which is what tells the two model habits apart from arithmetic.
- **An inline code span that wrapped painted an empty chip** across the rest of the line. A nested
  `Text` with a background paints every line fragment of its range, and the chip's padding was an
  ordinary space, so a wrap left a whitespace-only fragment filling the line. The chip's padding and
  its internal gaps are now non-breaking, and the chip takes its own tint rather than borrowing the
  code-block surface, which on the incoming bubble read as a redaction bar.
- **The fold's gradient mask faded through black.** `transparent` is transparent BLACK in React
  Native, so a mask interpolating to the surface colour travelled through dark grey and left a dirty
  band across the last lines. It now fades a colour to itself, and bleeds out to the bubble's edges
  so it is a fade rather than a visible rectangle.


- **The Liquid Glass direction, part 1: tokens, shells and the chat list.** The flat Messenger look is
  gone. `src/ui/tokens.ts` is now the token set from `design/liquid-glass-tokens.md` — a dark
  elevation ladder whose rungs are a measurable step apart, glass recipes per surface, three gradient
  wallpapers, the presence colours, and the eight per-chat swatches with their gradient stops. Dark
  mode is a blue-slate ramp rather than one flat black field.
- **`src/ui/glass/`**, one `GlassSurface` for every glass surface in the app. It draws the real
  material on iOS 26 through `expo-glass-effect`, falls back to `expo-blur` on older iOS, and
  collapses to a rung of the elevation ladder on Android and under Reduce Transparency — the same
  tokens in all three cases, which is what that ladder is for. The tokens document's rule about never
  nesting glass more than one level is enforced by the component rather than documented and hoped
  for: a surface past level 3 drops to a tint on its own. `Wallpaper` draws the three backgrounds as
  gradients, with no image assets.
- **A wallpaper setting** under Settings → Appearance: Blue (the default), Warm, Graphite, each with
  a light and a dark variant.
- **A wide layout that floats.** Two glass panels over the wallpaper with the mockup's gaps and
  radii. Activity, Crons and Settings now slide in over the chat column from the right behind a
  dimmed scrim, and the sidebar stays put and stays usable — they are things you consult, not places
  you go, and replacing the chat with them costs the reader their place. The panel closes on its
  round button, on a tap outside it, and on Escape.
- **Escape goes back one level.** A sub page inside the overlay — a cron's detail, a run transcript,
  the connection test — registers above the panel on the existing Escape stack, so the first press
  returns to the page underneath and only the second closes the panel.
- **Presence as one pure function** (`src/features/bots/presence.ts`), shared by the list and, in
  part 2, the chat header, so the two cannot disagree. Four states, and a precedence order that is
  the point of it: offline outranks everything, because a "needs input" bead on a chat that cannot be
  answered is a promise the app cannot keep; then needs input, then working, then online. The bead
  never carries the state on colour alone — the shape differs per state and the row says it in words.
  **"Needs input" is the only thing in the app that animates**, and it goes static under Reduce
  Motion.
- **Filter chips** over the chat list: All, Unread, Working, Needs input.
- **The list is the owner's, not the gateway's** ([ADR-0012](docs/adr/0012-local-chat-list-layout.md)).
  Rows can be reordered and grouped under named dividers, bots can be archived into a collapsed
  `Archived (n)` row at the bottom, and each chat can take one of eight colours. All of it is stored
  on the device and keyed by gateway address, which is what makes "Change gateway" start clean and
  "Sign out" keep the arrangement, with no clean-up code on either path. An archived bot is excluded
  from the filters, the unread totals and Activity's background loading.
- A round **New cron** control where a compose button would be, because there is one canonical chat
  per bot and you never create a conversation (ADR-0007).
- **The Mac, as the iPad build.** `npm run mac` builds the iOS app for
  `platform=macOS,variant=Designed for iPad`, signs it with the team in `HERMIE_APPLE_TEAM_ID`, and
  wraps the product so macOS will launch it — a bare iOS `.app` refuses to open with "incorrect
  executable format", and the shape it wants is `Hermie.app/Wrapper/Hermie.app` with a relative
  `WrappedBundle` symlink. `--no-open` builds without launching, `--debug` builds against Metro.
- One seam that answers "is this the iOS app running on a Mac?": a local Expo module,
  `apps/hermie/modules/hermie-mac`, exposing `ProcessInfo.processInfo.isiOSAppOnMac` as a constant
  behind `src/platform/runs-on-mac.ts`. React Native exposes nothing equivalent —
  `Platform.isMacCatalyst` reads a compile-time flag that is false for a "Designed for iPad" binary.
  The module is Apple-only, so Android and the test environment read `false` with no second
  implementation.
- **Shift+Enter inserts a newline** on a Mac, and a bare Enter still sends. The same module reads
  GameController's HID state, which is the only place the modifier exists: a text field's key event
  carries no modifier flags on iOS, so Shift+Return and Return arrive identically. The composer asks
  while it is handling the Return and, for Shift, writes the newline into the draft at the caret —
  replacing a selected range the way typing a character would, and leaving the caret after the
  newline rather than at the end of the draft. `Enter to send · Shift+Enter for a new line` now sits
  under the field wherever a bare Enter sends.
- **Escape closes things** on any build with a hardware keyboard attached. It comes from the same
  module and for the mirrored reason: Escape inserts no text, so it never reaches a text field at all,
  and a `UIKeyCommand` would sit in a responder chain that a presented `Modal` leaves — which is the
  case that matters, because a sheet is the main thing Escape should close. `useEscapeKey` routes it:
  a stack, last registered wins, one native subscription. It dismisses a sheet, closes the slash
  popover, backs out of the sign-in page, and stops a running turn when nothing else is open. A
  **blocking** sheet swallows Escape instead of being dismissed by it — ADR-0010 says an agent's
  question is answered by an explicit tap, and letting the key fall through would stop the very turn
  waiting for the answer.
- [ADR-0011](docs/adr/0011-mac-via-the-ipad-build.md), which supersedes ADR-0002 and lists what a day
  of building on react-native-macos actually cost.
- Project skeleton: npm workspaces, TypeScript project references, ESLint, Prettier, commit-message
  rules and a CI check job.
- `apps/hermie`, an Expo SDK 54 app targeting iOS, iPadOS, Android and the Mac, with the compact and
  regular shells, design tokens, theming and the platform storage abstractions.
- `@hermes/shared`: the Hermes protocol sources, vendored from a pinned upstream commit by
  `scripts/sync-hermes-shared.mjs`. The rewrites are asserted, `--check` fails on drift, and the
  upstream tests are vendored with the sources and run unchanged.
- `@hermie/gateway-client`: a React-free client for a Hermes gateway — URL and header handling, the
  unauthenticated probe, native PKCE with a token coordinator that keeps refreshes single-flight,
  session-token and PKCE credential providers, an HTTP layer that retries once after a 401, a dial
  plan socket factory, and the connection state machine over one long-lived JSON-RPC client.
- `@hermie/fake-gateway`: a gateway stand-in for tests and offline development, with a CLI behind
  `npm run fake-gateway`.
- A hidden developer screen at Settings → Connection test that probes an address and opens a real
  connection to it, reachable through a Settings link in the compact shell's header.
- Architecture decision records 0001 to 0005, a glossary, platform notes and a gateway runbook.
- An onboarding wizard: Welcome, gateway address, sign in, test connection, done. The address step
  probes the gateway while you type — debounced, and with a sequence guard so a slow answer cannot
  overwrite a newer one — and turns every failure into one sentence with the server-side fix where
  one exists. An "Advanced" disclosure takes extra request headers for a gateway behind an access
  proxy.
- Native PKCE sign-in through `NativeSignInWebView`: a full-screen, forgetful web view that renders
  the gateway's own sign-in page and intercepts the loopback redirect before it is loaded, verifies
  the `state`, and exchanges the code. If the web view cannot be used, the same flow completes
  through the system browser and a pasted redirect, parsed by the same function.
- A mandatory connection test that exercises REST and the WebSocket, tied to a payload key so that
  editing any field invalidates the result rather than leaving a stale success on screen. Only once
  it passes are credentials written to the secret store and the gateway configuration to the app's
  preferences.
- `GatewayProvider`: one `GatewayConnection` for the app's lifetime, built from the stored
  configuration at startup, following the app lifecycle and connectivity, with connection state in a
  store any screen can subscribe to. An expired session raises a banner that signs in where you are
  and resumes the dial loop.
- A Settings screen with the gateway, the live connection status, sign-out, change-gateway, and the
  developer connection test.
- English UI strings collected in `src/i18n/strings.ts`, and design tokens updated to the Messenger
  direction from `design/tokens.md`.
- A connectivity seam (`src/platform/net-info.ts`) so that macOS, where NetInfo has no native module,
  no longer fails at startup.
- Sending files, not only images. Upstream has no file-attach RPC, so a file is streamed to
  `POST /api/files/upload-stream` — multipart from the picker's URI, so nothing larger than a chunk
  is ever in JavaScript memory — and the prompt then carries the `@file:` reference the gateway
  expands. It has to land inside the session's own working directory, which is the only place that
  satisfies both the managed-files policy and the `allowed_root` the gateway pins `@file:` to;
  docs/platform-notes.md records why, with the upstream lines. The 100 MB cap is checked before any
  bytes move, every failure carries a reason rather than a raw message, and the file path sits behind
  a long press of the existing "+" so the composer's design is left to whoever owns it.
- `@hermie/transcript`: the chat engine — one item model that both history rows and live events
  project onto, a reducer that never filters and never invents an author, stable-id reconciliation,
  and verbosity as read-time selectors.
- The chat data layer. `src/store/chats.ts` holds one transcript per bot plus the runtime-session-id
  map that routes events and server requests to the right chat; `src/store/bots.ts` holds the roster,
  avatars, running state and the read watermark behind the unread marker; `src/store/settings.ts`
  holds the verbosity, bot-to-bot and thinking preferences, with one global default and an optional
  override per chat.
- A chat controller that owns every round trip a conversation needs: cache paint, `session.resume` on
  the durable id, history over RPC or — past four hundred rows — over the REST transcript,
  reconciliation, the in-flight snapshot, and the missed-event replay, in that order. It keeps every
  opened chat attached so bot-to-bot traffic keeps arriving, debounces `sessions.changed` into one
  tail reconcile per burst, re-resumes every live chat after a reconnect and refetches only the
  histories whose message counts moved, and drops the runtime id on `session.reclaimed`.
- Sending, with the message painted before the round trip and settled against `prompt.submit`'s
  status; images attached before the prompt that uses them; stop; approvals and clarifications;
  subagent steer, interrupt and tail; slash completion and execution; and the chat options (YOLO,
  fast, reasoning effort, model) scoped to the session so the gateway's global configuration is never
  rewritten behind the user's back.
- A bots screen and a chat screen wired into both shells, with the bot list as the sidebar on a wide
  window.
- `ChatCache`, a SQLite store for the roster and the last two hundred items per chat, so a chat
  paints before the gateway answers. It downgrades to memory if the database cannot be opened.
- The fake gateway grew the surface a chat needs: profile assets, the active list, the command
  catalogue and completion, session configuration, pending approvals, subagent methods and image
  attachment. Prompts steer it — "approve" raises an approval and parks the turn on it, "delegate"
  fans out subagent events — and `POST /__fake/inject` injects a turn somebody else ran.
- Routines: the cron surface, as a self-contained feature. The list comes from WS `cron.manage` with
  `include_disabled`, split into Active and Paused, each row carrying its schedule in words, the next
  run as a relative time, a status dot and — when the scheduler wrote one — the first plain sentence
  of its last error rather than the Python exception around it. A banner says so when
  `gateway_running` is false, because a routine on a gateway whose scheduler is down looks perfectly
  healthy and fires nothing.
- A routine detail screen with the full prompt, Pause/Resume, Run now, Edit and a Delete that asks
  first, over the run history; a run opens as a read-only transcript rendered by the same engine as a
  conversation, with no composer.
- A routine editor as a bottom sheet, with a schedule builder that writes only the forms
  `parse_schedule` documents — `every 30m`, `every day at 9am`, `every monday at 9am`,
  `weekdays at 9am`, a validated five-field cron expression, `in 2h` or an ISO timestamp — and shows
  the exact string before it is sent. It never predicts a next run: the schedule is parsed in the
  gateway's timezone, so the server's `next_run_at` is the only truth the screens show.
- The fake gateway's cron surface now matches `hermes serve`'s: three routines including a paused one
  and one carrying a scheduler exception, run sessions whose transcripts come back through
  `session.history`, delivery targets, a merging `PUT`, a `trigger` that appends a run, and a
  `cron.changed` broadcast after every mutation.
- The chat list, in the Messenger direction: a large title, a search field that filters on name and
  description, and one row per bot carrying its avatar, the last thing said, a relative stamp and the
  badges that decide whether you tap it now or later. A preview that starts `Message from 🤖 Writer
  (@writer):` is folded to `🤖 @writer: …`, because spelling it out in full on a forty-character row
  buries the message itself. "Working" comes from `session.active_list`, polled only while the list
  is on screen; "needs your input" comes from the open requests the chat store already holds, so it
  is true for a question that arrived while the list was not on top. Footer tabs reach Activity,
  Routines and Settings.
- The conversation, drawn with the chat UI kit: the header with its avatar and live subtitle, the
  transcript with bubbles, markdown, tool cards, DM cards and subagent groups, the agents bar pinned
  under the header while children run, the composer with its attachment tray and slash popover, and
  the jump-to-latest pill. The compact stack hides its own header for that route rather than
  configuring it, because a native title bar cannot carry an avatar and a status line.
- Approvals and clarifications as bottom sheets driven by the open requests in the transcript: one at
  a time, oldest first, acknowledged to the queue on first show so the countdown stops, and answered
  only by an explicit tap. A question resolved elsewhere or timed out says which.
- The chat options sheet, bound to `session.info` for YOLO, fast mode, reasoning effort and the model
  inventory from `model.options`, and to the per-chat view settings for verbosity, bot-to-bot and
  thinking. A chat that pins its own view says so and offers to follow the default again. A model the
  gateway flags as expensive is confirmed before it is set.
- Attachments: the photo library, resized to 1568 px on
  the longest edge before they are encoded — a camera-roll photo is several megabytes and
  `image.attach_bytes` shares the socket the transcript streams on.
- A Chat section in Settings for the default verbosity, bot-to-bot and thinking, and an Appearance
  section that pins the app to light or dark instead of following the system.
- An app icon: a speech bubble carrying an H whose crossbar lifts like a wing, drawn by hand as
  `design/icon.svg`. `scripts/generate-app-icons.mjs` rasterises it into every size the app ships —
  the iOS and Android icons, the Android adaptive foreground, the splash image and the favicon — with
  a scan-converter written for the purpose, so the icons need no image
  tooling installed and come out byte-identical on every machine. CI fails if any of them has drifted
  from the SVG.
- A release process. `.github/workflows/release.yml` builds an Android APK on a `v*` tag and publishes
  a GitHub release with the CHANGELOG section for that version. `docs/release.md` is the runbook,
  including the halves a machine cannot do: TestFlight and Play internal testing through EAS.
- `scripts/set-version.mjs` sets the version in every place that carries it — both package.json files
  and `app.config.ts` — and fails loudly rather than skipping a file whose shape has changed. `scripts/changelog-section.mjs` reads one version's notes out of this
  file, which is what the release workflow publishes.
- Repository furniture for a public project: a Contributor Covenant code of conduct, issue forms for
  bugs and feature requests, and grouped weekly Dependabot updates for npm and the actions.
- Activity: one timeline of everything the bots said to each other — `researcher → writer: …`, the
  reply that came back, and every `delegate_task` fan-out — grouped by day, newest first, with a tap
  that opens the conversation a row came from scrolled to that exact message. It is a view over the
  transcripts the app already holds rather than a second copy, and bots nobody has opened are filled
  in by a background load of their newest rows through the same projection, so opening one afterwards
  reconciles onto those items instead of duplicating them. A delivery is written into both chats, so
  the sender-side dispatch wins the dedupe: it is the row that knows whether the message was queued,
  delivered or failed. Three counters sit above it, each from a different call — bots working from
  `session.active_list`, live sub-agents from `delegation.status`, deliveries still in flight from
  `agents.list` filtered to the `bot_mode_dm.py --run-delivery` runner — polled only while the screen
  is on top.
- Bot-to-bot traffic is now walkable in both directions. A dispatch card opens the recipient's chat on
  the inbound message it produced, and an inbound message's header opens the sender's chat on the
  dispatch that sent it; the two rows share a sender, a recipient and a body but no identifier, so the
  match is handle plus nearest stamp and it refuses rather than guesses. While a dispatch is out and
  the recipient's chat is mid-turn, the card says `@writer is writing…`.
- `subagent.list`, folded in when a chat opens and every five seconds while anything is delegating.
  `subagent.*` events have no replay, so a conversation opened halfway through a delegation never saw
  its children start; the roster is the only way to learn about them. It adds and refreshes and never
  resurrects a child the stream already saw finish.
- The agents sheet gained a read-only transcript per child: the live `subagent.tail`, polled every
  three seconds while the child runs, and — once it has a `child_session_id` — the child's own stored
  session, which outlives the tail. Steer and Stop now report what the gateway answered, including a
  steer that arrived after the child's last batch.
- The unread badge counts. A chat the app has loaded shows how many replies and inbound teammate
  messages arrived since it was last looked at, capped at `99+`; a chat it has never read keeps the
  dot, because `last_active` is all the gateway reports and a number there would be invented.
- The transcript can be asked to scroll to one item, with the `onScrollToIndexFailed` recovery a
  virtualised list needs, and it reports honestly when the item is not in the visible set — a chat on
  Quiet genuinely does not contain every row.
- Hardware-keyboard handling in the composer: `Cmd`/`Ctrl+Enter` sends and `Escape` stops a running
  turn wherever a platform reports them, and a bare `Return` sends where a physical keyboard is
  certain. See the Changed entry below for what that turned out to mean on iOS.
- The fake gateway's delegation is now three children over several seconds with one of them failing,
  wrapped in a real `delegate_task` call, plus `subagent.list`, `delegation.status`, `agents.list` and
  a live `message_agent` hand-off whose reply comes back as a `process_complete` row. A fan-out that
  finished inside one frame could not be looked at, let alone steered.

### Changed

- **The signed-out state is no longer a one-line banner.** A real Mac session reported the obvious:
  what a reader saw was a chat error in the content area and a small "Sign in" in a corner, and it
  was not clear at all that the thing to do was sign in. It is now a card that takes the whole content
  column — it names the gateway, offers the same in-place sign-in the banner used, and offers Change
  gateway — the sidebar's gateway card turns amber and is the same action, and the chat list stays
  visible from cache with its rows reading Offline. `ReauthBanner` is gone; `SignedOutPanel` and
  `useReauth` replace it.
- **The empty strip under the macOS title bar is gone above the sidebar too.** It had been fixed for
  the chat column only: the sidebar pane carried a top padding of its own that the Mac-aware inset
  never reached. Both panels are siblings in one row now and the row carries the safe area once, so
  the two columns cannot disagree about a number neither of them owns.
- The four-tab strip (Chats · Activity · Crons · Settings) and the gateway card sit at the bottom of
  the chat list on both layouts, as the mockup's two frames show.
- `design/liquid-glass.html` and `design/liquid-glass-tokens.md` are the current reference;
  `messenger.html` and `tokens.md` are superseded and say so.
- **The Mac version is the iOS app** running as "Designed for iPad" on Apple Silicon, instead of a
  native react-native-macos target. Eight platform seams collapsed back into one implementation each —
  bottom sheets, safe area, haptics, the status bar, the secret store, attachments, connectivity and
  the shell — and the Mac now has a real keychain, a real `Modal`, a real navigator and every Expo
  module. Apple Silicon only, and distribution moves to TestFlight and the App Store, which offer an
  iPhone/iPad app on a Mac from the same listing.
- A bare `Return` sends on a Mac through `submitBehavior="submit"` and `onSubmitEditing`, not through
  `onKeyPress`. On iOS a text field's key event carries no modifier state and cannot suppress the
  insertion, so `submitBehavior` is the only thing that can stop a Return becoming a newline. Which
  Return it was comes from the keyboard itself — see the Shift+Enter entry above.
- The composer no longer looks for Escape in `onKeyPress`. It never arrived there on iOS, and there is
  one mechanism for the key now rather than two that could both fire.
- A Mac window no longer pauses the gateway connection when it leaves the front. `pause()` closes the
  socket, which is right on a phone and wrong for a window that is merely hidden or behind another app.
  The owner's report of "gateway not connected" on the Mac build is consistent with that, though
  neither the banner's cause nor the AppState values a Mac window reports have been measured. The
  approval and subagent polls keep running there for the same reason.
- `expo-secure-store` is the secret store on the Mac too, so the AsyncStorage fallback and the warning
  that a Mac build must not be pointed at a production gateway are both gone. Linked and entitled;
  **not yet exercised in a running Mac window**.
- The version script writes three places, not four, and has no `--build` flag: the hand-maintained
  macOS `Info.plist` was the only file that carried a build number by hand, and EAS owns that number.
- `.easignore` names the parent directory of the two generated native projects. A bare `ios/` pattern
  matches at any depth and also swallowed the local Expo module's `ios/`, which would have produced an
  EAS build with no native module in it. `npx expo-doctor` fails on exactly that.
- The `overrides` entry pinning `react-native` and `react` in the root `package.json` is gone. It
  existed so react-native-macos resolved against Expo's runtime, and removing it changed no
  resolution in the lockfile.
- The flat-colour placeholder artwork and the script that wrote it are gone, replaced by the icon set
  above.
- The native CI jobs run on release tags as well as on demand, build with signing switched off, and
  keep the Android APK.
- Android asks for the network and the photo library and nothing else; `VIBRATE` and
  `WRITE_EXTERNAL_STORAGE`, both pulled in by dependencies rather than wanted, are blocked. iOS
  answers the export-compliance question in advance, the splash screen now hands over to the app's own
  background colours, and the Android adaptive icon sits on the blue from the middle of the icon's
  gradient.
- An answered approval leaves a receipt that says what was decided and about what — `Allowed once ·
  rm -rf ./build`, with the command truncated — instead of `Answered: once`, which said neither.
- A finished reply only shows its duration next to something that explains it. A bare `0.1s` under a
  bubble read as a stray artifact rather than as part of the message.
- The typing dots follow the turn rather than the chat being busy. A chat whose turn has ended while a
  sub-agent keeps working is not about to say anything, and three dots there promise a sentence that
  is not coming.
- A reply addressed at another bot is drawn slightly quieter than one addressed at you.
- Dragging the transcript down now lowers the keyboard with the finger.
- The scheduled-prompts feature is called **Crons**, not Routines. The gateway, its CLI
  (`hermes cronjob list`) and its dashboard all say cron, and a second name for the same thing only
  cost the reader a translation step. Where the list spans more than one profile, each row now says
  which one it belongs to, and creating a cron picks the profile it is created for.

### Fixed

- **A message you sent no longer comes back as a second bubble.** Reported against a real gateway:
  one long multi-paragraph message, shown twice a minute apart, with the turn still running. Nothing
  links a locally sent turn to the row the gateway writes for it — `prompt.submit` answers with a
  status, never a row id — so the two are paired on their text, and four separate things broke that
  pairing. Each is now covered by its own case in `packages/transcript/src/duplicate-turns.test.ts`
  and `apps/hermie/__tests__/chat-duplicates.test.ts`; `docs/platform-notes.md` has the diagnosis.
  - **A resume projected its whole in-flight turn regardless of what was already on screen.** The
    gateway writes the user row at submit time rather than when the turn ends, so the prompt is in
    the rows AND in `session.resume`'s `inflight` — and a reconnect, or the chat reopened mid-turn,
    painted it beside the bubble already standing for it. The second copy carries the time the resume
    landed, which is the minute in the report; the reply got the same treatment. Both halves now
    settle onto what the transcript holds. A prompt repeated on purpose still gets its own bubble:
    what tells a repeat from a re-description is whether a durable reply sits between them.
  - **A send carrying a file paired with nothing.** The bubble held the body as submitted, `@file:`
    directive and all, while the row comes back with those directives lifted out into `attachments`.
    The optimistic bubble now goes through the same projection a persisted row does.
  - **Match text is normalised to NFC.** Two spellings of the same accented word are one message to
    a reader. Nothing but the comparison sees it.
  - **A parked burst lost its author after the first prompt.** The reducer remembered one queued
    prompt, so the second of a burst started as a foreign turn and stood an empty placeholder in
    front of the user's own message.
- **Rows are shown in the gateway's order, not in the order they reached us.** A tail fetch spliced
  every row it had not seen in front of the live tail, which is wrong for a row written BEFORE the
  message on screen — a teammate's delivery or a cron turn that landed while the user was still
  typing carries a lower row id, and the ids that say so only arrive with the tail. The reader saw
  their own message above one written before it.
- **`expo-secure-store` on a Mac is exercised rather than assumed.** A Mac window stayed signed in
  across a quit and a relaunch. `SECURITY.md` and `docs/platform-notes.md` no longer carry it as
  unverified. One thing seen once and not explained is recorded as such: the first launch of that
  build did ask for a sign-in again.
- **Return, Shift+Return and Escape on a Mac are verified by hand**, which also settles that
  `GCKeyboard` is populated for an iOS app on a Mac — none of the three is reachable otherwise.
- `GameController.framework` is linked into the Mac and iOS builds, which is all GameController asks
  for — no entitlement and no Info.plist key. Whether `GCKeyboard.coalesced` is populated for an iOS
  app on a Mac is reasoned from the SDK and **not yet watched**; if it is nil, Shift+Enter and Escape
  degrade to doing nothing rather than failing.
- The empty band under the title bar on a Mac. An iOS app on a Mac is told it has an iPad's status
  bar, and `Screen` turned that ~25pt top safe-area inset into padding nothing occupied, because the
  macOS title bar is outside the app's window. The top inset is dropped on a Mac and only there;
  iPhone and iPad are untouched. Fixed in code, **unverified in a window**.
- A chat opened while the socket was still dialling failed outright and nothing retried it. The
  screen called `openChat` on mount regardless of the connection, and `session.resume` on a
  connection that is not up rejects immediately — it does not queue — so a cold start or a tap during
  a reconnect put "This conversation could not be opened: gateway not connected" over the
  conversation, with a Try again nobody should have had to press. The open now waits for the
  connection to report ready and runs on the transition to it, which is the same fix the bot roster
  got for the same race and which covers every reconnect; a failed attempt is retried on the next
  ready connection. While it waits the screen keeps whatever the cache painted and says so quietly.
  The red banner is now reserved for failures that happen while there is a connection, and a
  connection that will never become ready on its own — signed out, too old, or refused by the
  gateway's own configuration — says which of those it is instead of "gateway not connected".
- A resumed chat dropped the gateway's own view of the session on the floor. `session.resume`
  answers with `info` — the model, the flags, the working directory — and it was read once for the
  compatibility check and then discarded, so `chat.info` stayed empty until the gateway happened to
  send a `session.info` event. `refreshOptions` already assumed otherwise, merging its patch onto
  "what the resume reported".
- The chat header said "Connecting…" over a conversation that was loaded and streaming. Resuming
  from the background walks the whole pre-dial ladder again while the session keeps working, and the
  subtitle was reading the socket's bookkeeping rather than this chat's state.
- The cron list showed nothing for a cron that lives in a bot's profile, while the gateway dashboard
  listed it. The list was read over the socket, and `cron.manage` is profile-scoped: it binds
  HERMES_HOME to its `profile` parameter and answers from that one store, so an unscoped call
  reported the launch profile's jobs and silently omitted every other profile's. The list is now
  `GET /api/cron/jobs?profile=all`, the only surface that walks every profile and the only one that
  says which store a job came out of; one socket call rides along for `gateway_running`, which no
  HTTP route reports, and its failure no longer costs you the list. Every detail read, run history,
  pause, resume, trigger, edit and delete now names the owning profile.
- A cron read over HTTP showed no schedule and always claimed to repeat until removed. The stored job
  keeps the parsed schedule as an object with the readable form beside it under `schedule_display`,
  and `repeat` as `{times, completed}` rather than a count — both were read as if they were the
  socket's already-flattened strings, so both came out empty.

- A reply that arrived after a tool call was painted twice — once as the partially streamed copy and
  once as the clean final — while the gateway had stored a single row. The tool boundary seals the
  streaming bubble, so the completion had nowhere to land; it now settles onto that sealed bubble
  whenever the two texts are prefix-compatible, which only the same message can be. Upstream carries
  the same fix.
- The approval sheet labelled its buttons from a vocabulary the gateway never sends. Hermes answers
  with `once`, `session`, `always` and `deny`, so every approval showed raw protocol words instead of
  "Allow once" and "Always allow".
- Every secret field offers to show its value, so a pasted token can be checked before it is saved.
- `expo-image-picker` needs an explicit photo-library usage string; without one iOS terminates the
  app the moment the permission is requested, with no dialog and no crash report.
- Every message you sent appeared twice a moment later. `prompt.submit` answers with a status and no
  row id, so the optimistic bubble and the streamed reply had nothing linking them to the rows the
  gateway persisted; the next `sessions.changed` sweep read the tail, found two rows it had never
  seen, and appended them. The tail reconcile now pairs a fresh row against a live item of the same
  kind and text, the way a full re-hydration already did.
- The transcript told the screen it had scrolled away from the bottom from inside a state updater,
  which React runs during another component's render. That is a "cannot update a component while
  rendering a different component" error and an update that can be dropped; it is an effect now.
- The Activity timeline's `↩` rendered as an emoji on iOS, which is what U+21A9 means without an
  explicit text variation selector.


### Removed

- **The native macOS target.** `apps/hermie/macos/` and its hand-maintained Xcode project, Podfile and
  application delegate; the `react-native-macos` dependency; the `macos` Metro platform and the
  `react-native` → `react-native-macos` import rewrite; `react-native.config.js`; every
  `*.macos.ts(x)` variant in `src/`; `docs/macos-smoke.md`; the macOS asset catalogue; the macOS CI
  job; and the macOS build, Developer ID signing and notarisation steps in the release workflow, with
  the four secrets that fed them. Git history keeps all of it, and
  [ADR-0002](docs/adr/0002-macos-via-react-native-macos.md) keeps the reasoning.
- `expo-document-picker`, which existed only for the macOS attachment picker.

### Internal

- `src/ui/tokens.ts` keeps the older colour roles (`bg`, `surface`, `surfaceRaised`, `bubbleBlue`,
  `success`, `switchGreen`, `border`, `incoming`, `incomingText`, `danger` as a text colour) and the
  older type names (`display`, `title`, `heading`, `callout`, `caption`, `mono`) as **aliases** onto
  their Liquid Glass equivalents, so that the transcript, the bubbles, the composer and the sheets
  keep rendering untouched while part 2 restyles them. They are meant to go with that pass.
- `expo-glass-effect`, `expo-blur` and `expo-linear-gradient` are new dependencies. `npx expo-doctor`
  stays at 18/18.

[Unreleased]: https://github.com/fullstackstudio-nl/hermie/compare/main...HEAD
