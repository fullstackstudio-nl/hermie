/**
 * The transcript renders every item kind and honours every presentation the
 * selectors can hand it.
 *
 * `visibleItems` returns `{item, presentation}` and nothing else, so a kind the
 * list forgets about is a silently blank row in production — hence one case per
 * kind here rather than one happy-path render.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import {
  approvalItem,
  assistantItem,
  botDmInItem,
  botDmOutItem,
  clarifyItem,
  galleryTranscript,
  noticeItem,
  pendingDmOutItem,
  searchToolItem,
  statusItem,
  subagentGroupItem,
  subagentMap,
  userItem
} from '../../src/chat-ui/fixtures'
import type { Presentation, TranscriptItem, VisibleItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const PRESENTATIONS: Presentation[] = ['full', 'collapsed', 'chip', 'hidden-placeholder']

const KINDS: TranscriptItem[] = [
  userItem,
  assistantItem,
  botDmInItem,
  searchToolItem,
  botDmOutItem,
  subagentGroupItem,
  statusItem,
  noticeItem,
  approvalItem,
  clarifyItem
]

function renderList(items: VisibleItem[], props: Record<string, unknown> = {}) {
  return renderScreen(<TranscriptList items={items} subagents={subagentMap} {...props} />)
}

const FULL_TEST_IDS: Record<string, string | undefined> = {
  approval: `request-${approvalItem.id}`,
  assistant: `assistant-${assistantItem.id}`,
  bot_dm_in: `bot-dm-in-header-${botDmInItem.id}`,
  bot_dm_out: `bot-dm-out-${botDmOutItem.id}`,
  clarify: `request-${clarifyItem.id}`,
  notice: `notice-${noticeItem.id}`,
  status: `status-${statusItem.id}`,
  subagent_group: `subagent-group-${subagentGroupItem.id}`,
  tool: `tool-card-${searchToolItem.id}`,
  user: undefined
}

describe('TranscriptList', () => {
  // One list per kind: `FlatList` only mounts its first window, so a single
  // list of everything would silently skip the rows further up.
  it.each(KINDS.map(item => [item.kind, item] as const))('renders a %s item at full presentation', (kind, item) => {
    const view = renderList([{ item, presentation: 'full' }])
    const testID = FULL_TEST_IDS[kind]

    if (testID) {
      expect(view.getByTestId(testID)).toBeTruthy()
    } else {
      expect(view.getByText(userItem.text)).toBeTruthy()
    }
  })

  it.each(KINDS.map(item => [item.kind, item] as const))('renders a %s item at every presentation', (_kind, item) => {
    for (const presentation of PRESENTATIONS) {
      const view = renderList([{ item, presentation }])

      view.unmount()
    }
  })

  it('renders a hidden placeholder as nothing at all', () => {
    const view = renderList([{ item: searchToolItem, presentation: 'hidden-placeholder' }])

    expect(view.queryByTestId(`tool-card-${searchToolItem.id}`)).toBeNull()
  })

  it('renders a silent tool as nothing, even at full presentation', () => {
    const silent = { ...searchToolItem, id: 'silent', name: 'todo' }
    const view = renderList([{ item: silent, presentation: 'full' }])

    expect(view.queryByTestId('tool-card-silent')).toBeNull()
  })

  it('collapses a demoted DM to a chip that opens the other bot', () => {
    const onOpenBot = jest.fn()

    renderList([{ item: botDmInItem, presentation: 'chip' }], { onOpenBot })

    fireEvent.press(screen.getByTestId(`bot-dm-in-chip-${botDmInItem.id}`))
    // The second argument describes the row to look for on the far side, so the
    // sender's chat opens on the dispatch rather than at its bottom.
    expect(onOpenBot).toHaveBeenCalledWith('writer', expect.objectContaining({ kind: 'bot_dm_out' }))
  })

  it('shows the receipt under the last own bubble only', () => {
    const second = { ...userItem, id: 'u2', seq: 40, text: 'Second question.' }

    renderList(
      [
        { item: userItem, presentation: 'full' },
        { item: assistantItem, presentation: 'full' },
        { item: second, presentation: 'full' }
      ],
      { receipt: 'read' }
    )

    expect(screen.getAllByText(/^Read/)).toHaveLength(1)
  })

  it('reports scrolling away from the bottom and shows the jump pill', () => {
    const onScrolledAwayFromBottom = jest.fn()

    renderList(galleryTranscript, { newMessageCount: 3, onScrolledAwayFromBottom })

    fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 400 },
        contentSize: { height: 2000, width: 400 },
        layoutMeasurement: { height: 800, width: 400 }
      }
    })

    expect(onScrolledAwayFromBottom).toHaveBeenCalledWith(true)
    expect(screen.getByTestId('jump-to-latest')).toBeTruthy()
    expect(screen.getByText('3 new')).toBeTruthy()
  })

  it('shows the typing bubble while a turn has produced no text', () => {
    renderList(galleryTranscript, { typing: true })

    expect(screen.getByTestId('typing-indicator')).toBeTruthy()
  })
})

describe('answered questions', () => {
  it('leaves a receipt naming the decision AND the command, never a bare duration', () => {
    renderList([
      {
        item: { ...approvalItem, answer: 'once', state: 'answered' },
        presentation: 'full'
      }
    ])

    expect(screen.getByText('Allowed once · git push origin release-notes')).toBeTruthy()
  })

  it('truncates a long command rather than pushing the decision off the row', () => {
    renderList([
      {
        item: {
          ...approvalItem,
          answer: 'deny',
          command: 'rm -rf ./build && rm -rf ./dist && rm -rf ./node_modules/.cache && echo done',
          state: 'answered'
        },
        presentation: 'full'
      }
    ])

    expect(screen.getByText(/^Denied · rm -rf \.\/build/u)).toBeTruthy()
    expect(screen.getByText(/…$/u)).toBeTruthy()
  })

  it('says a question was answered elsewhere rather than inventing an outcome', () => {
    renderList([{ item: { ...approvalItem, state: 'cancelled' }, presentation: 'full' }])

    expect(screen.getByText('Answered elsewhere')).toBeTruthy()
  })
})

describe('a dispatch whose recipient is answering', () => {
  it('says so under the card while the reply has not landed', () => {
    renderList([{ item: pendingDmOutItem, presentation: 'collapsed' }], { typingHandles: ['builder'] })

    expect(screen.getByTestId(`bot-dm-out-typing-${pendingDmOutItem.id}`)).toBeTruthy()
    expect(screen.getByText('@builder is writing…')).toBeTruthy()
  })

  it('stays quiet for a dispatch that already has its reply', () => {
    renderList([{ item: botDmOutItem, presentation: 'collapsed' }], { typingHandles: ['writer'] })

    expect(screen.queryByTestId(`bot-dm-out-typing-${botDmOutItem.id}`)).toBeNull()
  })
})
