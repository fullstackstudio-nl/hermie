/**
 * The routine detail screen, against a hand-written controller.
 *
 * The screen owns no gateway knowledge, so what is worth asserting is that each
 * button reaches the right controller call, that Pause flips to Resume from the
 * store's state rather than from a local toggle, and that Delete goes through a
 * confirmation first.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import { type CronController, CronDetailScreen, type CronJob, cronJobFromRow } from '../src/features/cron'
import { useCronStore } from '../src/store/cron'

const job = (overrides: Record<string, unknown> = {}): CronJob =>
  cronJobFromRow({
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
    ...overrides
  })

function fakeController() {
  return {
    loadDetail: jest.fn(async () => job()),
    loadRuns: jest.fn(async () => []),
    loadRunTranscript: jest.fn(async () => []),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    runNow: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined)
  }
}

const render = (controller: ReturnType<typeof fakeController>, target: CronJob = job(), props = {}) =>
  renderScreen(
    <CronDetailScreen
      controller={controller as unknown as CronController}
      job={target}
      onClose={jest.fn()}
      onDeleted={jest.fn()}
      onEdit={jest.fn()}
      onOpenRun={jest.fn()}
      {...props}
    />
  )

beforeEach(() => {
  useCronStore.getState().reset()
})

it('reads the full job and its runs when it opens', async () => {
  const controller = fakeController()
  render(controller)

  await waitFor(() => expect(controller.loadDetail).toHaveBeenCalled())
  expect(controller.loadRuns).toHaveBeenCalled()
})

it('runs the routine now', async () => {
  const controller = fakeController()
  render(controller)

  fireEvent.press(screen.getByTestId('cron-run-now'))

  await waitFor(() => expect(controller.runNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-heartbeat' })))
})

it('pauses an active routine', async () => {
  const controller = fakeController()
  render(controller)

  expect(screen.getByTestId('cron-toggle-pause')).toHaveTextContent('Pause')
  fireEvent.press(screen.getByTestId('cron-toggle-pause'))

  await waitFor(() => expect(controller.pause).toHaveBeenCalled())
  expect(controller.resume).not.toHaveBeenCalled()
})

it('offers Resume for a paused routine', async () => {
  const controller = fakeController()
  const paused = job({ enabled: false, state: 'paused', next_run_at: null })
  controller.loadDetail = jest.fn(async () => paused)
  render(controller, paused)

  expect(screen.getByTestId('cron-toggle-pause')).toHaveTextContent('Resume')
  fireEvent.press(screen.getByTestId('cron-toggle-pause'))

  await waitFor(() => expect(controller.resume).toHaveBeenCalled())
})

it('asks before it deletes', async () => {
  const controller = fakeController()
  const onDeleted = jest.fn()
  render(controller, job(), { onDeleted })

  fireEvent.press(screen.getByTestId('cron-delete'))

  expect(controller.remove).not.toHaveBeenCalled()
  expect(screen.getByText('Delete “VM heartbeat”?')).toBeTruthy()

  fireEvent.press(screen.getByTestId('cron-delete-confirm'))

  await waitFor(() => expect(controller.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-heartbeat' })))
  await waitFor(() => expect(onDeleted).toHaveBeenCalled())
})

it('paints the detail read once it lands, prompt and all', async () => {
  const controller = fakeController()
  controller.loadDetail = jest.fn(async () => {
    const full = job({ prompt: 'Check the VM, summarize disk and memory.' })

    useCronStore.getState().setDetail(full)

    return full
  })
  render(controller)

  await waitFor(() =>
    expect(screen.getByTestId('cron-detail-prompt')).toHaveTextContent('Check the VM, summarize disk and memory.')
  )
})

it('opens a run', async () => {
  const controller = fakeController()
  const onOpenRun = jest.fn()
  const run = {
    id: 'cron_job-heartbeat_1700000000',
    title: 'VM heartbeat',
    status: 'ok',
    started_at: Math.floor(Date.now() / 1000) - 3_600,
    ended_at: null,
    last_active: Math.floor(Date.now() / 1000) - 3_600,
    message_count: 3,
    preview: 'Done.'
  }
  controller.loadRuns = jest.fn(async () => {
    useCronStore.getState().setRuns('job-heartbeat', [
      {
        id: run.id,
        startedAt: run.started_at,
        endedAt: null,
        lastActive: run.last_active,
        status: 'ok',
        messageCount: 3,
        preview: 'Done.',
        title: 'VM heartbeat'
      }
    ])

    return []
  })
  render(controller, job(), { onOpenRun })

  const row = await screen.findByLabelText('VM heartbeat')

  fireEvent.press(row)

  expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }))
})
