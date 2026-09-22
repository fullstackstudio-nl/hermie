/**
 * The gateway-logs page, rendered.
 *
 * It never was, and that is half the reason the owner's report was "Logs shows
 * nothing": every test drove the controller with a hand-written body, so the
 * one state the page could reach on a real gateway — a reply the reader did not
 * understand — was asserted as an empty list and drawn as "This log is empty".
 *
 * So the cases here are the four things the page can honestly be: lines, an
 * empty file, a route that is not there, and a reply that is not a log page.
 * The last of those is new, and it is the one that must never again be spelled
 * as the second.
 */
import { act, screen, waitFor } from '@testing-library/react-native'

import { LogsScreen, logStrings } from '../src/features/logs'
import { renderScreen } from './support/render'

/** Every path asked for, and what the fake gateway answers. */
const paths: string[] = []
let answer: unknown | (() => never)

const http = {
  get: jest.fn(async (path: string) => {
    paths.push(path)

    if (typeof answer === 'function') {
      return (answer as () => never)()
    }

    return answer
  })
}

jest.mock('../src/gateway', () => {
  const frozen = { http: null as unknown }

  return { useGateway: () => frozen, __setHttp: (value: unknown) => (frozen.http = value) }
})

const { __setHttp } = require('../src/gateway') as { __setHttp: (value: unknown) => void }

const LINES = [
  '2026-09-22 09:00:00,123 INFO gateway.run: listening on 127.0.0.1:8080',
  '2026-09-22 09:00:04,880 ERROR gateway.run: refused a dial',
  'Traceback (most recent call last):'
]

async function open() {
  renderScreen(<LogsScreen onClose={jest.fn()} />)

  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  paths.length = 0
  answer = { file: 'gateway', lines: LINES }
  __setHttp(http)
  http.get.mockClear()
})

describe('the logs page draws what the gateway sent', () => {
  it('asks for the gateway file and paints every line it got back', async () => {
    await open()

    await waitFor(() => expect(screen.getByTestId('logs-count')).toBeTruthy())

    expect(paths[0]).toContain('file=gateway')

    for (const line of LINES) {
      expect(screen.getByText(line)).toBeTruthy()
    }

    expect(screen.queryByTestId('logs-empty')).toBeNull()
    expect(screen.queryByTestId('logs-unexpected')).toBeNull()
  })

  /**
   * The shape the neighbouring route actually answers with on a real gateway.
   * The page must not care which of the two it got.
   */
  it('draws a bare array exactly as it draws the envelope', async () => {
    answer = LINES

    await open()

    await waitFor(() => expect(screen.getByTestId('logs-count')).toBeTruthy())

    for (const line of LINES) {
      expect(screen.getByText(line)).toBeTruthy()
    }
  })

  it('calls an empty file empty, which is a fact about the gateway', async () => {
    answer = { file: 'errors', lines: [] }

    await open()

    await waitFor(() => expect(screen.getByTestId('logs-empty')).toBeTruthy())
    expect(screen.getByTestId('logs-empty')).toHaveTextContent(logStrings.empty)
  })
})

describe('the logs page says why it has nothing to show', () => {
  it('offers the command when the gateway has no such route', async () => {
    answer = () => {
      throw Object.assign(new Error('HTTP 404'), { status: 404 })
    }

    await open()

    await waitFor(() => expect(screen.getByTestId('logs-absent')).toBeTruthy())
    expect(screen.getByTestId('logs-command')).toHaveTextContent(logStrings.command)
  })

  /**
   * The bug this round is about. The route answered; the client did not
   * understand it; the page used to say the log was empty.
   */
  it('names what came back rather than calling the log empty', async () => {
    answer = { status: 'ok', detail: 'nothing to see' }

    await open()

    await waitFor(() => expect(screen.getByTestId('logs-unexpected')).toBeTruthy())

    // The keys are in the sentence, because that is what a reader passes on to
    // whoever runs the gateway.
    expect(screen.getByTestId('logs-unexpected')).toHaveTextContent(/status/u)
    expect(screen.getByTestId('logs-unexpected-command')).toHaveTextContent(logStrings.unexpectedCommand)

    // And it is NOT the empty state, which would have been a claim about a file
    // this page never read.
    expect(screen.queryByTestId('logs-empty')).toBeNull()
    expect(screen.queryByTestId('logs-count')).toBeNull()
  })

  /**
   * FastAPI's `detail` is the actionable half of a 4xx and the page used to
   * drop it, so "Unknown log file: desktop" arrived as "failed with HTTP 400".
   */
  it('keeps the gateway’s own sentence on an ordinary refusal', async () => {
    answer = () => {
      throw Object.assign(new Error('GET /api/logs failed with HTTP 400.'), {
        status: 400,
        hint: 'Unknown log file: desktop'
      })
    }

    await open()

    await waitFor(() => expect(screen.getByTestId('logs-error')).toBeTruthy())
    expect(screen.getByTestId('logs-error')).toHaveTextContent(/Unknown log file: desktop/u)
  })
})
