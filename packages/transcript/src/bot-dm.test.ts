import { describe, expect, it } from 'vitest'

import {
  deliveryTargetFromCommand,
  dispatchedTo,
  isBotDmDeliveryCommand,
  normalizeAgentTarget,
  parseIncomingBotMessage,
  parseMessageAgentResult,
  parseProcessCompleteText,
  replyFromDeliveryOutput
} from './bot-dm'
import { DM_DELIVERY_COMMAND, dmReplyProcessText, LEGACY_DELIVERY_COMMAND, plainProcessText } from './__fixtures__/rows'
import type { BotDmInItem, BotDmOutItem, TranscriptItem, UserItem } from './types'

const base = { seq: 0, version: 0, origin: 'history' as const }

const dmOut = (id: string, targetHandle: string): BotDmOutItem => ({
  ...base,
  id,
  kind: 'bot_dm_out',
  toolId: id,
  target: `@${targetHandle}`,
  targetHandle,
  message: 'hi',
  dispatch: { status: 'queued' }
})

const dmIn = (id: string, senderName: string, senderHandle?: string): BotDmInItem => ({
  ...base,
  id,
  kind: 'bot_dm_in',
  senderName,
  ...(senderHandle ? { senderHandle } : {}),
  text: 'hello'
})

const user = (id: string): UserItem => ({ ...base, id, kind: 'user', text: 'human speaking' })

describe('parseIncomingBotMessage', () => {
  it('reads the name, handle and body of the current signature', () => {
    expect(parseIncomingBotMessage('Message from 🤖 Writer Bot (@writer): draft is ready')).toEqual({
      senderName: 'Writer Bot',
      senderHandle: 'writer',
      body: 'draft is ready'
    })
  })

  it('reads the signature without an emoji or a handle', () => {
    expect(parseIncomingBotMessage('Message from Researcher: found three sources')).toEqual({
      senderName: 'Researcher',
      body: 'found three sources'
    })
  })

  it('reads the legacy bracket form', () => {
    expect(parseIncomingBotMessage("[Message from agent 'scribe'] notes attached")).toEqual({
      senderName: 'scribe',
      body: 'notes attached'
    })
  })

  it('keeps a multi-line body intact', () => {
    expect(parseIncomingBotMessage('Message from 🤖 Writer (@writer): line one\nline two')?.body).toBe(
      'line one\nline two'
    )
  })

  it('ignores a human message that merely mentions the phrase', () => {
    expect(parseIncomingBotMessage('I got a message from the writer today')).toBeNull()
  })
})

describe('normalizeAgentTarget', () => {
  it.each([
    ['@writer', 'writer'],
    ['Writer', 'writer'],
    ['scribe@laptop', 'scribe'],
    ['peer/scribe', 'scribe'],
    ['@Dr. Foo', 'dr. foo'],
    ['', ''],
    [undefined, '']
  ])('%s → %s', (input, expected) => {
    expect(normalizeAgentTarget(input)).toBe(expected)
  })
})

describe('parseMessageAgentResult', () => {
  it('reads the fire-and-forget ack', () => {
    const result = JSON.stringify({
      status: 'queued',
      delivery_id: 'dm-1',
      to: '@writer',
      process_id: 'proc-1',
      detail: 'Message queued'
    })

    expect(parseMessageAgentResult(result)).toEqual({
      status: 'queued',
      deliveryId: 'dm-1',
      to: '@writer',
      processId: 'proc-1'
    })
  })

  it('reads an ack wrapped in a terminal-style envelope', () => {
    expect(parseMessageAgentResult({ output: '{"status":"claimed","delivery_id":"dm-2"}' })).toEqual({
      status: 'queued',
      deliveryId: 'dm-2'
    })
  })

  it('reads the ambiguous outcome', () => {
    const result = { status: 'ambiguous', delivery_id: 'dm-3', error: 'could not be confirmed' }

    expect(parseMessageAgentResult(result)).toEqual({
      status: 'ambiguous',
      deliveryId: 'dm-3',
      error: 'could not be confirmed'
    })
  })

  it('reads the error shape', () => {
    expect(parseMessageAgentResult({ error: "No teammate named 'nobody'.", reason: 'unknown_target' })).toEqual({
      status: 'failed',
      error: "No teammate named 'nobody'.",
      reason: 'unknown_target'
    })
  })

  it('does not invent a status for an unparseable result', () => {
    expect(parseMessageAgentResult('not json at all')).toEqual({ status: 'unknown', error: 'not json at all' })
  })
})

describe('parseProcessCompleteText', () => {
  it('reads one completion block', () => {
    expect(parseProcessCompleteText(dmReplyProcessText)).toEqual([
      {
        sid: 'proc-2f9c',
        command: DM_DELIVERY_COMMAND,
        output: 'Message from 🤖 Writer (@writer): Draft is ready, I pushed it to the shared folder.'
      }
    ])
  })

  it('reads a batch of blocks behind their header', () => {
    const batch = ['2 background processes completed.', dmReplyProcessText, plainProcessText].join('\n\n')
    const parsed = parseProcessCompleteText(batch)

    expect(parsed.map(block => block.sid)).toEqual(['proc-2f9c', 'proc-aa01'])
    expect(parsed[1]?.command).toBe('npm run build')
  })

  it('reads a watch-pattern match', () => {
    const watch = [
      '[IMPORTANT: Background process proc-w1 matched watch pattern "ERROR".',
      'Command: tail -f app.log',
      'Matched output:',
      'ERROR boom]'
    ].join('\n')

    expect(parseProcessCompleteText(watch)).toEqual([
      { sid: 'proc-w1', command: 'tail -f app.log', output: 'ERROR boom' }
    ])
  })

  it('returns nothing for prose', () => {
    expect(parseProcessCompleteText('the build finished')).toEqual([])
  })
})

describe('isBotDmDeliveryCommand', () => {
  it('matches the runner form', () => {
    expect(isBotDmDeliveryCommand(DM_DELIVERY_COMMAND)).toBe(true)
    expect(deliveryTargetFromCommand(DM_DELIVERY_COMMAND)).toBe('writer')
  })

  it('matches the legacy terminal form', () => {
    expect(isBotDmDeliveryCommand(LEGACY_DELIVERY_COMMAND)).toBe(true)
    expect(deliveryTargetFromCommand(LEGACY_DELIVERY_COMMAND)).toBe('writer')
  })

  it('does not match an ordinary command', () => {
    expect(isBotDmDeliveryCommand('npm run build')).toBe(false)
    expect(deliveryTargetFromCommand('npm run build')).toBeNull()
  })
})

describe('replyFromDeliveryOutput', () => {
  it('strips the echoed signature from plain output', () => {
    expect(replyFromDeliveryOutput('Message from 🤖 Writer (@writer): on it')).toEqual({ text: 'on it' })
  })

  it('drops session bookkeeping lines', () => {
    expect(replyFromDeliveryOutput('session_id: abc123\nthe answer')).toEqual({ text: 'the answer' })
  })

  it('reads the settled record', () => {
    expect(replyFromDeliveryOutput(JSON.stringify({ status: 'settled', delivery_id: 'dm-1', reply: 'sure' }))).toEqual({
      text: 'sure'
    })
  })

  it('reads the failure record', () => {
    expect(
      replyFromDeliveryOutput(JSON.stringify({ error: "@writer's Bot Chat is open elsewhere", reason: 'target_busy' }))
    ).toEqual({ error: "@writer's Bot Chat is open elsewhere", reason: 'target_busy' })
  })

  it('returns nothing for empty output', () => {
    expect(replyFromDeliveryOutput('   ')).toEqual({})
  })
})

describe('dispatchedTo', () => {
  it('is true when we messaged that teammate in this exchange', () => {
    const earlier: TranscriptItem[] = [user('u1'), dmOut('d1', 'writer')]

    expect(dispatchedTo(earlier, ['Writer', 'writer'])).toBe(true)
  })

  it('stops at the human turn, so an older dispatch does not count', () => {
    const earlier: TranscriptItem[] = [dmOut('d1', 'writer'), user('u1')]

    expect(dispatchedTo(earlier, ['writer'])).toBe(false)
  })

  it('stops at an earlier inbound row from the same sender', () => {
    const earlier: TranscriptItem[] = [dmOut('d1', 'writer'), dmIn('i1', 'Writer', 'writer')]

    expect(dispatchedTo(earlier, ['writer'])).toBe(false)
  })

  it('walks past an inbound row from a different sender', () => {
    const earlier: TranscriptItem[] = [dmOut('d1', 'writer'), dmIn('i1', 'Scribe', 'scribe')]

    expect(dispatchedTo(earlier, ['writer'])).toBe(true)
  })

  it('needs a sender to match on', () => {
    expect(dispatchedTo([dmOut('d1', 'writer')], [undefined, ''])).toBe(false)
  })
})
