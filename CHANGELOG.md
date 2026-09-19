# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


### Added

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
