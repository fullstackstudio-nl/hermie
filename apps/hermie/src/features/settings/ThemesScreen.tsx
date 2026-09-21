/**
 * Settings → Appearance → Advanced: themes the reader makes themselves.
 *
 * Three things shape this screen.
 *
 *  1. **A theme is a preset plus a few colours.** Not a palette editor. Eight
 *     elevation rungs, four bubble washes, two hairlines and a dozen inks are a
 *     system that has to stay in proportion, and handing them over one at a time
 *     is how a reader ends up with a window they cannot read. What IS handed over
 *     is the three colours that carry the composition: the floor, the accent's
 *     ring and the outgoing bubble.
 *  2. **The guard is the build's guard.** `judgeThemeColour` is the function
 *     `npm run contrast:check` measures with, so a colour this screen accepts is a
 *     colour the check accepts, and the refusal says the ratio it measured rather
 *     than "invalid".
 *  3. **One face at a time.** A theme has a light and a dark face; the face being
 *     edited is the one that is ON, and the screen says so out loud. Editing both
 *     at once would mean two of every field and a reader guessing which half of
 *     the screen they are looking at.
 */
import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useSettingsStore } from '../../store/settings'
import { judgeThemeColour, type ThemeColourField } from '../../ui/contrast'
import { Button, InsetButtonRow, InsetGroup, InsetRow, Screen, Text, TextField } from '../../ui/primitives'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { useTheme } from '../../ui/theme'
import { resolveThemeFace, THEME_PRESET_ORDER, type ThemePresetName } from '../../ui/themes'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { ThemeCard } from './ThemeCard'

const FIELDS: { field: ThemeColourField; label: string }[] = [
  { field: 'background', label: strings.settings.themes.background },
  { field: 'accentFill', label: strings.settings.themes.accentFill },
  { field: 'accentBubble', label: strings.settings.themes.accentBubble }
]

export interface ThemesScreenProps {
  onClose?: () => void
}

export function ThemesScreen({ onClose }: ThemesScreenProps) {
  const theme = useTheme()
  const userThemes = useSettingsStore(state => state.userThemes)
  const choice = useSettingsStore(state => state.themeChoice)
  const [editing, setEditing] = useState<string | null>(choice.kind === 'user' ? choice.id : null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  useEscapeKey(() => onClose?.(), Boolean(onClose))
  useHardwareBack(() => onClose?.(), Boolean(onClose))

  const target = userThemes.find(entry => entry.id === editing) ?? null

  return (
    <Screen padded={false}>
      <ScrollView
        ref={directTouchPanRef}
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
      >
        <View style={{ gap: theme.space.sm }}>
          <Text accessibilityRole="header" aria-level={1} variant="title">
            {strings.settings.themes.header}
          </Text>
          <Text color="textMuted" variant="preview">
            {strings.settings.themes.advancedHint}
          </Text>
        </View>

        <InsetGroup header={strings.settings.themes.create}>
          {THEME_PRESET_ORDER.map(preset => (
            <InsetButtonRow
              key={preset}
              onPress={() => {
                const id = useSettingsStore.getState().createUserTheme(preset, strings.settings.presetOptions[preset])

                useSettingsStore.getState().setThemeChoice({ kind: 'user', id })
                setEditing(id)
              }}
              testID={`theme-new-${preset}`}
              title={strings.settings.themes.createFrom(strings.settings.presetOptions[preset])}
            />
          ))}
        </InsetGroup>

        {userThemes.length ? (
          <View style={{ gap: theme.space.md }}>
            <Text color="textMuted" style={{ marginLeft: theme.space.lg, letterSpacing: 0.6 }} variant="meta">
              {strings.settings.themes.header}
            </Text>
            <View
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}
            >
              {userThemes.map(entry => (
                <ThemeCard
                  choice={{ kind: 'user', id: entry.id }}
                  key={entry.id}
                  label={entry.name || strings.settings.themes.untitled}
                  onPress={() => {
                    useSettingsStore.getState().setThemeChoice({ kind: 'user', id: entry.id })
                    setEditing(entry.id)
                  }}
                  scheme={theme.scheme}
                  selected={editing === entry.id}
                  testID={`theme-card-user-${entry.id}`}
                  userThemes={userThemes}
                />
              ))}
            </View>
          </View>
        ) : (
          <Text color="textMuted" variant="preview">
            {strings.settings.themes.empty}
          </Text>
        )}

        {target ? (
          <ThemeEditor
            key={target.id}
            base={target.base}
            id={target.id}
            name={target.name}
            onDelete={() => setConfirmingDelete(target.id)}
          />
        ) : null}

        {confirmingDelete ? (
          <InsetGroup footer={strings.settings.themes.deleteHint}>
            <InsetButtonRow
              onPress={() => {
                useSettingsStore.getState().deleteUserTheme(confirmingDelete)
                setConfirmingDelete(null)
                setEditing(null)
              }}
              testID="theme-delete-confirm"
              title={strings.settings.themes.deleteConfirm(
                userThemes.find(entry => entry.id === confirmingDelete)?.name ?? ''
              )}
              tone="danger"
            />
            <InsetButtonRow
              onPress={() => setConfirmingDelete(null)}
              title={strings.settings.themes.keepIt}
              tone="text"
            />
          </InsetGroup>
        ) : null}

        {onClose ? <Button onPress={onClose} title={strings.settings.themes.back} variant="secondary" /> : null}

        <View style={{ height: theme.space.xxl }} />
      </ScrollView>
    </Screen>
  )
}

/**
 * The editor for one theme's current face.
 *
 * Every field keeps its own draft text, because a colour is only a colour once
 * six digits have been typed and rejecting the four in between would make the
 * field impossible to use. The store is written on the first draft that PASSES,
 * so the window follows the typing, and a draft that fails leaves the last good
 * value on screen with the reason under the field.
 */
function ThemeEditor({
  id,
  name,
  base,
  onDelete
}: {
  id: string
  name: string
  base: ThemePresetName
  onDelete: () => void
}) {
  const theme = useTheme()
  const userThemes = useSettingsStore(state => state.userThemes)
  const entry = userThemes.find(item => item.id === id)
  const face = resolveThemeFace({ kind: 'user', id }, theme.scheme, userThemes)
  const stored = entry?.[theme.scheme] ?? {}

  const current: Record<ThemeColourField, string> = {
    background: face.background,
    accentFill: face.accentSwatch.fill,
    accentBubble: face.accentSwatch.bubble
  }

  const [drafts, setDrafts] = useState<Partial<Record<ThemeColourField, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<ThemeColourField, string>>>({})

  const describe = (field: ThemeColourField, verdict: ReturnType<typeof judgeThemeColour>): string => {
    if (verdict.ok) {
      return ''
    }

    if (verdict.reason === 'malformed') {
      return strings.settings.themes.rejected(strings.settings.themes.reasonMalformed)
    }

    const ratio = verdict.ratio.toFixed(2)

    if (field === 'accentBubble') {
      return strings.settings.themes.rejected(strings.settings.themes.reasonBubble(ratio))
    }

    if (field === 'background') {
      return strings.settings.themes.rejected(strings.settings.themes.reasonBackground(ratio))
    }

    return strings.settings.themes.rejected(strings.settings.themes.reasonAccentFill(ratio))
  }

  return (
    <View style={{ gap: theme.space.lg }}>
      <InsetGroup footer={strings.settings.themes.editingHint} header={strings.settings.themes.editing(theme.scheme)}>
        <InsetRow>
          <TextField
            autoCapitalize="words"
            label={strings.settings.themes.name}
            onChangeText={next => useSettingsStore.getState().renameUserTheme(id, next)}
            placeholder={strings.settings.themes.namePlaceholder}
            testID="theme-name"
            value={name}
          />
        </InsetRow>

        {FIELDS.map(({ field, label }) => (
          <InsetRow key={field}>
            <TextField
              autoCapitalize="characters"
              autoCorrect={false}
              error={errors[field] ?? null}
              label={label}
              onChangeText={next => {
                setDrafts(previous => ({ ...previous, [field]: next }))

                const verdict = judgeThemeColour(field, next, theme.scheme, face)

                setErrors(previous => ({ ...previous, [field]: describe(field, verdict) }))

                if (verdict.ok) {
                  useSettingsStore.getState().editUserTheme(id, theme.scheme, { [field]: next.trim() })
                }
              }}
              placeholder={strings.settings.themes.colourPlaceholder}
              testID={`theme-colour-${field}`}
              value={drafts[field] ?? current[field]}
            />
            {/* A field that is following the preset can say so and be let go of again. */}
            {stored[field] ? (
              <Text
                color="accentText"
                onPress={() => {
                  setDrafts(previous => ({ ...previous, [field]: undefined }))
                  setErrors(previous => ({ ...previous, [field]: '' }))
                  useSettingsStore.getState().editUserTheme(id, theme.scheme, { [field]: null })
                }}
                testID={`theme-follow-${field}`}
                variant="meta"
              >
                {strings.settings.themes.followPreset}
              </Text>
            ) : (
              <Text color="textFaint" variant="meta">
                {strings.settings.themes.createFrom(strings.settings.presetOptions[base])}
              </Text>
            )}
          </InsetRow>
        ))}
      </InsetGroup>

      <InsetGroup>
        <InsetButtonRow onPress={onDelete} testID="theme-delete" title={strings.settings.themes.delete} tone="danger" />
      </InsetGroup>
    </View>
  )
}
