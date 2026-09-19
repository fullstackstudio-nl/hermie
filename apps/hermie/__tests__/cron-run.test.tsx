/**
 * A routine run is read through the chat engine, not through a second one.
 *
 * The point of these two tests is that `session.history` rows for a cron
 * session go through `rowsToItems` → `visibleItems` → `TranscriptList` exactly
 * as a conversation's do, and that nothing offers to continue the run: a cron
 * session has no live agent behind it.
 */
import { screen, waitFor } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import { CronRunScreen, cronJobFromRow, type CronController, type CronRun } from '../src/features/cron'

const JOB = cronJobFromRow({
  job_id: 'job-heartbeat',
  name: 'VM heartbeat',
  schedule: 'every 2h',
  prompt_preview: 'Check the VM.',
  enabled: true
})

const RUN: CronRun = {
  id: 'cron_job-heartbeat_1700000000',
  startedAt: Math.floor(Date.now() / 1000) - 3_600,
  endedAt: null,
  lastActive: Math.floor(Date.now() / 1000) - 3_600,
  status: 'ok',
  messageCount: 3,
  preview: 'Done.',
  title: 'VM heartbeat'
}

const ROWS = [
  { role: 'user', text: 'Check the VM and report.', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'Disk is at 41%, nothing unusual.', row_id: 2, timestamp: 1_700_000_012 }
]

function controllerWith(rows: unknown[]): CronController {
  return {
    loadRunTranscript: jest.fn(async () => rows)
  } as unknown as CronController
}

it('reads the run with its own session id and renders the transcript', async () => {
  const controller = controllerWith(ROWS)

  renderScreen(<CronRunScreen controller={controller} job={JOB} onClose={jest.fn()} run={RUN} />)

  expect(await screen.findByText('Check the VM and report.')).toBeTruthy()
  expect(screen.getByText('Disk is at 41%, nothing unusual.')).toBeTruthy()
  expect(controller.loadRunTranscript).toHaveBeenCalledWith(RUN.id, null)
})

it('says the run is read-only and offers no composer', async () => {
  renderScreen(<CronRunScreen controller={controllerWith(ROWS)} job={JOB} onClose={jest.fn()} run={RUN} />)

  await screen.findByText('Check the VM and report.')

  expect(screen.getByText('Read-only: a routine run cannot be continued from here.')).toBeTruthy()
  expect(screen.queryByTestId('composer-input')).toBeNull()
})

it('says so when the run has no transcript', async () => {
  renderScreen(<CronRunScreen controller={controllerWith([])} job={JOB} onClose={jest.fn()} run={RUN} />)

  await waitFor(() => expect(screen.getByText('This run recorded no messages.')).toBeTruthy())
})
