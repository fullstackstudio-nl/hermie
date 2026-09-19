/**
 * The routine editor.
 *
 * A bottom sheet rather than a pushed screen, following the design board: the
 * list stays visible behind it, and the sheet is the app's one modal idiom that
 * works on all four targets (`ui/BottomSheet`).
 *
 * The sheet never predicts when the routine will next fire. It builds a
 * schedule string, the gateway parses it, and the `next_run_at` that comes back
 * is what the detail screen shows. Any countdown computed here would be in the
 * phone's timezone, and the scheduler runs in the gateway's.
 */
import { useEffect, useState } from 'react'
import { View } from 'react-native'

import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { Button, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { CronJobInput } from './cron-controller'
import type { CronDeliveryTarget, CronJob } from './model'
import { buildSchedule, DEFAULT_SCHEDULE_DRAFT, draftFromSchedule, type ScheduleDraft } from './schedule'
import { ScheduleBuilder } from './ScheduleBuilder'
import { cronStrings } from './strings'

export interface CronEditorSheetProps {
  visible: boolean
  /** Null creates a routine; a job edits it. */
  job: CronJob | null
  targets: readonly CronDeliveryTarget[]
  saving?: boolean
  error?: string | null
  onCancel: () => void
  onSave: (input: CronJobInput) => void
}

interface Draft {
  name: string
  prompt: string
  deliver: string
  schedule: ScheduleDraft
}

const emptyDraft = (): Draft => ({
  name: '',
  prompt: '',
  deliver: 'local',
  schedule: { ...DEFAULT_SCHEDULE_DRAFT }
})

const draftFor = (job: CronJob | null): Draft =>
  job
    ? {
        name: job.name,
        prompt: job.prompt || job.promptPreview,
        deliver: job.deliver || 'local',
        schedule: draftFromSchedule(job.schedule)
      }
    : emptyDraft()

export function CronEditorSheet({
  visible,
  job,
  targets,
  saving = false,
  error = null,
  onCancel,
  onSave
}: CronEditorSheetProps) {
  const theme = useTheme()
  const [draft, setDraft] = useState<Draft>(() => draftFor(job))
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    // Re-seed on every open, so editing one routine and then another does not
    // show the first one's prompt for a frame.
    if (visible) {
      setDraft(draftFor(job))
      setTouched(false)
    }
  }, [job, visible])

  const schedule = buildSchedule(draft.schedule)
  const nameError = draft.name.trim() ? null : cronStrings.editor.nameRequired
  const promptError = draft.prompt.trim() ? null : cronStrings.editor.promptRequired
  const valid = !nameError && !promptError && schedule.ok

  const submit = () => {
    setTouched(true)

    if (!valid || !schedule.ok) {
      return
    }

    onSave({
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      deliver: draft.deliver,
      schedule: schedule.schedule
    })
  }

  return (
    <BottomSheet
      visible={visible}
      onRequestClose={onCancel}
      accessibilityLabel={job ? cronStrings.editor.editTitle : cronStrings.editor.createTitle}
      testID="cron-editor"
    >
      <View style={{ gap: theme.space.lg }}>
        <View style={{ gap: theme.space.xxs }}>
          <SheetEyebrow>{job ? cronStrings.editor.editEyebrow : cronStrings.editor.createEyebrow}</SheetEyebrow>
          <Text variant="title">{job ? cronStrings.editor.editTitle : cronStrings.editor.createTitle}</Text>
        </View>

        <TextField
          label={cronStrings.editor.name}
          placeholder={cronStrings.editor.namePlaceholder}
          value={draft.name}
          onChangeText={name => setDraft(current => ({ ...current, name }))}
          error={touched ? nameError : null}
          testID="cron-editor-name"
        />

        <TextField
          label={cronStrings.editor.prompt}
          placeholder={cronStrings.editor.promptPlaceholder}
          multiline
          numberOfLines={4}
          style={{ minHeight: 96, textAlignVertical: 'top' }}
          value={draft.prompt}
          onChangeText={prompt => setDraft(current => ({ ...current, prompt }))}
          error={touched ? promptError : null}
          testID="cron-editor-prompt"
        />

        <DeliveryPicker
          targets={targets}
          value={draft.deliver}
          onChange={deliver => setDraft(current => ({ ...current, deliver }))}
        />

        <View style={{ gap: theme.space.sm }}>
          <Text variant="heading">{cronStrings.editor.schedule}</Text>
          <ScheduleBuilder
            draft={draft.schedule}
            onChange={next => setDraft(current => ({ ...current, schedule: next }))}
            showErrors={touched}
          />
        </View>

        <Text color="textMuted" variant="caption">
          {cronStrings.editor.nextRunHint}
        </Text>

        {error ? (
          <Text color="danger" variant="caption" testID="cron-editor-error">
            {cronStrings.editor.saveFailed(error)}
          </Text>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          <Button
            title={saving ? cronStrings.editor.saving : cronStrings.editor.save}
            busy={saving}
            onPress={submit}
            testID="cron-editor-save"
          />
          <Button title={cronStrings.editor.cancel} variant="secondary" onPress={onCancel} disabled={saving} />
        </View>
      </View>
    </BottomSheet>
  )
}

function DeliveryPicker({
  targets,
  value,
  onChange
}: {
  targets: readonly CronDeliveryTarget[]
  value: string
  onChange: (id: string) => void
}) {
  const theme = useTheme()
  // `local` is implicit on every gateway; it is listed even before the
  // delivery-targets call has answered, so the picker is never empty.
  const options = targets.length
    ? targets
    : [{ id: 'local', name: cronStrings.editor.deliverLocal, homeTargetSet: true }]

  return (
    <View style={{ gap: theme.space.sm }} testID="cron-editor-deliver">
      <Text color="textMuted" variant="caption">
        {cronStrings.editor.deliver}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        {options.map(target => {
          const selected = target.id === value

          return (
            <Text
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={target.id}
              onPress={() => onChange(target.id)}
              variant="callout"
              color={selected ? 'onAccent' : 'text'}
              style={{
                backgroundColor: selected ? theme.colors.bubbleBlue : theme.colors.surfaceRaised,
                borderRadius: theme.radii.pill,
                overflow: 'hidden',
                paddingHorizontal: theme.space.md,
                paddingVertical: theme.space.sm
              }}
              testID={`cron-editor-deliver-${target.id}`}
            >
              {target.name}
            </Text>
          )
        })}
      </View>
    </View>
  )
}
