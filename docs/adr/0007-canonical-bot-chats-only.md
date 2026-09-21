# 0007. Only canonical Bot Chats

- Status: Accepted
- Date: 2026-09-19

## Context

A Hermes gateway stores every session that was ever started from the CLI, the desktop app, cron
jobs and messaging platforms. Hermes Desktop offers all of them in a sidebar, plus a "Bot Mode"
where each profile (bot) has one persistent conversation, the session titled exactly `Bot Chat`.
That title is the only identity of the canonical chat; the gateway reports it as
`canonical_session` on `profiles.list` and creates it hidden when it is missing.

Hermie's purpose is chatting with bots, not administering sessions.

## Decision

Hermie shows **one conversation per bot: the canonical Bot Chat**. There is no session browser, no
side chats and no session creation from the app. When a profile has no canonical session yet, Hermie
looks it up by title (`session.list` with `title: 'Bot Chat'` and `include_hidden: true`) and only
then creates it, exactly as Hermes Desktop does, so a chat is never forked by accident.

Cron runs are the one exception: a routine's run history opens its run sessions read-only.

## Consequences

- The home screen is a list of bots, which maps directly onto a messaging-app conversations list.
- Everything the app persists is keyed by the profile name and the durable session id, never by the
  runtime session id.
- The same chat is shared with Hermes Desktop and the CLI when they point at the same gateway.

## Amendment (2026-09-22): branches and past conversations, beside the canonical chat

Round R4b added three things that all touch this decision, so it is worth saying precisely which
part of it moved and which part did not.

**What has not moved: a bot is still reached by exactly one chat.** The canonical `Bot Chat` is
still the hidden session resolved by title, still the only one the roster points at, still the only
one with a composer, and still the only one a notification, a widget, a deep link or a DM card can
land in. Nothing in this round creates a second place to talk to a bot.

**What has moved: the app now admits that the one chat has neighbours, and shows them.** It always
did — `/new` has been retiring conversations under `Bot Chat · <date time>` since it was written,
and those rows were simply invisible to this app. Now:

- **`session.branch`** forks the canonical chat at one message into an ordinary VISIBLE session of
  the same profile, titled `Branch · <first words>`. It is not canonical, it is not hidden, and the
  canonical chat is untouched by construction rather than by care.
- **A Conversations page** lists the profile's sessions from `session.list` (with `include_hidden`,
  because the canonical one is hidden by definition), grouped into the current Bot Chat, the
  branches and the past conversations.
- **A non-canonical session can be opened read-only**, under a banner naming it and offering the way
  back. There is no composer on it, and that is this ADR's decision still being enforced: a second
  composer is exactly how an app grows a second chat per bot. To carry on inside a branch, the
  reader makes it the Bot Chat — a swap, which keeps the invariant rather than suspending it.

**The one-canonical rule is now a TYPE rather than a check.** `features/sessions/session-model.ts`
gives every listed conversation a `kind`, and `conversationActions` answers an EMPTY action list for
the canonical row. Delete, Rename and "Make this the Bot Chat" are unreachable for it because there
is no branch of code in which they are offered, not because each surface remembers to ask. The
controller's `deleteConversation` deliberately does NOT repeat the check, so that nobody reads the
surfaces as being allowed to be careless.

**Where the grouping comes from, and its known limit.** `SessionListRow` carries no parent and no
kind — `session.create` takes a `parent_session_id` and upstream keeps it, but the listing never
reads it back — so the groups are derived from the TITLE prefixes this app itself writes. A
conversation renamed out of its prefix stops being grouped as a branch and becomes an ordinary past
conversation. It is still listed, still openable, still named what the reader called it. The
alternative was a parentage table in `ui_meta` that would go stale against any other client on the
same gateway; a grouping that can be wrong in a way the reader can see and fix beats a shadow index
that is wrong silently.

### What is verified

`apps/hermie/__tests__/session-branch.test.ts`: the branch title, that branching leaves the
canonical chat's session, rows and flags alone, that a branch opens under a key of its own without
clearing the bot's unread watermark, and that the canonical row is offered no actions while every
other row is offered four. `apps/hermie/__tests__/conversations-page.test.ts`: which id each of
`session.title`, `session.delete` and `session.resume` is addressed by, and both rollback paths of
the canonical swap. `packages/fake-gateway/src/upstream-shapes.test.ts` holds the fake's
`session.branch` and `session.delete` to the contract — including that the fake invents no canonical
guard upstream does not document, because the guard is this app's.

**Not verified:** anything against a real gateway. See the round's section in
`docs/platform-notes.md`, in particular the reading of `session.branch`'s `count`.
