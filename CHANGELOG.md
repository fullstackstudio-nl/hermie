# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project skeleton: npm workspaces, TypeScript project references, ESLint, Prettier, commit-message
  rules and a CI check job.
- `apps/hermie`, an Expo SDK 54 app targeting iOS, iPadOS, Android and macOS, with the compact and
  regular shells, design tokens, theming and the platform storage abstractions.
- A hand-maintained macOS project built on react-native-macos, with Expo modules linked through
  CocoaPods.
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
- A bots screen and a chat screen wired into both shells, with the bot list as the sidebar on iPad
  and macOS.
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
- Attachments: the photo library on iOS and Android, the file picker on macOS, resized to 1568 px on
  the longest edge before they are encoded — a camera-roll photo is several megabytes and
  `image.attach_bytes` shares the socket the transcript streams on.
- A Chat section in Settings for the default verbosity, bot-to-bot and thinking, and an Appearance
  section that pins the app to light or dark instead of following the system.

### Fixed

- A reply that arrived after a tool call was painted twice — once as the partially streamed copy and
  once as the clean final — while the gateway had stored a single row. The tool boundary seals the
  streaming bubble, so the completion had nowhere to land; it now settles onto that sealed bubble
  whenever the two texts are prefix-compatible, which only the same message can be. Upstream carries
  the same fix.
- The approval sheet labelled its buttons from a vocabulary the gateway never sends. Hermes answers
  with `once`, `session`, `always` and `deny`, so every approval showed raw protocol words instead of
  "Allow once" and "Always allow".
- `secureTextEntry` on macOS: the field renders dots but never reports what was typed, which left the
  session token empty and onboarding impossible to finish. Masking is off on macOS, and every secret
  field now offers to show its value.
- `expo-image-picker` needs an explicit photo-library usage string; without one iOS terminates the
  app the moment the permission is requested, with no dialog and no crash report.

[Unreleased]: https://github.com/fullstackstudio/hermie/compare/main...HEAD
