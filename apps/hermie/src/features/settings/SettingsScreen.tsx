import type { Verbosity } from '@hermie/transcript'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { chatStrings } from '../../chat-ui'
import { useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { type Appearance, useSettingsStore } from '../../store/settings'
import { InsetButtonRow, InsetGroup, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { FORM_MAX_WIDTH, WALLPAPER_ORDER, type WallpaperName } from '../../ui/tokens'
import { DebugConnectionScreen } from './DebugConnectionScreen'
import { GALLERY_ROW_TITLE, GalleryScreen } from './GalleryScreen'
import { LicencesScreen } from './LicencesScreen'

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

const WALLPAPER_OPTIONS: { value: WallpaperName; label: string }[] = WALLPAPER_ORDER.map(name => ({
  value: name,
  label: strings.settings.wallpaperOptions[name]
}))

export interface SettingsScreenProps {
  /**
   * Open one of the pages Settings shows over itself.
   *
   * Development only (`--hermieOpen overlay:settings/licences`). Each of these
   * is behind a tap, and a simulator this machine can only launch cannot tap.
   */
  initialPage?: 'connection' | 'gallery' | 'licences'
}

export function SettingsScreen({ initialPage }: SettingsScreenProps = {}) {
  const theme = useTheme()
  const { config, status, signOut, changeGateway } = useGateway()
  const defaults = useSettingsStore(state => state.defaults)
  const appearance = useSettingsStore(state => state.appearance)
  const setDefaults = useSettingsStore(state => state.setDefaults)
  const setAppearance = useSettingsStore(state => state.setAppearance)
  const wallpaper = useSettingsStore(state => state.wallpaper)
  const setWallpaper = useSettingsStore(state => state.setWallpaper)
  const [showConnectionTest, setShowConnectionTest] = useState(initialPage === 'connection')
  const [showGallery, setShowGallery] = useState(initialPage === 'gallery')
  const [showLicences, setShowLicences] = useState(initialPage === 'licences')
  const [confirmingChange, setConfirmingChange] = useState(false)

  // Escape goes back ONE level: out of a screen Settings opened and into
  // Settings, and only then out of whatever is holding Settings.
  useEscapeKey(
    () => {
      setShowConnectionTest(false)
      setShowGallery(false)
      setShowLicences(false)
    },
    showConnectionTest || showGallery || showLicences
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

  const token = config?.authMode === 'session_token'

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.xl,
          width: '100%',
          maxWidth: FORM_MAX_WIDTH,
          alignSelf: 'center'
        }}
      >
        <Text variant="title">{strings.settings.title}</Text>

        <InsetGroup header={strings.settings.gateway}>
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

        <InsetGroup header={strings.settings.appearance}>
          <SegmentedRow
            label={strings.settings.theme}
            onChange={(value: Appearance) => setAppearance(value)}
            options={APPEARANCE_OPTIONS}
            testID="settings-appearance"
            value={appearance}
          />
          <SegmentedRow
            label={strings.settings.wallpaper}
            onChange={(value: WallpaperName) => setWallpaper(value)}
            options={WALLPAPER_OPTIONS}
            testID="settings-wallpaper"
            value={wallpaper}
          />
        </InsetGroup>

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

        <View style={{ height: theme.space.xxl }} />
      </ScrollView>
    </Screen>
  )
}
