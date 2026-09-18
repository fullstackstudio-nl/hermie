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
