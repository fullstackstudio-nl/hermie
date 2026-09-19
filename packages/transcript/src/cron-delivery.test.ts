import { describe, expect, it } from 'vitest'

import { isCronDelivery, parseCronDelivery } from './cron-delivery'
import { cronBotChatBody, cronBotChatHeader, cronBotChatText, cronMirrorText } from './__fixtures__/rows'

describe('the two header shapes', () => {
  it('reads the bot-chat delivery header', () => {
    expect(parseCronDelivery(cronBotChatText)).toEqual({
      jobName: 'Inbox scan',
      body: cronBotChatBody,
      shape: 'bot_chat',
      nameRedacted: false
    })
  })

  it('reads the platform-mirror header, which has no instruction sentence', () => {
    expect(parseCronDelivery(cronMirrorText)).toEqual({
      jobName: 'Morning Brief',
      body: 'Two deploys overnight, both green.',
      shape: 'mirror',
      nameRedacted: false
    })
  })

  it('keeps the two apart rather than collapsing them into one kind of card', () => {
    expect(parseCronDelivery(cronBotChatText)?.shape).toBe('bot_chat')
    expect(parseCronDelivery(cronMirrorText)?.shape).toBe('mirror')
  })
})

describe('names the redactor and the config can produce', () => {
  it('flags the redactor placeholder instead of titling a card with it', () => {
    const parsed = parseCronDelivery(`${cronBotChatHeader('[REDACTED - redaction failed]')}\n\nnothing to see`)

    expect(parsed).toMatchObject({ jobName: '[REDACTED - redaction failed]', nameRedacted: true })
  })

  it('survives a name holding quotes', () => {
    const parsed = parseCronDelivery(`${cronBotChatHeader('He said "ship it"')}\n\nshipped`)

    expect(parsed?.jobName).toBe('He said "ship it"')
    expect(parsed?.body).toBe('shipped')
  })

  it('survives a name holding a closing bracket, in both shapes', () => {
    expect(parseCronDelivery(`${cronBotChatHeader('Nightly [beta]')}\n\nall green`)?.jobName).toBe('Nightly [beta]')
    expect(parseCronDelivery('[Cron delivery: Nightly [beta]]\nall green')?.jobName).toBe('Nightly [beta]')
  })

  it('labels a nameless header rather than drawing a card with no title', () => {
    expect(parseCronDelivery(`${cronBotChatHeader('')}\n\nbody`)?.jobName).toBe('unknown job')
  })
})

describe('bodies the wire really sends', () => {
  it('reports an empty body when the header arrived without one', () => {
    // The f-string writes the blank line whether or not there is content after it.
    expect(parseCronDelivery(`${cronBotChatHeader('Inbox scan')}\n\n`)?.body).toBe('')
    expect(parseCronDelivery(cronBotChatHeader('Inbox scan'))?.body).toBe('')
    expect(parseCronDelivery('[Cron delivery: Morning Brief]')?.body).toBe('')
    expect(parseCronDelivery('[Cron delivery: Morning Brief]\n')?.body).toBe('')
  })

  it('handles CRLF line endings in both shapes', () => {
    expect(parseCronDelivery(`${cronBotChatHeader('Inbox scan')}\r\n\r\n# Report\r\n\r\nline`)).toMatchObject({
      jobName: 'Inbox scan',
      body: '# Report\r\n\r\nline',
      shape: 'bot_chat'
    })
    expect(parseCronDelivery('[Cron delivery: Morning Brief]\r\nboth green')?.body).toBe('both green')
  })

  it('tolerates leading whitespace, which a transport may add', () => {
    expect(parseCronDelivery(`  \n${cronBotChatText}`)?.jobName).toBe('Inbox scan')
  })

  it('keeps a body that is itself an inbound DM as the cron report', () => {
    // The header is the outer envelope; whatever the job printed is its content,
    // even when the job printed something that looks like another convention.
    const parsed = parseCronDelivery(
      `${cronBotChatHeader('Digest')}\n\nMessage from 🤖 Writer (@writer): the draft is ready.`
    )

    expect(parsed?.shape).toBe('bot_chat')
    expect(parsed?.body).toBe('Message from 🤖 Writer (@writer): the draft is ready.')
  })
})

describe('the conservative negatives', () => {
  it('ignores a header quoted mid-prose', () => {
    expect(parseCronDelivery(`I was told: ${cronBotChatText}`)).toBeNull()
    expect(parseCronDelivery(`As in "${cronMirrorText}", which is the shape.`)).toBeNull()
  })

  it('ignores a header-like line inside a fenced code block', () => {
    expect(parseCronDelivery(['```', cronBotChatHeader('Inbox scan'), '```'].join('\n'))).toBeNull()
    expect(parseCronDelivery(['```text', '[Cron delivery: Morning Brief]', 'body', '```'].join('\n'))).toBeNull()
  })

  it('ignores a message that merely starts with a bracket', () => {
    expect(parseCronDelivery('[note] remember to bump the version')).toBeNull()
    expect(parseCronDelivery('[Cronjob] did it run?')).toBeNull()
    expect(parseCronDelivery('[Cron delivery] did it run?')).toBeNull()
  })

  it('refuses a bot-chat header whose instruction sentence was reworded', () => {
    // The sentence is fixed text upstream, so a reworded one is a different
    // gateway, not a delivery this heuristic may claim to understand.
    expect(parseCronDelivery('[Cronjob "Inbox scan" output — scheduled job.]\n\nbody')).toBeNull()
  })

  it('refuses a header that is not alone on its line', () => {
    expect(parseCronDelivery('[Cron delivery: Morning Brief] and also this')).toBeNull()
    expect(parseCronDelivery(`${cronBotChatHeader('Inbox scan')} plus a remark\n\nbody`)).toBeNull()
  })

  it('is total: any string is a legal argument', () => {
    expect(parseCronDelivery('')).toBeNull()
    expect(parseCronDelivery(undefined)).toBeNull()
    expect(parseCronDelivery(null)).toBeNull()
    expect(parseCronDelivery(42)).toBeNull()
  })
})

describe('isCronDelivery', () => {
  it('answers the same question as the parser', () => {
    expect(isCronDelivery(cronBotChatText)).toBe(true)
    expect(isCronDelivery(cronMirrorText)).toBe(true)
    expect(isCronDelivery('just a question')).toBe(false)
  })
})
