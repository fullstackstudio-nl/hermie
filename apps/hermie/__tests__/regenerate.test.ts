/**
 * Which road `Regenerate` takes, and the two cases where it takes neither.
 */
import type { TranscriptItem } from '@hermie/transcript'

import { regenerateLastTurn, type RegenerateSource } from '../src/features/chats/regenerate'

let seq = 0

const row = (item: Partial<TranscriptItem> & { kind: TranscriptItem['kind'] }) => ({
  item: { id: `i${(seq += 1)}`, origin: 'history', seq, version: 1, ...item } as TranscriptItem
})

const source = (over: Partial<RegenerateSource> = {}): RegenerateSource => ({
  items: [
    row({ kind: 'user', text: 'Introduce yourself.' } as never),
    row({ interim: false, kind: 'assistant', streaming: false, text: 'I am researcher.' } as never)
  ],
  knowsSlashCommand: () => false,
  runSlash: async () => undefined,
  send: async () => undefined,
  turnActive: false,
  ...over
})

describe('regenerating the last reply', () => {
  it('goes down the slash path when the catalogue has /retry', async () => {
    const runSlash = jest.fn(async () => undefined)
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(source({ knowsSlashCommand: name => name === 'retry', runSlash, send }))

    expect(outcome).toEqual({ kind: 'retried' })
    // The gateway's own command re-runs the turn on its side, so the
    // conversation gains a reply and not a second copy of the prompt.
    expect(runSlash).toHaveBeenCalledWith('/retry')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the previous prompt again on a gateway that has no /retry', async () => {
    const runSlash = jest.fn(async () => undefined)
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(source({ runSlash, send }))

    expect(outcome).toEqual({ kind: 'resent', text: 'Introduce yourself.' })
    expect(send).toHaveBeenCalledWith('Introduce yourself.')
    expect(runSlash).not.toHaveBeenCalled()
  })

  it('repeats the reader’s own turn, not whatever happens to be last', async () => {
    const send = jest.fn(async () => undefined)

    await regenerateLastTurn(
      source({
        items: [
          row({ kind: 'user', text: 'The real prompt.' } as never),
          row({ interim: false, kind: 'assistant', streaming: false, text: 'A reply.' } as never),
          // A scheduler and another bot both write rows on this side of the
          // conversation; neither is something the reader asked for.
          row({ body: 'Nightly report.', jobName: 'scan', kind: 'cron_delivery', shape: 'header' } as never),
          row({ kind: 'bot_dm_in', senderName: 'Writer', text: 'Anything else?' } as never)
        ],
        send
      })
    )

    expect(send).toHaveBeenCalledWith('The real prompt.')
  })

  it('refuses while a turn is running, before it asks the catalogue anything', async () => {
    const runSlash = jest.fn(async () => undefined)
    const send = jest.fn(async () => undefined)
    const knowsSlashCommand = jest.fn(() => true)

    expect(await regenerateLastTurn(source({ knowsSlashCommand, runSlash, send, turnActive: true }))).toEqual({
      kind: 'busy'
    })

    expect(runSlash).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(knowsSlashCommand).not.toHaveBeenCalled()
  })

  it('refuses when there is no prompt in the conversation to repeat', async () => {
    const send = jest.fn(async () => undefined)

    expect(
      await regenerateLastTurn(
        source({
          items: [row({ body: 'Nightly report.', jobName: 'scan', kind: 'cron_delivery', shape: 'header' } as never)],
          send
        })
      )
    ).toEqual({ kind: 'nothing' })

    expect(send).not.toHaveBeenCalled()
  })

  it('lets a gateway failure through rather than swallowing it as a refusal', async () => {
    await expect(
      regenerateLastTurn(
        source({
          knowsSlashCommand: () => true,
          runSlash: async () => {
            throw new Error('the worker died')
          }
        })
      )
    ).rejects.toThrow('the worker died')
  })
})
