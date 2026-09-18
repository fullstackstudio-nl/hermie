import { describe, expect, it } from 'vitest'

import { rowsToItems, stripUserText, type TranscriptRow } from './rows-to-items'
import {
  attachedContextRow,
  codexSidecarRow,
  dmReplyProcessText,
  plainProcessText,
  restHistoryRows,
  rpcHistoryRows
} from './__fixtures__/rows'
import type { AssistantItem, BotDmInItem, BotDmOutItem, NoticeItem, SubagentGroupItem, ToolItem } from './types'

const kinds = (rows: TranscriptRow[]) => rowsToItems(rows, 'rpc').map(item => item.kind)

describe('rowsToItems (rpc history)', () => {
  const items = rowsToItems(rpcHistoryRows, 'rpc')

  it('projects every row it should keep and drops the hidden one', () => {
    expect(items.map(item => item.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'notice',
      'notice',
      'notice',
      'user',
      'user',
      'notice',
      'notice',
      'bot_dm_out',
      'subagent_group',
      'notice',
      'bot_dm_in',
      'assistant'
    ])
  })

  it('numbers items with a stable gap so live items fit between', () => {
    expect(items.map(item => item.seq)).toEqual(items.map((_item, index) => index * 1000))
  })

  it('names persisted rows after their durable row id', () => {
    expect(items[0]?.id).toBe('r:1')
    expect(items[0]?.rowId).toBe(1)
  })

  it('names tool rows after their tool id', () => {
    const tool = items.find(item => item.kind === 'tool') as ToolItem

    expect(tool.id).toBe('t:row-2')
    expect(tool.name).toBe('read_file')
  })

  it('keeps assistant reasoning from history', () => {
    const assistant = items[1] as AssistantItem

    expect(assistant.reasoning).toBe('The user wants a summary; read the file first.')
    expect(assistant.streaming).toBe(false)
    expect(assistant.status).toBe('complete')
  })

  it('leaves a history tool row honest about not knowing its result', () => {
    const tool = items.find(item => item.kind === 'tool') as ToolItem

    expect(tool.resultKnown).toBe(false)
    expect(tool.status).toBe('complete')
    expect(tool.summary).toBe('read_file(CHANGELOG.md)')
  })

  it.each([
    ['model_switch', 4],
    ['personality_switch', 5],
    ['auto_continue', 6]
  ])('turns %s into a notice', (kind, index) => {
    const notice = items[index] as NoticeItem

    expect(notice.kind).toBe('notice')
    expect(notice.noticeKind).toBe(kind)
  })

  it('keeps skill invocations and steers as user turns', () => {
    expect(items[7]).toMatchObject({ kind: 'user', text: '/release-notes', displayKind: 'skill_invocation' })
    expect(items[8]).toMatchObject({ kind: 'user', text: 'actually make it shorter', displayKind: 'steer' })
  })

  it('labels an unknown display kind rather than guessing', () => {
    expect(items[10]).toMatchObject({ kind: 'notice', noticeKind: 'unknown_display_kind', title: 'brand_new_kind' })
  })

  it('joins a process_complete delivery back onto the dispatch that sent it', () => {
    const dispatch = items.find(item => item.kind === 'bot_dm_out') as BotDmOutItem

    expect(dispatch.targetHandle).toBe('writer')
    expect(dispatch.message).toBe('Can you draft the announcement?')
    expect(dispatch.reply?.text).toBe('Draft is ready, I pushed it to the shared folder.')
    expect(dispatch.reply?.rowId).toBe(12)
    // The joined block is consumed, so it never also shows up as a notice.
    expect(items.filter(item => item.kind === 'notice' && item.noticeKind === 'process_complete')).toHaveLength(0)
  })

  it('closes the delegation group on the async completion row', () => {
    const group = items.find(item => item.kind === 'subagent_group') as SubagentGroupItem

    expect(group.goals).toEqual(['Audit deps', 'Write tests', 'Update docs'])
    expect(group.status).toBe('done')
    expect(group.completion).toContain('TASK 1/3')
  })

  it('reads an inbound DM as its own kind and attributes the reply after it', () => {
    const inbound = items.find(item => item.kind === 'bot_dm_in') as BotDmInItem

    expect(inbound.senderName).toBe('Writer')
    expect(inbound.senderHandle).toBe('writer')
    expect(inbound.text).toBe('The announcement draft is in docs/announce.md.')
    // We dispatched to @writer earlier in this exchange, so the reply answers us
    // and the next assistant turn addresses the human again.
    expect(inbound.answersOurDispatch).toBe(true)
    expect((items.at(-1) as AssistantItem).replyToBotHandle).toBeUndefined()
  })
})

describe('rowsToItems (rest history)', () => {
  const items = rowsToItems(restHistoryRows, 'rest')

  it('accepts content / display_content and a numeric id', () => {
    expect(items[0]).toMatchObject({ kind: 'user', id: 'r:1', rowId: 1, text: 'Summarise the release notes.' })
    expect((items[1] as AssistantItem).reasoning).toBe('Read the file first.')
  })

  it('produces the same ids for the rows both transports carry', () => {
    const rpc = rowsToItems(
      rpcHistoryRows.filter(row => [1, 2, 14, 15].includes(Number(row.row_id))),
      'rpc'
    )

    expect(items.filter(item => item.rowId !== undefined).map(item => item.id)).toEqual(rpc.map(item => item.id))
  })

  it('flags the unsolicited inbound DM and its answering turn', () => {
    const inbound = items.find(item => item.kind === 'bot_dm_in') as BotDmInItem
    const assistant = items.at(-1) as AssistantItem

    expect(inbound.answersOurDispatch).toBeUndefined()
    expect(assistant.replyToBotHandle).toBe('writer')
  })
})

describe('stripUserText', () => {
  it('drops the attached-context block and the warnings tail', () => {
    const stripped = stripUserText(String(attachedContextRow.text))

    expect(stripped.text).toBe('Look at and tell me what broke.')
    expect(stripped.attachments).toEqual(['@file:/srv/app/server.ts', '@image:/tmp/shot.png'])
  })

  it('leaves an ordinary message untouched', () => {
    expect(stripUserText('just a question')).toEqual({ text: 'just a question' })
  })
})

describe('rowsToItems edge cases', () => {
  it('recovers a reply that only survives in the codex sidecar', () => {
    const items = rowsToItems([codexSidecarRow], 'rpc')

    expect(items).toHaveLength(1)
    expect((items[0] as AssistantItem).text).toBe('Recovered reply.')
  })

  it('keeps a non-delivery process completion as a notice', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 5, display_kind: 'process_complete', text: plainProcessText }],
      'rpc'
    )

    expect(items[0]).toMatchObject({ kind: 'notice', noticeKind: 'process_complete' })
    expect((items[0] as NoticeItem).body).toContain('error TS2345')
    expect((items[0] as NoticeItem).completions).toHaveLength(1)
  })

  it('keeps a delivery completion as a notice when no dispatch precedes it', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 5, display_kind: 'process_complete', text: dmReplyProcessText }],
      'rpc'
    )

    expect(items[0]).toMatchObject({ kind: 'notice', noticeKind: 'process_complete' })
    expect((items[0] as NoticeItem).completions?.[0]?.sid).toBe('proc-2f9c')
  })

  it('drops rows with nothing to show', () => {
    expect(
      kinds([
        { role: 'assistant', text: '' },
        { role: 'user', text: '   ' }
      ])
    ).toEqual([])
  })

  it('ignores roles it does not model', () => {
    expect(kinds([{ role: 'developer', text: 'scaffolding' }])).toEqual([])
  })
})
