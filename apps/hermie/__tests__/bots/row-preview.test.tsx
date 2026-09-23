/**
 * HERM-83, Task 5: the store-wired half of the chat-list attribution.
 *
 * `packages/transcript/src/preview.test.ts` and `sender-preview.test.ts` cover
 * the pure decision (`chatRowPreview`/`formatChatPreview`) exhaustively; this
 * is the one test that proves `useRowPreview` actually reaches for the
 * reader's own identity and the sanitising resolver rather than only being
 * wired to compile.
 */
import { renderHook } from '@testing-library/react-native'

import { createChatState, reconcile, rowsToItems, type TranscriptRow } from '@hermie/transcript'

import { useRowPreview } from '../../src/features/bots/row-preview'
import { useChatsStore } from '../../src/store/chats'
import { useDeviceContextStore } from '../../src/store/device-context'

const ME = 'authentik:me'

function seedResearcherChat(rows: readonly TranscriptRow[]): void {
  useChatsStore
    .getState()
    .hydrate(
      'researcher',
      reconcile(createChatState('researcher', 'stored-researcher', 'resolved-researcher'), rowsToItems(rows, 'rpc'))
    )
}

describe('useRowPreview', () => {
  beforeEach(() => {
    useDeviceContextStore.getState().setIdentity({ baseUrl: '', email: '', gated: false, displayName: '', userId: ME })
  })

  it('leads the row with a foreign sender’s resolved name', () => {
    seedResearcherChat([
      {
        role: 'user',
        row_id: 1,
        text: 'draft is ready',
        display_metadata: { author: { id: 'authentik:writer-review', name: 'Robin Vale' } }
      }
    ])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('Robin Vale: draft is ready')
    expect(result.current.system).toBe(false)
  })

  it('leaves the reader’s own attributed row exactly as it read before `author` existed', () => {
    seedResearcherChat([{ role: 'user', row_id: 1, text: 'ship it', display_metadata: { author: { id: ME } } }])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('ship it')
  })

  it('leaves an unattributed row unnamed, even once the reader’s own identity is known', () => {
    seedResearcherChat([{ role: 'user', row_id: 1, text: 'from before the stamp existed' }])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('from before the stamp existed')
  })

  it('falls back to the gateway’s own string, unattributed, when this device holds no transcript', () => {
    const { result } = renderHook(() => useRowPreview('an-unopened-bot', 'Message from 🤖 Writer (@writer): hi'))

    expect(result.current.text).toBe('🤖 @writer: hi')
  })
})
