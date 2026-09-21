import { isExposedCleartext } from '@hermie/gateway-client'
import type { Verbosity } from '@hermie/transcript'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { chatStrings } from '../../chat-ui'
import { useGateway } from '../../gateway'
import { TransportNotice } from '../../gateway/TransportNotice'
import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { type Appearance, useSettingsStore } from '../../store/settings'
import { InsetButtonRow, InsetGroup, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { THEME_PRESET_ORDER } from '../../ui/themes'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { AboutFooter } from './AboutFooter'
import { DebugConnectionScreen } from './DebugConnectionScreen'
import { GALLERY_ROW_TITLE, GalleryScreen } from './GalleryScreen'
import { LicencesScreen } from './LicencesScreen'
import { ThemeCard } from './ThemeCard'
import { ThemesScreen } from './ThemesScreen'
import { WebUpdateRow } from './WebUpdateRow'

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'quiet', label: chatStrings.options.verbosityOptions.quiet },
  { value: 'normal', label: chatStrings.options.verbosityOptions.normal },
  { value: 'verbose', label: chatStrings.options.verbosityOptions.verbose }
]

const APPEARANCE_OPTIONS: { value: Appearance; label: string }[] = [
  { value: 'system', label: strings.settings.themeOptions.system },
  { value: 'light', label: strings.settings.themeOptions.light },
  { value: 'dark', label: strings.settings.themeOptions.dark }
]

export interface SettingsScreenProps {
  /**
   * Open one of the pages Settings shows over itself.
   *
   * Development only (`--hermieOpen overlay:settings/licences`). Each of these
   * is behind a tap, and a simulator this machine can only launch cannot tap.
   */
  initialPage?: 'connection' | 'gallery' | 'licences' | 'themes'
}

export function SettingsScreen({ initialPage }: SettingsScreenProps = {}) {
  const theme = useTheme()
  const { config, status, signOut, changeGateway } = useGateway()
  const defaults = useSettingsStore(state => state.defaults)
  const appearance = useSettingsStore(state => state.appearance)
  const setDefaults = useSettingsStore(state => state.setDefaults)
  const setAppearance = useSettingsStore(state => state.setAppearance)
  const themeChoice = useSettingsStore(state => state.themeChoice)
  const userThemes = useSettingsStore(state => state.userThemes)
  const setThemeChoice = useSettingsStore(state => state.setThemeChoice)
  const [showConnectionTest, setShowConnectionTest] = useState(initialPage === 'connection')
  const [showGallery, setShowGallery] = useState(initialPage === 'gallery')
  const [showLicences, setShowLicences] = useState(initialPage === 'licences')
  const [showThemes, setShowThemes] = useState(initialPage === 'themes')
  const [confirmingChange, setConfirmingChange] = useState(false)

  // Escape goes back ONE level: out of a screen Settings opened and into
  // Settings, and only then out of whatever is holding Settings.
  useEscapeKey(
    () => {
      setShowConnectionTest(false)
      setShowGallery(false)
      setShowLicences(false)
      setShowThemes(false)
    },
    showConnectionTest || showGallery || showLicences || showThemes
  )

  // The same one level for Android's back button, which is not Escape and has
  // to be said separately (see `useHardwareBack`). Without it a back press from
  // Licences popped the whole of Settings on a phone and left the app on the
  // wide layout, because these pages are state inside this screen rather than
  // anything the navigator or a Modal knows about.
  useHardwareBack(
    () => {
      setShowConnectionTest(false)
      setShowGallery(false)
      setShowLicences(false)
      setShowThemes(false)
    },
    showConnectionTest || showGallery || showLicences || showThemes
  )

  // A screen opened from here REPLACES Settings rather than pushing onto a
  // navigator, because Settings has to work in both shells: on a phone it sits
  // in a native stack, and on a wide window it is the content of an overlay
  // panel with no navigator above it at all (`app/RegularShell.tsx`).
  if (showConnectionTest) {
    return <DebugConnectionScreen onClose={() => setShowConnectionTest(false)} />
  }

  if (showGallery) {
    return <GalleryScreen onClose={() => setShowGallery(false)} />
  }

  if (showLicences) {
    return <LicencesScreen onClose={() => setShowLicences(false)} />
  }

  if (showThemes) {
    return <ThemesScreen onClose={() => setShowThemes(false)} />
  }

  const token = config?.authMode === 'session_token'

  return (
    <Screen padded={false}>
      <ScrollView
        ref={directTouchPanRef}
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.xl,
          width: '100%',
          maxWidth: FORM_MAX_WIDTH,
          alignSelf: 'center'
        }}
      >
        {/*
          No title here. Both shells already put one above this screen — the
          overlay panel's header on the wide layout, the stack's own title bar on
          the compact one — and a large title directly under either of them reads
          as a stutter. Activity and Crons had already dropped theirs; this was
          the last one left.
        */}

        <InsetGroup
          header={strings.settings.gateway}
          // Only the exposed case speaks here. A tailnet gateway over http is
          // the ordinary setup, and Settings is not where somebody wants to be
          // told again that their own network is their own network.
          {...(isExposedCleartext(config?.baseUrl ?? '')
            ? { footer: <TransportNotice baseUrl={config?.baseUrl} testID="transport-notice" /> }
            : {})}
        >
          <InsetValueRow label={strings.settings.address} value={config?.baseUrl ?? strings.settings.unknown} />
          <InsetValueRow
            label={strings.settings.provider}
            value={
              token
                ? strings.settings.authModeToken
                : (config?.providerDisplayName ?? config?.provider ?? strings.settings.unknown)
            }
          />
          <InsetValueRow label={strings.settings.version} value={config?.version || strings.settings.unknown} />
          {config?.userDisplayName ? (
            <InsetValueRow label={strings.settings.user} value={config.userDisplayName} />
          ) : null}
          <InsetValueRow label={strings.settings.status} value={strings.connection.status[status]} />
        </InsetGroup>

        <InsetGroup header={strings.settings.account}>
          <InsetButtonRow
            title={strings.settings.signOut}
            detail={strings.settings.signOutHint}
            onPress={() => void signOut()}
          />
          {confirmingChange ? (
            <InsetButtonRow
              title={strings.settings.confirm}
              tone="danger"
              detail={strings.settings.changeGatewayConfirm}
              onPress={() => void changeGateway()}
            />
          ) : null}
          {confirmingChange ? (
            <InsetButtonRow title={strings.settings.keepIt} tone="text" onPress={() => setConfirmingChange(false)} />
          ) : (
            <InsetButtonRow
              title={strings.settings.changeGateway}
              tone="danger"
              detail={strings.settings.changeGatewayHint}
              onPress={() => setConfirmingChange(true)}
            />
          )}
        </InsetGroup>

        <InsetGroup header={strings.settings.chat} footer={strings.settings.defaultVerbosityHint}>
          <SegmentedRow
            label={strings.settings.defaultVerbosity}
            onChange={(level: Verbosity) => setDefaults({ level })}
            options={VERBOSITY_OPTIONS}
            testID="settings-verbosity"
            value={defaults.level}
          />
          <SwitchRow
            label={strings.settings.showBotToBot}
            onChange={showBotToBot => setDefaults({ showBotToBot })}
            testID="settings-bot-to-bot"
            value={defaults.showBotToBot}
          />
          <SwitchRow
            label={strings.settings.showThinking}
            onChange={showThinking => setDefaults({ showThinking })}
            testID="settings-thinking"
            value={defaults.showThinking}
          />
        </InsetGroup>

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
            onPress={() => setShowThemes(true)}
            testID="settings-themes-advanced"
            title={strings.settings.themes.advanced}
          />
        </InsetGroup>

        {/* Only the browser build has a server of its own to update; everywhere
            else this renders nothing. */}
        <WebUpdateRow />

        <InsetGroup header={strings.settings.about}>
          <InsetButtonRow
            detail={strings.settings.licencesHint}
            onPress={() => setShowLicences(true)}
            title={strings.settings.licences}
          />
        </InsetGroup>

        {/* Development builds only. The connection test prints the gateway's
            address and the component gallery is a catalogue of fixtures; both
            are tools for whoever is building the app, and neither belongs in a
            release a user installs. */}
        {__DEV__ ? (
          <InsetGroup header={strings.settings.developer}>
            <InsetButtonRow title={strings.settings.connectionTest} onPress={() => setShowConnectionTest(true)} />
            <InsetButtonRow title={GALLERY_ROW_TITLE} onPress={() => setShowGallery(true)} />
          </InsetGroup>
        ) : null}

        <AboutFooter />

        <View style={{ height: theme.space.xxl }} />
      </ScrollView>
    </Screen>
  )
}
