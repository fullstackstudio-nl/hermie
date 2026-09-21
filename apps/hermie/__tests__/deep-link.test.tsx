/**
 * `hermie://chat/<bot>` — the one link this app answers.
 *
 * Two things are pinned here and they are not the same thing. The parser is a
 * table, because a URL scheme is registered with the SYSTEM: any app on the
 * device and any web page the reader taps can send one, so what the grammar
 * refuses matters more than what it accepts. The hook is about ordering, because
 * a widget tap on a closed app and a widget tap on an open one arrive by two
 * different routes and only one of them may be replayed.
 */
import { act, render } from '@testing-library/react-native'
import { Linking, Text } from 'react-native'

import { parseHermieLink, useHermieLink } from '../src/platform/deep-link'

const mockConsumeLaunchURL = jest.fn<string | null, []>(() => null)

// `hermie-scene` is Apple-only and has no native side under Jest, so the seam
// reads `null` there without this. The mock is here to drive the cold-start
// path, which is the only one that source answers.
jest.mock('expo', () => ({
  ...jest.requireActual('expo'),
  requireOptionalNativeModule: (name: string) =>
    name === 'HermieScene' ? { consumeLaunchURL: mockConsumeLaunchURL } : null
}))

describe('parseHermieLink', () => {
  it('reads the bot out of a chat link', () => {
    expect(parseHermieLink('hermie://chat/researcher')).toEqual({ kind: 'chat', bot: 'researcher' })
  })

  it('accepts the dev client scheme, so a link tested in development is the same link', () => {
    expect(parseHermieLink('exp+hermie://chat/researcher')).toEqual({ kind: 'chat', bot: 'researcher' })
  })

  it('tolerates a trailing slash and a query nobody asked for', () => {
    expect(parseHermieLink('hermie://chat/researcher/')).toEqual({ kind: 'chat', bot: 'researcher' })
    expect(parseHermieLink('hermie://chat/researcher?from=widget')).toEqual({ kind: 'chat', bot: 'researcher' })
  })

  it('decodes a name that had to be escaped', () => {
    expect(parseHermieLink('hermie://chat/code%20reviewer')).toEqual({ kind: 'chat', bot: 'code reviewer' })
  })

  /**
   * The refusals. Each of these is something another app could send, and each
   * answers `null` rather than opening anything or throwing inside a listener.
   */
  it.each([
    ['nothing at all', null],
    ['an empty string', ''],
    ['another scheme', 'https://hermie.dev/chat/researcher'],
    ['a look-alike scheme', 'hermie-evil://chat/researcher'],
    ['no bot', 'hermie://chat/'],
    ['no bot and no slash', 'hermie://chat'],
    ['a second path segment', 'hermie://chat/researcher/settings'],
    ['a verb this app does not answer', 'hermie://gateway/https%3A%2F%2Fevil.invalid'],
    ['an escaped slash that would climb out of the chat', 'hermie://chat/%2E%2E%2Fadmin'],
    ['a malformed escape', 'hermie://chat/%E0%A4%A']
  ])('refuses %s', (_label, url) => {
    expect(parseHermieLink(url)).toBeNull()
  })
})

function Probe({ onLink }: { onLink: (bot: string) => void }) {
  useHermieLink(link => onLink(link.bot))

  return <Text>probe</Text>
}

describe('useHermieLink', () => {
  let listener: ((event: { url: string }) => void) | null = null
  let initialUrl: string | null = null

  beforeEach(() => {
    listener = null
    initialUrl = null
    mockConsumeLaunchURL.mockReturnValue(null)

    jest.spyOn(Linking, 'addEventListener').mockImplementation(((_event: string, handler: never) => {
      listener = handler as unknown as (event: { url: string }) => void

      return { remove: () => undefined }
    }) as never)

    jest.spyOn(Linking, 'getInitialURL').mockImplementation(() => Promise.resolve(initialUrl))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('opens the chat the app was launched by', async () => {
    initialUrl = 'hermie://chat/researcher'
    const opened: string[] = []

    render(<Probe onLink={bot => opened.push(bot)} />)
    await act(async () => undefined)

    expect(opened).toEqual(['researcher'])
  })

  it('opens the chat a link sent while the app was already running', async () => {
    const opened: string[] = []

    render(<Probe onLink={bot => opened.push(bot)} />)
    await act(async () => undefined)

    await act(async () => listener?.({ url: 'hermie://chat/writer' }))

    expect(opened).toEqual(['writer'])
  })

  /**
   * The same widget tapped twice is two requests to open that chat. A dedupe on
   * the URL string would swallow the second, which is the failure a reader
   * notices and cannot explain.
   */
  it('opens the same chat again when the same link arrives again', async () => {
    const opened: string[] = []

    render(<Probe onLink={bot => opened.push(bot)} />)
    await act(async () => undefined)

    await act(async () => listener?.({ url: 'hermie://chat/writer' }))
    await act(async () => listener?.({ url: 'hermie://chat/writer' }))

    expect(opened).toEqual(['writer', 'writer'])
  })

  /**
   * Under the scene life cycle a cold-start URL reaches JavaScript as an EVENT
   * while `getInitialURL()` is still pending — and that same URL is what
   * `getInitialURL()` then answers. Acting on both would open the chat twice.
   */
  it('does not open a launch link twice when it arrives as an event first', async () => {
    let resolveInitial: (url: string | null) => void = () => undefined
    jest.spyOn(Linking, 'getInitialURL').mockImplementation(
      () =>
        new Promise<string | null>(resolve => {
          resolveInitial = resolve
        })
    )

    const opened: string[] = []
    render(<Probe onLink={bot => opened.push(bot)} />)

    await act(async () => listener?.({ url: 'hermie://chat/researcher' }))
    await act(async () => resolveInitial('hermie://chat/researcher'))

    expect(opened).toEqual(['researcher'])
  })

  /**
   * The cold-start case on iOS, and the reason `modules/hermie-scene` grew a
   * JavaScript side. `getInitialURL()` answers null for a link that arrived at
   * the scene rather than in the launch options, so without this source a widget
   * tapped while the app was closed opens Hermie on whatever screen it was last
   * on.
   */
  it('opens the chat a cold start was launched by, which getInitialURL does not know', async () => {
    mockConsumeLaunchURL.mockReturnValue('hermie://chat/researcher')
    const opened: string[] = []

    render(<Probe onLink={bot => opened.push(bot)} />)
    await act(async () => undefined)

    expect(opened).toEqual(['researcher'])
  })

  it('does not act on the launch URL twice when both sources have it', async () => {
    mockConsumeLaunchURL.mockReturnValue('hermie://chat/researcher')
    initialUrl = 'hermie://chat/researcher'
    const opened: string[] = []

    render(<Probe onLink={bot => opened.push(bot)} />)
    await act(async () => undefined)

    expect(opened).toEqual(['researcher'])
  })

  it('ignores a launch URL that is not a Hermie link', async () => {
    initialUrl = 'https://hermie.dev'
    const opened: string[] = []

    render(<Probe onLink={bot => opened.push(bot)} />)
    await act(async () => undefined)

    expect(opened).toEqual([])
  })
})
