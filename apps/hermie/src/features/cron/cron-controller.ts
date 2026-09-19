/**
 * Everything Routines needs from the gateway.
 *
 * The cron surface is split across two transports and the split is not
 * arbitrary, so it is worth stating once instead of guessing at each call site:
 *
 * - The **list** is WS `cron.manage {action:'list', include_disabled:true}`.
 *   It is the only call that answers `gateway_running`, which is what tells the
 *   screen whether the scheduler process is alive, and the only one that
 *   reports jobs across every profile in one round trip.
 * - **Pause and resume** are WS `cron.manage` too. Both surfaces can do it;
 *   picking one and staying there means one code path to reason about, and the
 *   WS one is the surface the list already trusts.
 * - **Everything else** is HTTP on the same origin, because it has no WS
 *   equivalent: the full prompt (`GET`), edits (`PUT {updates}`), deletion,
 *   `trigger`, the run history, and the delivery targets.
 *
 * Creation is WS `cron.manage {action:'add'}` rather than `POST /api/cron/jobs`
 * — the same reason as pause/resume: it is the surface whose answer already
 * carries the refreshed job list.
 *
 * Mutations do not patch the store optimistically. Every one of them makes the
 * gateway broadcast `cron.changed`, and the debounced refetch that follows is
 * the truth — including `next_run_at`, which only the server can compute.
 */
import type { CronJobRow } from '@hermes/shared/gateway-contract'
import type { GatewayHttp } from '@hermie/gateway-client'
import type { TranscriptRow } from '@hermie/transcript'

import type { ChatGateway } from '../../gateway/link'
import type { CronState } from '../../store/cron'
import {
  type CronDeliveryTarget,
  cronJobFromRow,
  type CronJob,
  type CronRun,
  cronRunFromRow,
  deliveryTargetFromRow
} from './model'

/** `cron.changed` fires about once per scheduler tick; coalesce a burst. */
export const CRON_CHANGED_DEBOUNCE_MS = 750

/** How many run sessions the detail screen asks for. */
export const RUN_HISTORY_LIMIT = 20

type StoreApi<T> = {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

export interface CronControllerOptions {
  gateway: ChatGateway
  /** The REST half. Null on a connection that has not come up yet. */
  http: GatewayHttp | null
  store: StoreApi<CronState>
  debounceMs?: number
}

export interface CronJobInput {
  name: string
  prompt: string
  schedule: string
  deliver: string
  repeat?: number
}

export class CronController {
  private readonly gateway: ChatGateway
  private readonly http: GatewayHttp | null
  private readonly store: StoreApi<CronState>
  private readonly debounceMs: number

  private unsubscribe: (() => void) | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<CronJob[]> | null = null

  constructor(options: CronControllerOptions) {
    this.gateway = options.gateway
    this.http = options.http ?? null
    this.store = options.store
    this.debounceMs = options.debounceMs ?? CRON_CHANGED_DEBOUNCE_MS
  }

  /** Subscribe to `cron.changed` and take a first reading. */
  start(): void {
    this.unsubscribe?.()
    this.unsubscribe = this.gateway.on('cron.changed', () => this.scheduleRefresh())
    void this.refresh().catch(() => undefined)
    void this.loadDeliveryTargets()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.refresh().catch(() => undefined)
    }, this.debounceMs)
  }

  /** Re-read the list. Concurrent callers share one round trip. */
  refresh(): Promise<CronJob[]> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const run = this.loadList().finally(() => {
      this.refreshInFlight = null
    })

    this.refreshInFlight = run

    return run
  }

  private async loadList(): Promise<CronJob[]> {
    this.store.getState().setLoading(true)

    try {
      const result = await this.gateway.request('cron.manage', { action: 'list', include_disabled: true })
      const rows: CronJobRow[] = result?.jobs ?? []
      const jobs = rows.map(cronJobFromRow)
      // `gateway_running` is only meaningful when the call itself succeeded;
      // an absent flag stays unknown rather than becoming "not running".
      const running = typeof result?.gateway_running === 'boolean' ? result.gateway_running : null

      this.store.getState().setJobs(jobs, running)

      return jobs
    } catch (error) {
      this.store.getState().setError(messageOf(error))

      throw error
    } finally {
      this.store.getState().setLoading(false)
    }
  }

  /** The full job, including the prompt the list row only previews. */
  async loadDetail(job: Pick<CronJob, 'id' | 'profile'>): Promise<CronJob> {
    const body = await this.get<Record<string, unknown>>(this.jobPath(job))
    const detail = cronJobFromRow(unwrapJob(body))
    const merged: CronJob = { ...detail, ...(detail.profile ? {} : { profile: job.profile }) }

    this.store.getState().setDetail(merged)

    return merged
  }

  async loadRuns(job: Pick<CronJob, 'id' | 'profile'>): Promise<CronRun[]> {
    const body = await this.get<Record<string, unknown>>(
      this.jobPath(job, '/runs', { limit: String(RUN_HISTORY_LIMIT) })
    )
    const rows = Array.isArray(body?.runs) ? body.runs : []
    const runs = rows.filter(isRecord).map(cronRunFromRow)

    this.store.getState().setRuns(job.id, runs)

    return runs
  }

  async loadDeliveryTargets(): Promise<CronDeliveryTarget[]> {
    try {
      const body = await this.get<Record<string, unknown>>('/api/cron/delivery-targets')
      const rows = Array.isArray(body?.targets) ? body.targets : []
      const targets = rows.filter(isRecord).map(deliveryTargetFromRow)

      this.store.getState().setDeliveryTargets(targets.length ? targets : [LOCAL_TARGET])

      return targets
    } catch {
      // A gateway that cannot list its targets still delivers locally, and an
      // editor with one option beats an editor that refuses to open.
      this.store.getState().setDeliveryTargets([LOCAL_TARGET])

      return [LOCAL_TARGET]
    }
  }

  /** The transcript of one run session. Runs are sessions `cron_{job}_{ts}`. */
  async loadRunTranscript(runId: string, profile: string | null): Promise<TranscriptRow[]> {
    const result = await this.gateway.request('session.history', {
      session_id: runId,
      ...(profile ? { profile } : {})
    })

    return (result?.messages ?? []) as TranscriptRow[]
  }

  pause(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    return this.manage(job, 'pause')
  }

  resume(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    return this.manage(job, 'resume')
  }

  private async manage(job: Pick<CronJob, 'id' | 'profile'>, action: 'pause' | 'resume'): Promise<void> {
    await this.mutate(job.id, async () => {
      const result = await this.gateway.request('cron.manage', {
        action,
        name: job.id,
        ...(job.profile ? { profile: job.profile } : {})
      })

      if (result?.success === false) {
        throw new Error(result.error ?? `The gateway refused to ${action} this routine.`)
      }
    })
  }

  /** `POST .../trigger` — fire the job now; the gateway answers the refreshed job. */
  async runNow(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    await this.mutate(job.id, async () => {
      await this.post(this.jobPath(job, '/trigger'))
    })
  }

  async create(input: CronJobInput): Promise<void> {
    const result = await this.gateway.request('cron.manage', {
      action: 'add',
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      deliver: input.deliver,
      ...(input.repeat === undefined ? {} : { repeat: input.repeat })
    })

    if (result?.success === false) {
      throw new Error(result.error ?? 'The gateway refused the routine.')
    }

    await this.refresh()
  }

  /** `PUT {updates}` — a merge, not a replace; untouched fields keep their value. */
  async update(job: Pick<CronJob, 'id' | 'profile'>, input: CronJobInput): Promise<CronJob> {
    return this.mutate(job.id, async () => {
      const body = await this.put<Record<string, unknown>>(this.jobPath(job), {
        updates: {
          name: input.name,
          schedule: input.schedule,
          prompt: input.prompt,
          deliver: input.deliver,
          ...(input.repeat === undefined ? {} : { repeat: input.repeat })
        }
      })

      const updated = cronJobFromRow(unwrapJob(body))
      const merged: CronJob = { ...updated, ...(updated.profile ? {} : { profile: job.profile }) }

      this.store.getState().setDetail(merged)

      return merged
    })
  }

  async remove(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    await this.mutate(job.id, async () => {
      await this.delete(this.jobPath(job))
      this.store.getState().removeJob(job.id)
    })
  }

  /** Run one mutation with the row marked busy and failures surfaced. */
  private async mutate<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    this.store.getState().setBusy(jobId, true)

    try {
      const value = await run()
      // The broadcast will land too, debounced; this is the immediate one, so a
      // tap does not look ignored for three quarters of a second.
      await this.refresh().catch(() => undefined)

      return value
    } catch (error) {
      this.store.getState().setError(messageOf(error))

      throw error
    } finally {
      this.store.getState().setBusy(jobId, false)
    }
  }

  private jobPath(job: Pick<CronJob, 'id' | 'profile'>, suffix = '', extra: Record<string, string> = {}): string {
    const query = new URLSearchParams(extra)

    // A profile-scoped job lives in that profile's cron store; without the
    // parameter the gateway looks in the default one and answers 404.
    if (job.profile) {
      query.set('profile', job.profile)
    }

    const search = query.toString()

    return `/api/cron/jobs/${encodeURIComponent(job.id)}${suffix}${search ? `?${search}` : ''}`
  }

  private get<T>(path: string): Promise<T> {
    return this.requireHttp().get<T>(path)
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.requireHttp().post<T>(path, body ?? {})
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.requireHttp().put<T>(path, body)
  }

  private delete<T>(path: string): Promise<T> {
    return this.requireHttp().delete<T>(path)
  }

  private requireHttp(): GatewayHttp {
    if (!this.http) {
      throw new Error('There is no gateway connection yet.')
    }

    return this.http
  }
}

const LOCAL_TARGET: CronDeliveryTarget = { id: 'local', name: 'Local (save only)', homeTargetSet: true }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * The job out of a detail/update response.
 *
 * `hermes serve` answers these with the stored job itself; a `{job: …}` wrapper
 * shows up on other builds, so both are accepted rather than one being declared
 * correct.
 */
function unwrapJob(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) {
    return {}
  }

  return isRecord(body.job) ? body.job : body
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
