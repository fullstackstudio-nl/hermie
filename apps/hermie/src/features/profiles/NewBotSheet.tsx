/**
 * The New-bot form.
 *
 * A bottom sheet rather than a pushed screen, for the reason the cron editor
 * gives: the list stays visible behind it, and the sheet is the one modal idiom
 * that works on all four targets.
 *
 * The handle is validated AS IT IS TYPED, against a transcription of upstream's
 * own validator (`profile-name.ts`). That is not a nicety — `profiles.create`
 * refuses four different ways and each refusal comes back as a Python exception
 * message, so without this the reader learns that `My Bot` is illegal only
 * after a round trip, from a sentence that ends with a shell command.
 *
 * **There is no display-name field**, and the omission is deliberate: no method
 * in the vendored contract writes one. `ProfileRow.display_name` is read-only,
 * `profiles.create` has no such parameter and neither does `profiles.configure`
 * — so a field here could only ever have been a lie. The handle is what the
 * roster shows until the gateway grows a way to set the other.
 */
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'

import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { Button, InsetGroup, InsetRow, Text, TextField } from '../../ui/primitives'
import { SegmentedRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { checkProfileName } from './profile-name'
import { EMPTY_NEW_BOT_DRAFT, type NewBotDraft } from './profiles-controller'
import { profileStrings } from './strings'

/** One entry in the model picker: what to show, and the pair to send. */
export interface ModelChoice {
  label: string
  model: string
  provider: string
}

export interface NewBotSheetProps {
  visible: boolean
  /** Handles already on the roster, so a collision is caught in the field. */
  taken: readonly string[]
  /** Bots that can be cloned from. Empty hides the picker. */
  cloneable?: readonly string[]
  /** From `model.options`. Empty hides the picker and inherits. */
  models?: readonly ModelChoice[]
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onCreate: (draft: NewBotDraft) => void
}

export function NewBotSheet({
  visible,
  taken,
  cloneable = [],
  models = [],
  busy = false,
  error = null,
  onCancel,
  onCreate
}: NewBotSheetProps) {
  const theme = useTheme()
  const [raw, setRaw] = useState('')
  const [draft, setDraft] = useState<NewBotDraft>({ ...EMPTY_NEW_BOT_DRAFT })
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    // Re-seed on every open: a sheet that reopened holding the last attempt's
    // half-typed handle would look like it had failed to close.
    if (visible) {
      setRaw('')
      setDraft({ ...EMPTY_NEW_BOT_DRAFT })
      setTouched(false)
    }
  }, [visible])

  const verdict = useMemo(() => checkProfileName(raw, taken), [raw, taken])

  const submit = () => {
    setTouched(true)

    if (!verdict.ok || busy) {
      return
    }

    onCreate({ ...draft, handle: verdict.handle })
  }

  return (
    <BottomSheet
      accessibilityLabel={profileStrings.new.title}
      onRequestClose={onCancel}
      testID="new-bot"
      visible={visible}
    >
      <View style={{ gap: theme.space.xl }}>
        <View style={{ gap: theme.space.xs }}>
          <SheetEyebrow>{profileStrings.new.eyebrow}</SheetEyebrow>
          <Text variant="sheetTitle">{profileStrings.new.title}</Text>
        </View>

        <InsetGroup
          footer={
            <Text color="textMuted" variant="meta">
              {verdict.warning ?? profileStrings.new.handleHint}
            </Text>
          }
        >
          <InsetRow>
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              error={touched || raw ? verdict.error : null}
              label={profileStrings.new.handle}
              onChangeText={setRaw}
              onSubmitEditing={submit}
              placeholder={profileStrings.new.handlePlaceholder}
              testID="new-bot-handle"
              value={raw}
            />
          </InsetRow>

          <InsetRow>
            <TextField
              label={profileStrings.new.description}
              multiline
              numberOfLines={2}
              onChangeText={description => setDraft(current => ({ ...current, description }))}
              placeholder={profileStrings.new.descriptionPlaceholder}
              style={{ minHeight: 56, textAlignVertical: 'top' }}
              testID="new-bot-description"
              value={draft.description}
            />
          </InsetRow>
        </InsetGroup>

        {models.length ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {profileStrings.new.modelHint}
              </Text>
            }
          >
            <InsetRow>
              <SegmentedRow
                label={profileStrings.new.model}
                onChange={value =>
                  setDraft(current => {
                    const picked = models.find(choice => choice.label === value)

                    return { ...current, model: picked?.model ?? '', provider: picked?.provider ?? '' }
                  })
                }
                options={[
                  { value: profileStrings.new.modelInherit, label: profileStrings.new.modelInherit },
                  ...models.map(choice => ({ value: choice.label, label: choice.label }))
                ]}
                testID="new-bot-model"
                value={models.find(choice => choice.model === draft.model)?.label ?? profileStrings.new.modelInherit}
              />
            </InsetRow>
          </InsetGroup>
        ) : null}

        {cloneable.length ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {profileStrings.new.cloneHint}
              </Text>
            }
          >
            <InsetRow>
              <SegmentedRow
                label={profileStrings.new.cloneFrom}
                onChange={value =>
                  setDraft(current => ({
                    ...current,
                    cloneFrom: value === profileStrings.new.cloneNone ? null : value
                  }))
                }
                options={[
                  { value: profileStrings.new.cloneNone, label: profileStrings.new.cloneNone },
                  ...cloneable.map(name => ({ value: name, label: name }))
                ]}
                testID="new-bot-clone"
                value={draft.cloneFrom ?? profileStrings.new.cloneNone}
              />
            </InsetRow>
          </InsetGroup>
        ) : null}

        {error ? (
          <Text color="dangerText" testID="new-bot-error" variant="meta">
            {profileStrings.new.failed(error)}
          </Text>
        ) : null}

        <Button
          busy={busy}
          disabled={!verdict.ok}
          onPress={submit}
          testID="new-bot-create"
          title={profileStrings.new.create}
        />
        <Button onPress={onCancel} title={profileStrings.new.cancel} variant="secondary" />
      </View>
    </BottomSheet>
  )
}
