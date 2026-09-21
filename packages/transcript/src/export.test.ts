import { describe, expect, it } from 'vitest'

import { exportTranscript, transcriptFileName } from './export'
import type { TranscriptItem } from './types'

let seq = 0

const base = (ts?: number) => ({
  id: `i${(seq += 1)}`,
  origin: 'history' as const,
  seq,
  version: 1,
  ...(ts === undefined ? {} : { ts })
})

const clock = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(11, 16)

const OPTIONS = { botName: 'Researcher', formatTime: clock, selfName: 'You' }

describe('serializing a conversation', () => {
  it('writes the two speakers, in order, in both formats', () => {
    const items: TranscriptItem[] = [
      { ...base(60), kind: 'user', text: 'Introduce yourself.' },
      { ...base(120), interim: false, kind: 'assistant', streaming: false, text: '# Hello\n\nI am **researcher**.' }
    ]

    const { markdown, text } = exportTranscript(items, OPTIONS)

    expect(markdown).toBe(
      [
        '# Researcher',
        '',
        '**You** · 00:01',
        '',
        'Introduce yourself.',
        '',
        '**Researcher** · 00:02',
        '',
        '# Hello',
        '',
        'I am **researcher**.',
        ''
      ].join('\n')
    )
    expect(text).toContain('00:01 · You:')
    expect(text).toContain('00:02 · Researcher:')
    // The reply's own markdown survives into the .txt file: those are the
    // author's characters, and an export must not edit what it preserves.
    expect(text).toContain('I am **researcher**.')
  })

  it('writes the rows that are about the conversation as asides', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        kind: 'tool',
        name: 'terminal',
        context: 'ls -la',
        resultKnown: true,
        status: 'complete',
        toolId: 't1'
      },
      { ...base(70), kind: 'notice', noticeKind: 'model_switch', title: 'Switched model', body: 'to example-large' },
      {
        ...base(80),
        approvalId: 'a1',
        choices: ['allow', 'deny'],
        command: 'rm -rf ./build',
        kind: 'approval',
        requestId: 'srq-1',
        state: 'answered',
        answer: 'allow'
      }
    ]

    const { markdown, text } = exportTranscript(items, OPTIONS)

    expect(markdown).toContain('> 00:01 · terminal: ls -la')
    expect(markdown).toContain('> 00:01 · Switched model — to example-large')
    expect(markdown).toContain('> 00:01 · Permission request — rm -rf ./build (answered allow)')
    expect(text).toContain('  · 00:01 · terminal: ls -la')
    // An aside is never attributed to a speaker in either format.
    expect(markdown).not.toContain('**terminal**')
  })

  it('carries a turn’s attachments by the reference the turn holds', () => {
    const items: TranscriptItem[] = [
      { ...base(60), attachments: ['@file:/root/notes.md'], kind: 'user', text: 'Read this.' }
    ]

    expect(exportTranscript(items, OPTIONS).markdown).toContain('[@file:/root/notes.md]')
  })

  it('keeps a failed turn for its error and drops one that said nothing at all', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        error: { message: 'the worker died', partial: false },
        interim: false,
        kind: 'assistant',
        streaming: false,
        text: ''
      },
      { ...base(70), interim: false, kind: 'assistant', streaming: false, text: '   ' }
    ]

    const { markdown } = exportTranscript(items, OPTIONS)

    expect(markdown).toContain('(the worker died)')
    expect(markdown.match(/\*\*Researcher\*\*/gu)).toHaveLength(1)
  })

  it('drops the rows that are gone from the screen a second later', () => {
    const items: TranscriptItem[] = [
      { ...base(60), kind: 'status', statusKind: 'compaction', text: 'Compacting…' },
      { ...base(70), kind: 'user', text: 'Still here.' }
    ]

    const { markdown } = exportTranscript(items, OPTIONS)

    // A file of transient one-liners is a file of things that are no longer
    // true.
    expect(markdown).not.toContain('Compacting')
    expect(markdown).toContain('Still here.')
  })

  it('exports exactly the items it was handed, hidden rows included or not', () => {
    // The contract this package cannot check for itself, stated here so the
    // caller cannot quietly change it: the input is the VISIBLE list, so a chat
    // filtered to Quiet exports the quiet conversation.
    const visible: TranscriptItem[] = [{ ...base(60), kind: 'user', text: 'Only me.' }]

    expect(exportTranscript(visible, OPTIONS).markdown).toContain('Only me.')
    expect(exportTranscript([], OPTIONS).markdown).toBe('# Researcher\n')
  })

  it('names the bot-to-bot lines without making either bot the speaker', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        dispatch: { status: 'queued' },
        kind: 'bot_dm_out',
        message: 'Draft the summary.',
        reply: { text: 'Done.' },
        target: '@writer',
        targetHandle: 'writer',
        toolId: 'd1'
      },
      { ...base(70), kind: 'bot_dm_in', senderName: 'Writer', senderHandle: 'writer', text: 'Anything else?' }
    ]

    const { markdown } = exportTranscript(items, OPTIONS)

    expect(markdown).toContain('> 00:01 · Message to @writer: Draft the summary.')
    expect(markdown).toContain('> Reply: Done.')
    // An inbound message IS speech, and it is attributed to whoever sent it.
    expect(markdown).toContain('**Writer**')
  })

  it('stamps nothing when the caller has no clock to lend', () => {
    const items: TranscriptItem[] = [{ ...base(60), kind: 'user', text: 'Hello.' }]

    expect(exportTranscript(items, { botName: 'Researcher' }).markdown).toBe('# Researcher\n\n**You**\n\nHello.\n')
  })

  it('heads the file with the bot and, when it knows, when it was taken', () => {
    const { markdown, text } = exportTranscript([], { ...OPTIONS, exportedAt: 3_600 })

    expect(markdown).toContain('_Exported 01:00_')
    expect(text).toContain('Exported 01:00')
  })
})

describe('naming the file', () => {
  it('reduces a bot name to something a file system will take', () => {
    expect(transcriptFileName('Researcher', 'md', '2026-09-22')).toBe('Researcher-2026-09-22.md')
    // A name with a slash in it would otherwise be a path.
    expect(transcriptFileName('ops/deploy', 'txt', '2026-09-22')).toBe('ops-deploy-2026-09-22.txt')
    expect(transcriptFileName('  ', 'md', '2026-09-22')).toBe('chat-2026-09-22.md')
    expect(transcriptFileName('日本語', 'md', '2026-09-22')).toBe('chat-2026-09-22.md')
  })
})
