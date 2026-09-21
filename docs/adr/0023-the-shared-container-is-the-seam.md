# 0023. The shared container is the seam for every system surface

- Status: Accepted
- Date: 2026-09-22

## Context

Three features landed together and they look unrelated: sharing into Hermie from another app,
running a bot from Shortcuts or Siri, and pinning a widget to one folder of the chat list. They
turned out to be one problem with one answer, and the answer is worth recording because the next
system surface — a Live Activity, a watch complication, an Android App Action — will arrive with
exactly the same shape.

**Everything the system can put on a person's screen runs outside the app, and the gateway runs
inside it.** A share extension is a separate process with its own sandbox and a few seconds to
live. A widget extension is killed for memory before it is killed for anything else. An App Intent
is invoked by Shortcuts while the app may not be running at all. None of them can open a WebSocket
to somebody's `hermes serve`, hold a credential from the keychain, or resume a session — the socket
is built in JavaScript by `GatewayProvider`, it exists only while the app is alive and signed in,
and there is no second one.

ADR-0006 already says why: one gateway per install, no relay, nothing in the middle. That was a
decision about servers, and it has a consequence nobody had written down about processes.

The options for each of the three, as they came up:

1. **Give the extension its own connection.** A share extension could in principle dial the gateway
   itself. It would need the credential, which means the keychain access group, a second copy of the
   dial ladder, the PKCE refresh, and a second thing that can be signed out. For a process that
   lives three seconds and has to show a list of bots before it can do anything.
2. **Hand over through the deep link.** `hermie://share?text=…&bot=…` is one line of code. It is
   also a URL scheme, which is registered with the system: any app on the device and any web page a
   reader taps can send one. A link that carries CONTENT is a link that can put words in somebody's
   chat.
3. **Write a file both sandboxes can read.**

## Decision

**Every system surface communicates with the app through a versioned file in the App Group
container, and never through a connection of its own or through a payload in a URL.**

Three directions through one container (`group.dev.hermie.app`):

| Direction | File                                                     | Written by                               | Read by                                        |
| --------- | -------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| out       | `widget-snapshot.json`                                   | the app                                  | widget extension, share extension, App Intents |
| in        | `share-outbox/<id>/manifest.json`                        | share extension, Android's `ACTION_SEND` | the app                                        |
| both      | `intents/pending/<id>.json`, `intents/results/<id>.json` | App Intent, then the app                 | the app, then the App Intent                   |

Four rules make that work, and all four are already written into the code that implements them.

- **The format is the contract, it is versioned, and the version is checked on the way in.** There
  is no shared Swift, no shared Kotlin and no generated type. `src/features/widgets/snapshot.ts`,
  `src/features/share/outbox.ts` and `src/features/intents/queue.ts` are pure TypeScript with tests,
  and every native reader or writer spells the same field names by hand. A snapshot whose version is
  unknown draws the empty state; a manifest whose version is unknown is cleared.
- **A link names a thing and carries nothing.** `hermie://chat/<bot>`, `hermie://share/<id>`,
  `hermie://intent/<id>`, `hermie://folder/<id>`. Every one of them names something that already
  exists and was put there by this app, and the id is checked against an alphabet this app mints
  from. The content is in the container, which only these binaries can read.
- **Which side keeps the data depends on who is waiting.** A share is KEPT until it has been
  delivered, because nobody is waiting and tomorrow will do; the entry is cleared only after the
  message has actually gone, so the gap fails towards "sent twice, visibly". A Shortcut is ALWAYS
  answered, including when it fails, because somebody is watching a spinner and a refusal written
  immediately beats a retry that might work.
- **The app decides everything, the extension decides nothing.** The native side copies bytes,
  draws them, or hands them over. Presence, unread, colours, which name leads, what a folder's badge
  counts — all of it is derived in the projection while the app still has the state to derive it
  from.

## Consequences

- **Every system surface is one app launch out of date, at worst.** A phone whose Hermie has not run
  for a week shows a week-old widget, offers a week-old roster in the share sheet, and cannot resolve
  a bot added since in Siri. That is stated in each module rather than hidden. It is the correct
  trade for a client with no background delivery of its own: a surface that lied about being live
  would be worse than one that is honestly stale.
- **The App Group entitlement is now load-bearing for three features rather than one**, and it fails
  silently in every one of them — nothing refuses to build and nothing refuses to launch, the
  container is simply nil. Both config plugins assert it from the extension's side, both refuse to
  prebuild on a mismatch, and each native module exposes `hasSharedContainer()` so the developer
  screen can ask.
- **There is no Android half of the Shortcuts story.** `ACTION_SEND` gave Android the share feature
  with no extension at all, but App Actions and `ShortcutManager` are a different model and are not
  implemented — `platform/intent-queue` answers "unavailable" there rather than pretending.
- **Three copies of the snapshot decoder exist**, one per Apple target, because the three targets
  share no sources and a framework holding them in common is machinery this app does not otherwise
  need. Each is smaller than the last; what they share is the format, not the code.
- **A folder is now the only part of the owner's arrangement that reaches a home screen**, and its
  badge follows the CHAT LIST's rules rather than the widget's per-bot rules — so a folder holding
  one muted chat with four unread shows 4 while that chat's own row in the same widget shows
  nothing. That divergence is deliberate on each side and reconciled on neither.
  `docs/platform-notes.md` flags it as the owner's to settle.
- **If a future surface genuinely needs a live connection** — a Live Activity that updates while the
  app is closed is the obvious one — this record needs a successor rather than an edit, because the
  thing it would change is ADR-0006's "nothing in the middle".
