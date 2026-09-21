# 0016. Per-client settings live in `ui_meta`, one section per concern, last writer wins

- Status: Accepted
- Date: 2026-09-21
- Amends: [0012](0012-local-chat-list-layout.md)

## Context

ADR-0012 put the chat list's arrangement — order, dividers, archived, per-chat colour — in the
device's own key-value store, and ended on a condition: _"If the gateway ever grows a per-client
metadata scope, this is the one module to change."_

It has one. A profile row carries `ui_meta` (a free-form object) and `ui_meta_revisions`
(`Record<string, number>`), and `profiles.configure` takes `ui_meta` together with
`ui_meta_expected_revisions` and answers with `applied.ui_meta_revisions` and
`applied.ui_meta_conflicts`. Upstream's own docstring, which
`packages/hermes-shared/src/gateway-contract.generated.ts` carries verbatim, says what that
machinery is:

> Sections are independent; `ui_meta_expected_revisions` is a per-key compare-and-swap.

So the unit is the **top-level key**. Each key has its own revision counter; a write names the keys
it is changing and leaves every other key alone; a key whose expected revision disagrees with the
stored one is refused on its own while the rest of the same request still applies.

That matters more than it looks. `ui_meta` is not ours: the marker `ui_meta: {"hermes-bots": {}}` is
what makes a profile show up as a bot at all (see docs/GLOSSARY.md), and it is written by another
tool. A client that stored its settings by replacing the bag would un-bot every profile it touched.
Per-key writes are what make the scope safe to use, not merely convenient.

`ui_meta` is also **per profile**, and Hermie has two kinds of setting:

- ones that are about one bot — archived, colour — which have an obvious home on that bot's profile;
- ones that are about the whole app — chat order, dividers, themes, the verbosity and bot-to-bot
  defaults — which are about no single bot.

The second kind needs somewhere app-wide, and the gateway offers no scope that is not a profile.
The default profile (`is_default` on the roster row, the profile `hermes serve` runs as) is the one
row every client can find without being told which bot to ask.

There is also the question ADR-0012 answered the other way, and it has not gone away: two people can
use the same gateway, and one of them grouping four bots under "Finance" is a statement about how
**they** work. The gateway has no per-user scope inside a profile either. What has changed is the
trade: ADR-0008's trap was a setting on a phone silently changing what a colleague's **desktop**
shows, and that trap was about `config.set` — the global configuration file that Hermes Desktop, the
TUI and the messaging platforms all read and act on. `ui_meta` under our own key is read by nothing
but Hermie.

## Decision

Hermie's settings are stored in `ui_meta` under keys it owns, and are **never** written anywhere
else on a profile.

**Two keys, both versioned.**

- `hermie` — on **that bot's** profile. Everything that is about one conversation: `archived`,
  `colour`.
- `hermie-app` — on the **default** profile. Everything that is about the window: chat order, the
  named dividers, the theme (the preset choice and any user themes), and the `showBotToBot` /
  verbosity defaults.

Each carries a schema version of its own, because they will not move together:

```json
{ "v": 1, "archived": true, "colour": "teal" }
```

A reader that meets a `v` it does not know ignores that section and keeps its local copy, rather
than guessing at a shape. A writer never lowers `v`.

**Last writer wins, per section, guarded by the revision.** Every write sends the revision the
client last read for that key. The gateway refuses a stale one and says what it found; the client
takes the newer value, re-applies its own change on top and writes again. There is no merge of two
divergent arrangements: an order is a list, and a list merged with another list is neither of them.

**Local cache first.** The device's store stays the thing the UI reads, so the app paints before the
socket has answered and works with no gateway at all. Reconciliation runs on connect and on
`sessions.changed` / profile-change events. A write goes to the local store first and to the gateway
after; a write the gateway refuses or never receives stays local and is retried on the next
reconcile.

**The local-only fallback stays.** A gateway too old to carry `ui_meta`, or one that refuses the
write, leaves Hermie exactly where ADR-0012 left it: keyed by gateway address, on the device. That
is not a degraded mode to be apologised for — it is the behaviour ADR-0012 chose, still correct.

## Consequences

- The arrangement follows a person to a second device, which is the whole point, and is no longer
  lost with the app's data.
- Two people on one gateway now share an arrangement. That is a real regression against ADR-0012's
  reasoning and it is accepted knowingly: the gateway has no per-user scope, and the alternative is
  that nobody's arrangement follows them anywhere. If the gateway grows one, this is the ADR to
  supersede.
- Every write is a round trip that can be refused, so every writer has to be able to handle the
  refusal. That is the cost of the compare-and-swap and the reason the revision is stored beside the
  value rather than being derived.
- A bot's section lives on that bot's profile, so deleting a profile takes its colour and its
  archived flag with it. That is the right lifetime.
- `hermie-app` on the default profile means a gateway whose default profile a client cannot read has
  no app-wide settings. It falls back to local, which is the same path a refused write takes.

## What is verified, and what is not

`packages/fake-gateway/src/ui-meta.test.ts` pins the semantics above against the fake gateway: the
round trip, that a write leaves `hermes-bots` alone, that a named key is replaced whole, that
revisions count per key from zero, that a stale expected revision is refused with
`{ expected, actual }` while the other sections of the same request still apply, that a blind write
with no expected revision is accepted, and that a key written as `null` is removed.
`packages/gateway-client/src/ui-meta.test.ts` drives the CLIENT over a real socket against that
fake: the round trip between two devices, the conflict retried, an offline write synced when a
gateway appears, and the marker untouched.

### The probe, and what it settled (2026-09-21)

Run against `hermes serve` **0.21.3** (`upstream b25ce157`) on the reviewer gateway, on the `guide`
profile, which already carried `ui_meta: {"hermes-bots": {}}`:

```
before  ui_meta keys : ['hermes-bots']        revisions: {}
write   applied      : {"ui_meta":true,"ui_meta_revisions":{"hermie":1}}
after   ui_meta keys : ['hermes-bots','hermie']
MARKER SURVIVED      : true
REVISION MOVED       : true (0 -> 1)
stale   applied      : {"ui_meta":false,"ui_meta_conflicts":{"hermie":{"expected":0,"actual":1}},
                        "ui_meta_revisions":{"hermie":1}}
cleanup applied      : {"ui_meta":true,"ui_meta_revisions":{"hermie":2}}
final   ui_meta      : {"hermes-bots":{}}
```

Every claim in this record held. The marker survived a write of a neighbouring key; the revision
moved by exactly one; a stale expected revision was refused with the `{ expected, actual }` shape the
fake reproduces, and refused means refused — the loser's value was not on the profile. The same probe
on the **default** profile (`default`, `is_default: true`, which carries no `hermes-bots` marker
because it is not a bot) wrote and removed `hermie-app` and left `guide` and `notes` untouched, which
is the other half of the decision above.

**One thing the fake had wrong, and it is the reason the probe was worth running.** A key written as
`null` is REMOVED by the real gateway; the fake stored the null. So the fake was the more forgiving
of the two, and a client that drops a section by writing null — which is this client — would have
left a dead key on a real profile while every test stayed green. The fake deletes it now.

**Not the protocol, but worth writing down.** Upstream answers the WebSocket upgrade **without**
echoing `Sec-WebSocket-Protocol`, at the origin as well as through the proxy, while the fake gateway
echoes `hermes-gateway-v1`. RFC 6455 permits the omission and a browser accepts it, but Node's `ws`
refuses a 101 with no subprotocol when it asked for one. Nothing in Hermie is known to be affected —
the app's own dial has always worked against real gateways — but the fake is stricter than the thing
it stands in for here, and that asymmetry is the kind that hides a client bug rather than a server
one.

The gateway was left as it was found: both keys removed, both bags back to their original contents.
Only the revision counters moved, which they cannot be asked not to.
