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
import { render } from '@testing-library/react-native'

import { ChatHeader } from '../src/chat-ui/ChatHeader'
import { shortToolName, TOOL_NAME_MAX } from '../src/chat-ui/tool-label'
import { ThemeProvider } from '../src/ui/theme'

function header(subtitle: string) {
  return render(
    <ThemeProvider>
      <ChatHeader name="Researcher" onOpenOptions={() => undefined} presence="working" subtitle={subtitle} />
    </ThemeProvider>
  )
}

const STATUSES = ['Online', 'Thinking…', 'Typing…', 'Running terminal…']

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
