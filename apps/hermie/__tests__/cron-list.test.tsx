/**
 * The Routines list, driven end to end through the real controller and store
 * with a hand-written connection underneath. What is worth pinning here is the
 * reading of the gateway's answer rather than the pixels: which section a job
 * lands in, that `gateway_running: false` raises the banner, and that a
 * scheduler exception is shown as its first sentence rather than as a stack.
 */
import { screen, waitFor } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import { CronScreen } from '../src/features/cron'
import { useCronStore } from '../src/store/cron'

const mockRequest = jest.fn()
const mockHttpGet = jest.fn()

// One frozen value, the way `GatewayProvider` hands one out: the connection and
// its `http` are refs there, and a fresh object per render would restart the
// controller on every paint.
jest.mock('../src/gateway', () => {
  const http = { get: (...args: unknown[]) => mockHttpGet(...args) }
  const connection = {
    request: (...args: unknown[]) => mockRequest(...args),
    on: () => () => undefined,
    onAny: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined,
    http
  }

  return { useGateway: () => ({ connection, http }) }
})

const JOBS = [
  {
    job_id: 'job-heartbeat',
    name: 'VM heartbeat',
    schedule: 'every 2h',
    prompt_preview: 'Check the VM.',
    deliver: 'local',
    enabled: true,
    state: 'active',
    next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
    last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
    last_status: 'ok',
    last_error: null
  },
  {
    job_id: 'job-digest',
    name: 'Weekly digest',
    schedule: 'weekdays at 9am',
    prompt_preview: 'Write the digest.',
    deliver: 'bot-chat:researcher',
    enabled: true,
    state: 'active',
    next_run_at: null,
    last_run_at: new Date(Date.now() - 7_200_000).toISOString(),
    last_status: 'error',
    last_error: "RuntimeError: Cron job 'Weekly digest' has no model configured. Set one with `hermes cron edit`."
  },
  {
    job_id: 'job-cleanup',
    name: 'Inbox cleanup',
    schedule: 'every day at 6pm',
    prompt_preview: 'Archive what is answered.',
    deliver: 'local',
    enabled: false,
    state: 'paused',
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null
  }
]

function answerWith(gatewayRunning: boolean): void {
  mockRequest.mockImplementation(async (method: string) => {
    if (method === 'cron.manage') {
      return { success: true, jobs: JOBS, count: JOBS.length, gateway_running: gatewayRunning }
    }

    return {}
  })
}

beforeEach(() => {
  useCronStore.getState().reset()
  mockRequest.mockReset()
  mockHttpGet.mockReset()
  mockHttpGet.mockResolvedValue({ targets: [{ id: 'local', name: 'Local (save only)' }] })
  answerWith(true)
})

it('asks for the disabled jobs too, or the Paused section could never fill', async () => {
  renderScreen(<CronScreen />)

  await waitFor(() => expect(mockRequest).toHaveBeenCalled())

  expect(mockRequest).toHaveBeenCalledWith('cron.manage', { action: 'list', include_disabled: true }, undefined)
})

it('splits the list into Active and Paused', async () => {
  renderScreen(<CronScreen />)

  expect(await screen.findByText('VM heartbeat')).toBeTruthy()
  expect(screen.getByText('ACTIVE')).toBeTruthy()
  expect(screen.getByText('PAUSED')).toBeTruthy()
  expect(screen.getByText('Inbox cleanup')).toBeTruthy()

  // The paused job carries the paused dot, not the "never run" one.
  expect(screen.getAllByTestId('cron-status-paused')).toHaveLength(1)
  expect(screen.getAllByTestId('cron-status-ok')).toHaveLength(1)
  expect(screen.getAllByTestId('cron-status-failed')).toHaveLength(1)
})

it('renders the schedule as a sentence and the next run as a relative time', async () => {
  renderScreen(<CronScreen />)

  expect(await screen.findByText('Every 2 hours')).toBeTruthy()
  expect(screen.getByText('Next: in 2h')).toBeTruthy()
  // Nothing scheduled must not read as "now".
  expect(screen.getAllByText('Not scheduled').length).toBeGreaterThan(0)
})

it('shows the first sentence of a scheduler exception, not the class name', async () => {
  renderScreen(<CronScreen />)

  const error = await screen.findByTestId('cron-error-job-digest')

  expect(error).toHaveTextContent("Cron job 'Weekly digest' has no model configured.")
  expect(error).not.toHaveTextContent('RuntimeError')
})

it('raises the banner when the scheduler process is down', async () => {
  answerWith(false)
  renderScreen(<CronScreen />)

  expect(await screen.findByText('Routines will not run: the Hermes gateway process is not running')).toBeTruthy()
})

it('keeps the banner down while the gateway says the scheduler is up', async () => {
  renderScreen(<CronScreen />)

  await screen.findByText('VM heartbeat')

  expect(screen.queryByTestId('cron-gateway-banner')).toBeNull()
})

it('explains a failed list read instead of showing an empty list', async () => {
  mockRequest.mockRejectedValue(new Error('socket closed'))
  renderScreen(<CronScreen />)

  expect(await screen.findByText('Could not load the routines: socket closed')).toBeTruthy()
})
