/**
 * The header's line, as a table.
 *
 * Every case here is a moment in a turn the owner can see on screen, so each
 * one is driven by the events that produce it rather than by a hand-built
 * state: what this has to get right is the ORDER things arrive in, and a
 * literal `ChatState` would be the answer written down twice.
 */
import { describe, expect, it } from 'vitest'

import { applyEvent, applyServerRequest, type TranscriptEvent } from './reducer'
import { turnActivity } from './turn-activity'
import { approvalRequest, delegationEvents, streamedTurn, thinkingTurn } from './__fixtures__/events'
import { createChatState, type ChatState } from './types'

const NOW = 1_700_000_000_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const run = (events: readonly TranscriptEvent[], start: ChatState = fresh()) =>
  events.reduce((state, event) => applyEvent(state, event, NOW), start)

/** The stream up to and including the nth event, so a moment can be named. */
const upTo = (events: readonly TranscriptEvent[], type: string) =>
  run(events.slice(0, events.findIndex(event => event.type === type) + 1))

describe('turnActivity', () => {
  it('is idle before anything has happened', () => {
    expect(turnActivity(fresh())).toEqual({ kind: 'idle' })
  })

  it('is idle again once the turn completes', () => {
    expect(turnActivity(run(streamedTurn))).toEqual({ kind: 'idle' })
  })

  it('says working when the turn has started and said nothing', () => {
    expect(turnActivity(upTo(streamedTurn, 'message.start'))).toEqual({ kind: 'working' })
  })

  it('says thinking while reasoning arrives and no words have', () => {
    expect(turnActivity(upTo(thinkingTurn, 'reasoning.delta'))).toEqual({ kind: 'thinking' })
  })

  it('says typing once words arrive', () => {
    expect(turnActivity(upTo(streamedTurn, 'message.delta'))).toEqual({ kind: 'typing' })
  })

  it('keeps saying typing through a preview, which is the reply so far', () => {
    expect(turnActivity(upTo(thinkingTurn, 'message.interim'))).toEqual({ kind: 'typing' })
  })

  it('names the tool it is running', () => {
    expect(turnActivity(upTo(streamedTurn, 'tool.start'))).toEqual({ kind: 'tool', tool: 'read_file' })
  })

  it('names a tool the gateway announced before the call had an id', () => {
    // `tool.generating` is the earliest the name is knowable, and the row it
    // will become does not exist yet.
    expect(turnActivity(upTo(streamedTurn, 'tool.generating'))).toEqual({ kind: 'tool', tool: 'read_file' })
  })

  it('says delegating while a fan-out has children going', () => {
    expect(turnActivity(upTo(delegationEvents, 'subagent.start'))).toEqual({ kind: 'delegating' })
  })

  it('says waiting for an open approval, whatever else is running', () => {
    const streaming = upTo(streamedTurn, 'message.delta')

    expect(turnActivity(streaming)).toEqual({ kind: 'typing' })

    const asked = applyServerRequest(streaming, approvalRequest, NOW)

    expect(turnActivity(asked)).toEqual({ kind: 'waiting' })
  })

  it('keeps saying waiting after the turn itself has ended', () => {
    // A question put aside with "Later" outlives its turn, and the header going
    // back to the idle label over it is the app forgetting for the reader.
    const asked = applyServerRequest(run(streamedTurn), approvalRequest, NOW)

    expect(asked.turn.active).toBe(false)
    expect(turnActivity(asked)).toEqual({ kind: 'waiting' })
  })
})
