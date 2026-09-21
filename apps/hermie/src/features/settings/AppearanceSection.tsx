/**
 * Settings → Appearance, as its own component.
 *
 * It is lifted out of `SettingsScreen` for one reason: this machine has no
 * `Simulator.app`, so a surface can be launched and photographed and nothing
 * else — and Appearance sits four groups down a scrolling screen, which on a
 * phone puts it permanently below the fold of every screenshot. The gallery is
 * the mechanism that already exists for that (`--hermieOpen gallery:appearance`),
 * and a gallery section that re-implemented the picker would be a second picker
 * to keep in step with the first. So the section is the thing itself, mounted
 * twice.
 */
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { type Appearance, useSettingsStore } from '../../store/settings'
import { InsetButtonRow, InsetGroup, Text } from '../../ui/primitives'
import { SegmentedRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import type { NameOrder } from '../../store/bot-names'
import { THEME_PRESET_ORDER } from '../../ui/themes'
import { ThemeCard } from './ThemeCard'

const APPEARANCE_OPTIONS: { value: Appearance; label: string }[] = [
  { value: 'system', label: strings.settings.themeOptions.system },
  { value: 'light', label: strings.settings.themeOptions.light },
  { value: 'dark', label: strings.settings.themeOptions.dark }
]

/**
 * Which of a bot's two names is the large one, app-wide.
 *
 * The segments are named after the FIELDS rather than after an example, because
 * an example is a promise about this reader's own bots that the setting cannot
 * keep: a gateway where nobody has set a display name shows the same thing
 * either way, and a segment reading "lance-vance" would be a lie on it.
 */
const NAME_ORDER_OPTIONS: { value: NameOrder; label: string }[] = [
  { value: 'profile', label: strings.settings.botNameOptions.profile },
  { value: 'display', label: strings.settings.botNameOptions.display }
]

export interface AppearanceSectionProps {
  /** Open the page where a reader makes a theme of their own. */
  onOpenAdvanced: () => void
}

export function AppearanceSection({ onOpenAdvanced }: AppearanceSectionProps) {
  const theme = useTheme()
  const appearance = useSettingsStore(state => state.appearance)
  const setAppearance = useSettingsStore(state => state.setAppearance)
  const botNameOrder = useSettingsStore(state => state.botNameOrder)
  const setBotNameOrder = useSettingsStore(state => state.setBotNameOrder)
  const themeChoice = useSettingsStore(state => state.themeChoice)
  const userThemes = useSettingsStore(state => state.userThemes)
  const setThemeChoice = useSettingsStore(state => state.setThemeChoice)

  return (
    <>
      <InsetGroup footer={strings.settings.themeHint} header={strings.settings.appearance}>
        <SegmentedRow
          label={strings.settings.theme}
          onChange={(value: Appearance) => setAppearance(value)}
          options={APPEARANCE_OPTIONS}
          testID="settings-appearance"
          value={appearance}
        />
      </InsetGroup>

      {/*
        Its own group, for its own footer.

        The two names need explaining in a way the light/dark choice does not —
        which of them the rest of the app addresses a bot by is the whole reason
        somebody would move this — and a group has one footer.
      */}
      <InsetGroup footer={strings.settings.botNamesHint}>
        <SegmentedRow
          label={strings.settings.botNames}
          onChange={(value: NameOrder) => setBotNameOrder(value)}
          options={NAME_ORDER_OPTIONS}
          testID="settings-bot-names"
          value={botNameOrder}
        />
      </InsetGroup>

      {/*
        The themes, as cards rather than as a segmented control of names.

        A segment reading "Graphite" is a promise a reader cannot check, and the
        only question in front of a theme picker is what the window will look
        like. Each card paints its own floor, its own panel and a bubble pair in
        its own accent, resolved through the same function the app resolves the
        live theme with — see `ThemeCard`.
      */}
      <View style={{ gap: theme.space.md }}>
        <Text color="textMuted" style={{ letterSpacing: 0.6, marginLeft: theme.space.lg }} variant="meta">
          {strings.settings.preset}
        </Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}>
          {THEME_PRESET_ORDER.map(name => (
            <ThemeCard
              choice={{ kind: 'preset', name }}
              key={name}
              label={strings.settings.presetOptions[name]}
              onPress={() => setThemeChoice({ kind: 'preset', name })}
              scheme={theme.scheme}
              selected={themeChoice.kind === 'preset' && themeChoice.name === name}
              testID={`theme-card-${name}`}
              userThemes={userThemes}
            />
          ))}
          {userThemes.map(entry => (
            <ThemeCard
              choice={{ kind: 'user', id: entry.id }}
              key={entry.id}
              label={entry.name || strings.settings.themes.untitled}
              onPress={() => setThemeChoice({ kind: 'user', id: entry.id })}
              scheme={theme.scheme}
              selected={themeChoice.kind === 'user' && themeChoice.id === entry.id}
              testID={`theme-card-user-${entry.id}`}
              userThemes={userThemes}
            />
          ))}
        </View>
        <Text color="textMuted" style={{ marginHorizontal: theme.space.lg }} variant="meta">
          {strings.settings.presetHint}
        </Text>
      </View>

      <InsetGroup>
        <InsetButtonRow
          detail={strings.settings.themes.advancedHint}
          onPress={onOpenAdvanced}
          testID="settings-themes-advanced"
          title={strings.settings.themes.advanced}
        />
      </InsetGroup>
    </>
  )
}
