/**
 * Reading the row that started a turn, and turning it into a line on a lock
 * screen.
 *
 * The header parsers are heuristics — Hermes has no wire marker for a cron
 * delivery or a DM — so the cases that matter are the ones that must NOT match:
 * a bot quoting a header in prose, and a header that is not on its own line.
 */
import { describe, expect, it } from 'vitest'

import { classifyInbound, lastInboundRow } from './inbound'
import { APPROVAL_CATEGORY, pushMessageFor, trimPreview, typeForInbound } from './payload'

const BOT_CHAT =
  '[Cronjob "Morning digest" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]'

describe('classifying an inbound row', () => {
  it('reads both cron headers the scheduler writes', () => {
    expect(classifyInbound(`${BOT_CHAT}\n\nAll clear.`)).toEqual({
      kind: 'cron',
      name: 'Morning digest',
      body: 'All clear.'
    })
    expect(classifyInbound('[Cron delivery: Nightly backup]\nDone.')).toEqual({
      kind: 'cron',
      name: 'Nightly backup',
      body: 'Done.'
    })
  })

  it('does not read a bot quoting a header as a cron delivery', () => {
    expect(classifyInbound(`I found this: ${BOT_CHAT}`).kind).toBe('message')
  })

  it('says nothing for a job name the gateway’s redactor replaced wholesale', () => {
    expect(classifyInbound('[Cron delivery: [REDACTED - redaction failed]]\nx').name).toBe('')
  })

  it('reads a bot-to-bot delivery and names the sender', () => {
    expect(classifyInbound('Message from 🤖 Writer (@writer): can you check this')).toEqual({
      kind: 'dm',
      name: 'Writer',
      body: 'can you check this'
    })
    expect(classifyInbound("[Message from agent 'Scribe'] here it is").name).toBe('Scribe')
  })

  it('treats anything it does not recognise as the owner typing', () => {
    // A header this build has not heard of produces an ordinary message
    // notification rather than none at all.
    expect(classifyInbound('what is the weather').kind).toBe('message')
    expect(classifyInbound(undefined).kind).toBe('message')
    expect(classifyInbound('').kind).toBe('message')
  })

  it('takes the LAST inbound row, because a chat is append-only', () => {
    expect(
      lastInboundRow([
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'answer' },
        { role: 'user', text: '[Cron delivery: Nightly]\nok' },
        { role: 'assistant', text: 'summary' }
      ])
    ).toMatchObject({ kind: 'cron', name: 'Nightly' })
  })

  it('falls back to `content` when a row spells its text that way', () => {
    expect(lastInboundRow([{ role: 'user', content: 'Message from 🤖 Writer: hi' }]).kind).toBe('dm')
  })
})

describe('the notification', () => {
  const base = { bot: 'researcher', botLabel: 'Researcher', sessionId: 'live-r' }

  it('says who and not what, unless the device asked', () => {
    const quiet = pushMessageFor({ ...base, type: 'message', preview: 'the secret plan' }, false)

    expect(quiet.title).toBe('Researcher')
    expect(quiet.body).toBe('sent you a message')
    expect(JSON.stringify(quiet)).not.toContain('secret')
    expect(pushMessageFor({ ...base, type: 'message', preview: 'the secret plan' }, true).body).toBe('the secret plan')
  })

  it('gives an approval its actions category and its request id', () => {
    const message = pushMessageFor({ ...base, type: 'request', requestMethod: 'approval', requestId: 'srq-1' }, false)

    expect(message.categoryId).toBe(APPROVAL_CATEGORY)
    expect(message.data.request).toBe('srq-1')
  })

  it('does not give a clarify the Allow / Deny actions', () => {
    expect(pushMessageFor({ ...base, type: 'request', requestMethod: 'clarify' }, false).categoryId).toBeUndefined()
    expect(pushMessageFor({ ...base, type: 'request', requestMethod: 'clarify' }, false).body).toBe(
      'has a question for you'
    )
  })

  it('falls back to the bot’s own name when the roster offers no label', () => {
    expect(pushMessageFor({ bot: 'researcher', sessionId: 'x', type: 'message' }, false).title).toBe('researcher')
  })

  it('keeps a preview to one short line', () => {
    expect(trimPreview('a\n\n   b   c')).toBe('a b c')
    expect(trimPreview('x'.repeat(400)).length).toBeLessThanOrEqual(120)
  })

  it('maps an inbound kind onto the type a registration switches on', () => {
    expect(typeForInbound('cron')).toBe('cron')
    expect(typeForInbound('dm')).toBe('dm')
    expect(typeForInbound('message')).toBe('message')
  })
})
