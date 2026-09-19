/**
 * Crons: the list, and the stack that hangs off it.
 *
 * NAVIGATION. This is one screen with early-return sub-screens, the same shape
 * Settings uses for its connection test and gallery. It is not a navigator on
 * purpose: the compact and regular shells own their own navigation and disagree
 * about what "push" means, and a feature that carries its own three-deep stack
 * works identically in both.
 *
 * The list itself is the HTTP `GET /api/cron/jobs?profile=all` answer, split
 * into Active and Paused, and it spans every profile — see the controller for
 * why the socket cannot do that. Its banner is the one thing on the screen that
 * is not about a single job: `gateway_running === false` means the scheduler
 * process is down, and every cron below is then a plan rather than a promise.
 */
import { useCallback, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, View } from 'react-native'

import { useBotsStore } from '../../store/bots'
import { useCronStore } from '../../store/cron'
import { Screen, Text } from '../../ui/primitives'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import type { CronJobInput } from './cron-controller'
import { CronDetailScreen } from './CronDetailScreen'
import { CronEditorSheet } from './CronEditorSheet'
import { CronRunScreen } from './CronRunScreen'
import {
  type CronJob,
  type CronRun,
  cronStatusLabel,
  cronStatusOf,
  lastErrorSummary,
  relativeTime,
  scheduleText
} from './model'
import { StatusDot } from './StatusDot'
import { cronStrings } from './strings'
import { useCronController } from './useCron'

type CronView =
  { screen: 'list' } | { screen: 'detail'; jobId: string } | { screen: 'run'; jobId: string; run: CronRun }

export function CronScreen() {
  const theme = useTheme()
  const controller = useCronController()
  const jobs = useCronStore(state => state.jobs)
  const loading = useCronStore(state => state.loading)
  const error = useCronStore(state => state.error)
  const gatewayRunning = useCronStore(state => state.gatewayRunning)
  const targets = useCronStore(state => state.deliveryTargets)
  const bots = useBotsStore(state => state.bots)

  // The roster IS the profile list — a bot is a Hermes profile — and a gateway
  // that serves one of them gets no picker rather than a picker with one option.
  const profiles = useMemo(() => (bots.length > 1 ? bots.map(bot => bot.name) : []), [bots])

  const [view, setView] = useState<CronView>({ screen: 'list' })
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<{ open: boolean; job: CronJob | null }>({ open: false, job: null })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await controller?.refresh()
    } catch {
      // The store holds the message; the list keeps the rows it had.
    } finally {
      setRefreshing(false)
    }
  }, [controller])

  const save = useCallback(
    async (input: CronJobInput) => {
      setSaving(true)
      setSaveError(null)

      try {
        if (editing.job) {
          await controller?.update(editing.job, input)
        } else {
          await controller?.create(input)
        }

        setEditing({ open: false, job: null })
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    },
    [controller, editing.job]
  )

  const sections = useMemo(() => {
    const active = jobs.filter(job => cronStatusOf(job) !== 'paused')
    const paused = jobs.filter(job => cronStatusOf(job) === 'paused')

    return [
      ...(active.length ? [{ title: cronStrings.sections.active, data: active }] : []),
      ...(paused.length ? [{ title: cronStrings.sections.paused, data: paused }] : [])
    ]
  }, [jobs])

  // The REST list tags EVERY row with its store, so on a single-profile gateway
  // each one would read "Profile: default" — a column of the same word. It is
  // shown only where it tells two rows apart.
  const showProfiles = useMemo(() => new Set(jobs.map(job => job.profile)).size > 1, [jobs])

  const selected = view.screen === 'list' ? null : (jobs.find(job => job.id === view.jobId) ?? null)

  // Escape goes back ONE level. A sub page registers on top of whatever is
  // already holding the key — the overlay panel on the wide layout — so the
  // first Escape returns to the list here and only the second closes the panel
  // around it. Mount order does the ordering; see `useEscapeKey`.
  useEscapeKey(
    () =>
      setView(current => (current.screen === 'run' ? { screen: 'detail', jobId: current.jobId } : { screen: 'list' })),
    view.screen !== 'list'
  )

  if (view.screen === 'run' && selected) {
    return (
      <CronRunScreen
        controller={controller}
        job={selected}
        onClose={() => setView({ screen: 'detail', jobId: selected.id })}
        run={view.run}
      />
    )
  }

  if (view.screen !== 'list' && selected) {
    return (
      <>
        <CronDetailScreen
          controller={controller}
          job={selected}
          onClose={() => setView({ screen: 'list' })}
          onDeleted={() => setView({ screen: 'list' })}
          onEdit={job => {
            setSaveError(null)
            setEditing({ open: true, job })
          }}
          onOpenRun={run => setView({ screen: 'run', jobId: selected.id, run })}
        />
        <CronEditorSheet
          error={saveError}
          job={editing.job}
          onCancel={() => setEditing({ open: false, job: null })}
          onSave={input => void save(input)}
          profiles={profiles}
          saving={saving}
          targets={targets}
          visible={editing.open}
        />
      </>
    )
  }

  return (
    <Screen padded={false}>
      <SectionList
        ListEmptyComponent={<EmptyState error={error} loading={loading} />}
        ListHeaderComponent={
          <ListHeader gatewayRunning={gatewayRunning} onCreate={() => setEditing({ open: true, job: null })} />
        }
        keyExtractor={job => job.id}
        refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
        renderItem={({ item }) => (
          <RoutineRow
            job={item}
            onPress={() => setView({ screen: 'detail', jobId: item.id })}
            showProfile={showProfiles}
          />
        )}
        renderSectionHeader={({ section }) => (
          <Text
            color="textMuted"
            style={{
              backgroundColor: theme.elevation.e0,
              fontWeight: '700',
              letterSpacing: 1.1,
              paddingHorizontal: theme.space.lg,
              paddingTop: theme.space.lg,
              paddingBottom: theme.space.xs
            }}
            variant="meta"
          >
            {section.title}
          </Text>
        )}
        sections={sections}
        stickySectionHeadersEnabled={false}
        testID="cron-list"
      />

      <CronEditorSheet
        error={saveError}
        job={editing.job}
        onCancel={() => setEditing({ open: false, job: null })}
        onSave={input => void save(input)}
        profiles={profiles}
        saving={saving}
        targets={targets}
        visible={editing.open}
      />
    </Screen>
  )
}

function ListHeader({ gatewayRunning, onCreate }: { gatewayRunning: boolean | null; onCreate: () => void }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm, paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm }}>
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
        <View style={{ flex: 1, gap: theme.space.xxs }}>
          <Text variant="title">{cronStrings.title}</Text>
          <Text color="textMuted" variant="preview">
            {cronStrings.subtitle}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cronStrings.list.add}
          onPress={onCreate}
          style={{
            backgroundColor: theme.elevation.e2,
            borderRadius: theme.radii.pill,
            justifyContent: 'center',
            minHeight: CONTROL_MIN_HEIGHT,
            paddingHorizontal: theme.space.lg
          }}
          testID="cron-create"
        >
          <Text color="accent" variant="preview">
            {`+ ${cronStrings.list.add}`}
          </Text>
        </Pressable>
      </View>

      {gatewayRunning === false ? (
        <View
          style={{
            backgroundColor: theme.elevation.e3c,
            borderColor: theme.colors.danger,
            borderRadius: theme.radii.lg,
            borderWidth: 1,
            padding: theme.space.md
          }}
          testID="cron-gateway-banner"
        >
          <Text color="dangerText" variant="preview">
            {cronStrings.gatewayBanner}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function EmptyState({ loading, error }: { loading: boolean; error: string | null }) {
  const theme = useTheme()

  return (
    <View style={{ padding: theme.space.lg }}>
      <Text color={error ? 'dangerText' : 'textMuted'}>
        {error ? cronStrings.list.failed(error) : loading ? cronStrings.list.loading : cronStrings.list.empty}
      </Text>
    </View>
  )
}

function RoutineRow({ job, onPress, showProfile }: { job: CronJob; onPress: () => void; showProfile: boolean }) {
  const theme = useTheme()
  const status = cronStatusOf(job)
  const nextRun = relativeTime(job.nextRunAt)
  const summary = lastErrorSummary(job.lastError)

  // Two profiles may hold a cron of the same name, so the name alone does not
  // identify the row to somebody reading it out.
  const owner = showProfile && job.profile ? job.profile : null
  const label = owner ? `${job.name}, ${cronStrings.list.profile(owner)}` : job.name

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} testID={`cron-row-${job.id}`}>
      {({ pressed }) => (
        <View
          style={{
            backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
            borderBottomColor: theme.hairline,
            borderBottomWidth: 1,
            gap: theme.space.xs,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.md
          }}
        >
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            <Text style={{ flex: 1 }} numberOfLines={1} variant="name">
              {job.name}
            </Text>
            <StatusDot status={status} />
            <Text color="textMuted" variant="meta">
              {cronStatusLabel(status)}
            </Text>
          </View>

          <Text color="textMuted" numberOfLines={1}>
            {scheduleText(job.schedule)}
          </Text>

          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            <Text color="textMuted" style={{ flex: 1 }} variant="meta">
              {job.deliver ? `@${job.deliver}` : ''}
            </Text>
            {owner ? (
              <Text color="textMuted" variant="meta" testID={`cron-profile-${job.id}`}>
                {cronStrings.list.profile(owner)}
              </Text>
            ) : null}
            <Text color="textMuted" variant="meta">
              {nextRun ? cronStrings.list.nextRun(nextRun) : cronStrings.list.noNextRun}
            </Text>
          </View>

          {summary ? (
            <Text color="dangerText" numberOfLines={2} variant="meta" testID={`cron-error-${job.id}`}>
              {summary}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}
