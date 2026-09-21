/**
 * The header pill's width, and the tool name that used to set it.
 *
 * The report was that the pill "resizes constantly while a bot works". It does not
 * have a width to resize: the pill hugs its contents, and the widest content was
 * whichever status line was current — `Online` for one frame and
 * `Running mcp__terminal__run_in_terminal…` for the next. Two things fix it and
 * both are pinned here: the status line is laid out so it cannot contribute a
 * width at all, and an MCP tool is named by its server before it ever gets here.
 *
 * The test renderer has no layout engine, so "the width does not change" is
 * asserted the only way it can be honestly: the subtree that DOES decide the width
 * — the name and the box around it — is identical across four different statuses,
 * and the status itself is inside an absolutely positioned view, which Yoga leaves
 * out of its parent's intrinsic size.
 */
import { act, render } from '@testing-library/react-native'

import { ChatHeader, PILL_MIN_TEXT_WIDTH, pillTextWidth } from '../src/chat-ui/ChatHeader'
import type { PresenceState } from '../src/ui/tokens'
import { shortToolName, TOOL_NAME_MAX } from '../src/chat-ui/tool-label'
import { ThemeProvider } from '../src/ui/theme'

function header(subtitle: string, presence: PresenceState = 'working', name = 'Researcher') {
  return render(
    <ThemeProvider>
      <ChatHeader name={name} onOpenOptions={() => undefined} presence={presence} subtitle={subtitle} />
    </ThemeProvider>
  )
}

const STATUSES = ['Online', 'Thinking…', 'Typing…', 'Running terminal…']

/**
 * Lay the ruler out, the way a real layout pass would.
 *
 * The test renderer has no layout engine, so the measurement has to be handed
 * in. That is not a weakening of the assertion — it is the whole mechanism
 * being tested: the pill is supposed to take ONE number from ONE view and
 * never ask anything else.
 *
 * The handler is called rather than dispatched, because the ruler is inert
 * (`pointerEvents="none"`) and `fireEvent` will not deliver to a view that
 * takes no events — which is correct of it, and not what is being tested here.
 */
function measure(tree: ReturnType<typeof header>, width: number) {
  const ruler = tree.getByTestId('chat-header-ruler', { includeHiddenElements: true })
  const onLayout = ruler.props.onLayout as (event: { nativeEvent: { layout: { width: number } } }) => void

  act(() => {
    onLayout({ nativeEvent: { layout: { width } } })
  })
}

/** The style the pill's text column actually resolved to. */
function columnStyle(tree: ReturnType<typeof header>): Record<string, unknown> {
  return tree.getByTestId('chat-header-text', { includeHiddenElements: true }).props.style as Record<string, unknown>
}

describe('the status line cannot widen the pill', () => {
  it('draws the status absolutely, so it is outside the pill’s intrinsic width', () => {
    const tree = header('Running terminal…')
    const status = tree.getByTestId('chat-header-status')
    const [floated] = status.children as { props: { style?: Record<string, unknown> } }[]

    expect(floated?.props.style).toMatchObject({ left: 0, position: 'absolute', right: 0 })
    // A fixed height, because an absolute child contributes no height either and
    // the name would otherwise sit on the pill's bottom rim.
    expect(status.props.style).toMatchObject({ height: 17 })
  })

  it('keeps the name — the one thing that decides the width — identical across statuses', () => {
    const widths = STATUSES.map(status => {
      const tree = header(status)
      const name = tree.getByText('Researcher')

      return JSON.stringify({ props: name.props.style, text: name.props.children })
    })

    expect(new Set(widths).size).toBe(1)
  })

  it('elides a long status inside that width rather than asking for more', () => {
    const tree = header('Running an extremely long tool name that could never fit…')

    expect(tree.getByText('Running an extremely long tool name that could never fit…').props.numberOfLines).toBe(1)
  })
})

describe('the pill takes one number and stops asking', () => {
  it('pins the text column to the measured name, so no status can reach the width', () => {
    const tree = header('Thinking…')

    // Before the ruler answers, the floor is all there is.
    expect(columnStyle(tree).width).toBeUndefined()
    expect(columnStyle(tree).minWidth).toBe(PILL_MIN_TEXT_WIDTH)

    measure(tree, 143.4)

    // An explicit width, not an intrinsic one: from here the column's size is a
    // stored number rather than a question anything can answer.
    expect(columnStyle(tree).width).toBe(144)
  })

  it('keeps that width equal across three states', () => {
    const widths = (['online', 'working', 'needsInput'] as PresenceState[]).map(presence => {
      const tree = header('', presence)

      measure(tree, 143.4)

      return columnStyle(tree).width
    })

    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(144)
  })

  it('keeps it equal across the statuses a working bot cycles through', () => {
    const widths = STATUSES.map(status => {
      const tree = header(status)

      measure(tree, 143.4)

      return columnStyle(tree).width
    })

    expect(new Set(widths).size).toBe(1)
  })

  it('re-measures when the BOT is renamed, which is the one thing that may move it', () => {
    const tree = header('Online', 'online', 'Al')

    measure(tree, 24)
    expect(columnStyle(tree).width).toBe(PILL_MIN_TEXT_WIDTH)

    tree.rerender(
      <ThemeProvider>
        <ChatHeader
          name="Alexandra the Researcher"
          onOpenOptions={() => undefined}
          presence="online"
          subtitle="Online"
        />
      </ThemeProvider>
    )
    measure(tree, 260)

    expect(columnStyle(tree).width).toBe(260)
  })

  it('never goes under the floor, whatever the ruler reports', () => {
    expect(pillTextWidth(0)).toBe(PILL_MIN_TEXT_WIDTH)
    expect(pillTextWidth(12)).toBe(PILL_MIN_TEXT_WIDTH)
    expect(pillTextWidth(200.1)).toBe(201)
  })
})

describe('what a tool is called in a status line', () => {
  it.each([
    ['mcp__terminal__run_in_terminal', 'terminal'],
    ['mcp__terminal__read_terminal', 'terminal'],
    ['mcp__fullstackstudio__list_customers', 'fullstackstudio'],
    ['mcp__ccd_session__mark_chapter', 'ccd_session'],
    ['mcp__github__create_pull_request', 'github']
  ])('names %s by its server: %s', (raw, expected) => {
    expect(shortToolName(raw)).toBe(expected)
  })

  it.each([
    ['Bash', 'Bash'],
    ['Read', 'Read'],
    ['str_replace_editor', 'str_replace_editor'],
    ['web_search', 'web_search']
  ])('leaves %s alone, because it is already its own name', (raw, expected) => {
    expect(shortToolName(raw)).toBe(expected)
  })

  it('caps a name no rule can shorten', () => {
    const long = shortToolName('a_very_long_tool_name_from_somewhere')

    expect(long).toBe('a_very_long_tool_…')
    expect(long.length).toBe(TOOL_NAME_MAX)
  })

  it('caps an MCP server whose own name is the long part', () => {
    expect(shortToolName('mcp__an_extremely_long_server_name__do_something')).toBe('an_extremely_long…')
  })

  it('answers nothing for nothing, so the caller can fall back to Working…', () => {
    expect(shortToolName('')).toBe('')
    expect(shortToolName('   ')).toBe('')
  })

  it('does not treat a double underscore that is not a namespace as one', () => {
    expect(shortToolName('read__file')).toBe('read__file')
  })
})
