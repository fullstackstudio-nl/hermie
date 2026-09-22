/**
 * The line between a machine's report and somebody speaking.
 *
 * Everything in `injected.ts` is a guess made from text, so the cases that matter
 * are the ones on either side of the line: the shapes upstream actually writes
 * have to be recognised, and prose that merely opens with a bracket must not be.
 * The second half is the one that costs something when it is wrong — a message
 * the owner typed, redrawn as a grey card, is worse than a report drawn as a
 * bubble.
 */
import { describe, expect, it } from 'vitest'

import {
  cronjobResponseText,
  delegationBatchText,
  kanbanNotificationText,
  modelSwitchMarkerText,
  personalitySwitchMarkerText,
  plainProcessText,
  planningPreservedText,
  priorContextText,
  steerWrapperBody,
  steerWrapperText,
  todoInjectionText
} from './__fixtures__/rows'
import { isInjectedRow, parseInjectedRow, stripSteerWrapper, unwrapSystemNote } from './injected'

describe('the headers the gateway injects', () => {
  it('reads a fan-out report as delegation work that finished', () => {
    expect(parseInjectedRow(delegationBatchText)).toMatchObject({
      noticeKind: 'async_delegation_complete',
      title: 'ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada',
      // The whole row, header included: a card that hides the header would make
      // the reader open the gateway's database to see what arrived.
      body: delegationBatchText
    })
  })

  it('reads the single and the failed-task variants of the same family', () => {
    const single = '[ASYNC DELEGATION COMPLETE — deleg_77]\nStatus: completed   API calls: 4'
    const failed = '[ASYNC DELEGATION TASK FAILED — deleg_77, task 2/3]\nOne subagent has failed.'

    expect(parseInjectedRow(single)?.noticeKind).toBe('async_delegation_complete')
    expect(parseInjectedRow(failed)?.noticeKind).toBe('async_delegation_complete')
    expect(parseInjectedRow(failed)?.title).toBe('ASYNC DELEGATION TASK FAILED — deleg_77, task 2/3')
  })

  it('reads a background process whose bracket closes at the far end of the block', () => {
    // `[IMPORTANT: Background process …` opens on the first line and closes on
    // the last, which is the other of the two ways these headers close.
    expect(parseInjectedRow(plainProcessText)).toMatchObject({
      noticeKind: 'process_complete',
      title: 'IMPORTANT: Background process proc-aa01 exited (exit code 1).',
      body: 'error TS2345: Argument of type string is not assignable.'
    })
  })

  it('leaves a completion carrying a teammate reply to the code that can attribute it', () => {
    // The persisted projection hands that block to the `message_agent` dispatch
    // it came from and keeps only the leftovers. Nothing in the text says whether
    // the dispatch is on screen, so this refuses rather than guessing a body the
    // two descriptions would then disagree about.
    const dmDelivery = [
      '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
      'Command: /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file /root/.hermes/dm/2f9c.json',
      'Output:',
      'Message from 🤖 Writer (@writer): pushed.]'
    ].join('\n')

    expect(parseInjectedRow(dmDelivery)).toBeNull()
  })

  it('reads the compaction handoff', () => {
    expect(parseInjectedRow(priorContextText)).toMatchObject({
      noticeKind: 'internal_notification',
      // Cut before the semicolon: the clause behind it is addressed to the model.
      title: 'PRIOR CONTEXT — for reference only'
    })
  })

  it('reads a kanban dispatch, which carries no bracketed header at all', () => {
    expect(
      parseInjectedRow(`${kanbanNotificationText}\n⏸ [ops] Kanban task-4413 blocked: waiting on DNS`)
    ).toMatchObject({ noticeKind: 'internal_notification', title: kanbanNotificationText })
  })
})

describe('what stays a message', () => {
  it.each([
    ['a lower-case tag', '[ok] done'],
    ['a numbered list', '[1] first item\n[2] second item'],
    ['a shouted label with nothing under it', '[TODO]'],
    ['a shout that never closes its bracket', '[TODO fix the parser\nbefore Friday'],
    ['prose that merely mentions a header', 'the log said [IMPORTANT: something] and I ignored it'],
    ['a fenced quote of a real header', '```\n[ASYNC DELEGATION BATCH COMPLETE — x]\n```'],
    ['an empty string', '']
  ])('leaves %s alone', (_what, text) => {
    expect(parseInjectedRow(text)).toBeNull()
    expect(isInjectedRow(text)).toBe(false)
  })

  it('leaves a cron delivery and a teammate DM to their own parsers', () => {
    expect(parseInjectedRow('[Cron delivery: Morning Brief]\nBoth green.')).toBeNull()
    expect(parseInjectedRow("[Message from agent 'Writer']\nDraft is ready.")).toBeNull()
  })

  it('leaves the steer wrapper alone, because a steer IS the user', () => {
    expect(parseInjectedRow(steerWrapperText)).toBeNull()
  })

  it('survives anything that is not a string', () => {
    expect(parseInjectedRow(undefined)).toBeNull()
    expect(parseInjectedRow(42)).toBeNull()
    expect(parseInjectedRow({ text: '[ASYNC DELEGATION BATCH COMPLETE — x]\nbody' })).toBeNull()
  })
})

describe('the steer wrapper', () => {
  it('gives back only the words the user typed', () => {
    expect(stripSteerWrapper(steerWrapperText)).toBe(steerWrapperBody)
  })

  it('keeps a multi-line steer whole', () => {
    const body = 'first line\n\nsecond line'
    const wrapped = steerWrapperText.replace(steerWrapperBody, body)

    expect(stripSteerWrapper(wrapped)).toBe(body)
  })

  it('does not fire on half a wrapper, or on prose quoting one', () => {
    expect(stripSteerWrapper(steerWrapperText.split('\n').slice(0, 2).join('\n'))).toBeNull()
    expect(stripSteerWrapper(`I saw this: ${steerWrapperText}`)).toBeNull()
    expect(stripSteerWrapper('lees over shared memory skill')).toBeNull()
  })

  it('survives anything that is not a string', () => {
    expect(stripSteerWrapper(null)).toBeNull()
    expect(stripSteerWrapper(7)).toBeNull()
  })
})

describe('the scaffolding that does not shout', () => {
  it('reads a model-switch marker as a system note, without its wrapper', () => {
    expect(parseInjectedRow(modelSwitchMarkerText)).toEqual({
      noticeKind: 'system_note',
      title: 'The active model for this chat has changed to k3 via provider moonshot.',
      body:
        'The active model for this chat has changed to k3 via provider moonshot. From this point forward, use this ' +
        'runtime metadata when answering questions about what model/provider is active.'
    })
  })

  it('reads the personality marker the same way, because it is the same shape', () => {
    expect(parseInjectedRow(personalitySwitchMarkerText)).toMatchObject({
      noticeKind: 'system_note',
      body: 'The user has cleared the personality overlay. From this point forward, respond in your normal default style.'
    })
  })

  it('keeps a sentence that carries a bracket of its own whole', () => {
    // The capture runs to the LAST bracket, not the first one it meets.
    expect(unwrapSystemNote('[System: Your previous tool call (write_file) was too large [truncated]. Retry.]')).toBe(
      'Your previous tool call (write_file) was too large [truncated]. Retry.'
    )
  })

  it('reads the two compaction handoffs as notifications, keeping the row whole', () => {
    expect(parseInjectedRow(todoInjectionText)).toEqual({
      noticeKind: 'internal_notification',
      title: 'Your active task list was preserved across context compression',
      body: todoInjectionText
    })
    expect(parseInjectedRow(planningPreservedText)).toMatchObject({
      noticeKind: 'internal_notification',
      title: 'Planning state preserved across context compression'
    })
  })

  it('reads the cron platform wrapper, which carries no bracket anywhere', () => {
    expect(parseInjectedRow(cronjobResponseText)).toMatchObject({
      noticeKind: 'internal_notification',
      title: 'Cronjob Response: daily-report',
      body: cronjobResponseText
    })
  })

  it('needs the id line and the rule, not just the two opening words', () => {
    // Without them, "Cronjob Response:" is two words anybody may type.
    expect(parseInjectedRow('Cronjob Response: what did the nightly job say?')).toBeNull()
    expect(parseInjectedRow('Cronjob Response: daily-report\nThree deploys, all green.')).toBeNull()
  })

  it('does not fire on prose that merely mentions the marker', () => {
    expect(parseInjectedRow('why does [System: ...] show up in my chat?')).toBeNull()
    expect(parseInjectedRow('[System: note] and then here is what I actually wanted')).toBeNull()
    expect(parseInjectedRow('[Your active task list is a mess, can you tidy it?')).toBeNull()
  })

  it('is indistinguishable from a person who types one, and says so', () => {
    /*
      Upstream has the same hole and documents it (`agent/title_generator.py`
      line 141, and its tests): a row that opens with the marker and closes its
      bracket at the end IS the convention, whoever wrote it. A person typing
      `[System: my own note]` gets a system line rather than a bubble.

      The direction is deliberate. A machine's scaffolding drawn as speech is the
      transcript lying about who spoke; a person's bracketed note drawn as a
      quiet centred line is only ugly. The closing-bracket test is what narrows
      the hole — `[System: my own note] how do I ...` stays a bubble, and that is
      the shape a person is far likelier to type.
    */
    expect(parseInjectedRow('[System: my own note]')).toMatchObject({ noticeKind: 'system_note' })
  })

  it('takes nothing off anything that is not a system note', () => {
    expect(unwrapSystemNote(delegationBatchText)).toBeNull()
    expect(unwrapSystemNote('[System: ]')).toBeNull()
    expect(unwrapSystemNote(undefined)).toBeNull()
    expect(unwrapSystemNote(12)).toBeNull()
  })

  it('agrees with the predicate', () => {
    expect(isInjectedRow(modelSwitchMarkerText)).toBe(true)
    expect(isInjectedRow(cronjobResponseText)).toBe(true)
    expect(isInjectedRow('what is the weather')).toBe(false)
  })
})
