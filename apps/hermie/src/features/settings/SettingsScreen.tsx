import { isExposedCleartext } from '@hermie/gateway-client'
import type { Verbosity } from '@hermie/transcript'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'

import { chatStrings } from '../../chat-ui'
import { useChatRuntime } from '../chats/ChatRuntime'
import { MemoryBotsScreen, memoryStrings } from '../memory'
import { NotificationsSection } from '../push/NotificationsSection'
import { pushPlatform } from '../push/platform'
import { useGateway } from '../../gateway'
import { GatewayAddressRow } from '../../gateway/GatewayAddressRow'
import { describeGatewayAddress } from '../../gateway/gateway-stop'
import { WEB_GATEWAY_BASE_URL } from '../../gateway/web-config'
import { RefreshNotice } from '../../gateway/RefreshNotice'
import { TransportNotice } from '../../gateway/TransportNotice'
import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { pluginPresence, usePluginStore } from '../../store/plugin'
import { useSettingsStore } from '../../store/settings'
import { InsetButtonRow, InsetGroup, InsetValueRow, Screen } from '../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { ConnectorsScreen, connectorStrings } from '../connectors'
import { KanbanScreen, kanbanStrings } from '../kanban'
import { LogsScreen, logStrings } from '../logs'
import { McpScreen, mcpStrings } from '../mcp'
import { NewBotFlow, profileStrings } from '../profiles'
import { SkillsScreen, skillStrings } from '../skills'
import { AboutFooter } from './AboutFooter'
import { AppearanceSection } from './AppearanceSection'
import { ContextSection } from './ContextSection'
import { DebugConnectionScreen } from './DebugConnectionScreen'
import { GALLERY_ROW_TITLE, GalleryScreen } from './GalleryScreen'
import { LicencesScreen } from './LicencesScreen'
import { PrivacySection } from './PrivacySection'
import { ThemesScreen } from './ThemesScreen'
import { WebUpdateRow } from './WebUpdateRow'

const VERBOSITY_OPTIONS: { value: Verbosity; label: string }[] = [
  { value: 'quiet', label: chatStrings.options.verbosityOptions.quiet },
  { value: 'normal', label: chatStrings.options.verbosityOptions.normal },
  { value: 'verbose', label: chatStrings.options.verbosityOptions.verbose }
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
  const { canRefresh, config, status, signOut, changeGateway, forgetGateway } = useGateway()
  const runtime = useChatRuntime()
  const advert = usePluginStore(state => state.advert)
  const presence = usePluginStore(pluginPresence)
  const defaults = useSettingsStore(state => state.defaults)
  const setDefaults = useSettingsStore(state => state.setDefaults)
  const [showConnectionTest, setShowConnectionTest] = useState(initialPage === 'connection')
  const [showGallery, setShowGallery] = useState(initialPage === 'gallery')
  const [showLicences, setShowLicences] = useState(initialPage === 'licences')
  const [showThemes, setShowThemes] = useState(initialPage === 'themes')
  const [showMemory, setShowMemory] = useState(false)
  const [confirmingChange, setConfirmingChange] = useState(false)
  /*
    The three capability surfaces, as pages over Settings rather than routes —
    the shape this screen already uses for Licences and the gallery, and the
    one the two shells can both hold (see `CronScreen`'s note about push).
    `showNewBot` is a sheet rather than a page: it is a form, not a place.
  */
  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showConnectors, setShowConnectors] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showBoards, setShowBoards] = useState(false)
  const [showNewBot, setShowNewBot] = useState(false)

  // Escape goes back ONE level: out of a screen Settings opened and into
  // Settings, and only then out of whatever is holding Settings.
  useEscapeKey(
    () => {
      setShowConnectionTest(false)
      setShowGallery(false)
      setShowLicences(false)
      setShowThemes(false)
      setShowMemory(false)
      setShowSkills(false)
      setShowMcp(false)
      setShowConnectors(false)
      setShowLogs(false)
      setShowBoards(false)
    },
    showConnectionTest ||
      showGallery ||
      showLicences ||
      showThemes ||
      showMemory ||
      showSkills ||
      showMcp ||
      showConnectors ||
      showLogs ||
      showBoards
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
      setShowMemory(false)
      setShowSkills(false)
      setShowMcp(false)
      setShowConnectors(false)
      setShowLogs(false)
      setShowBoards(false)
    },
    showConnectionTest ||
      showGallery ||
      showLicences ||
      showThemes ||
      showMemory ||
      showSkills ||
      showMcp ||
      showConnectors ||
      showLogs ||
      showBoards
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

  if (showMemory) {
    return <MemoryBotsScreen onClose={() => setShowMemory(false)} />
  }

  if (showSkills) {
    return <SkillsScreen onClose={() => setShowSkills(false)} />
  }

  if (showMcp) {
    return <McpScreen onClose={() => setShowMcp(false)} />
  }

  if (showConnectors) {
    return <ConnectorsScreen onClose={() => setShowConnectors(false)} />
  }

  if (showLogs) {
    return <LogsScreen onClose={() => setShowLogs(false)} />
  }

  if (showBoards) {
    return <KanbanScreen onClose={() => setShowBoards(false)} />
  }

  const token = config?.authMode === 'session_token'
  const address = describeGatewayAddress(config?.baseUrl)

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
          /*
            Two notices, one footer slot, and they are about different things:
            the transport one is about the ADDRESS and only speaks for an
            exposed cleartext host — a tailnet gateway over http is the ordinary
            setup, and Settings is not where somebody wants to be told again
            that their own network is their own network. The refresh one is
            about the CREDENTIAL, and it speaks wherever the stored sign-in has
            nothing to rotate with.
          */
          {...(isExposedCleartext(config?.baseUrl ?? '') || canRefresh === false
            ? {
                footer: (
                  <>
                    <TransportNotice baseUrl={config?.baseUrl} testID="transport-notice" />
                    <RefreshNotice canRefresh={canRefresh !== false} testID="refresh-notice" />
                  </>
                )
              }
            : {})}
        >
          <GatewayAddressRow baseUrl={config?.baseUrl} />
          {/*
            The same parts the stopped-gateway card prints, so an address read
            here and an address blamed by a failure read identically. Not in a
            browser: there the row above already answers "which gateway", and
            this app's own origin has a scheme and a port that say nothing
            about it.
          */}
          {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.host} value={address.host} />}
          {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.scheme} value={address.scheme} />}
          {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.port} value={address.port} />}
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
          {/*
            Whether the gateway-side plugin is there, which is what decides
            whether notifications can come from the gateway at all. "Checking…"
            rather than "Not installed" until a roster has actually arrived: the
            two look the same for a second and only one of them is a reason to
            send somebody to a shell.
          */}
          <InsetValueRow
            label={strings.settings.plugin}
            value={
              presence === 'unknown'
                ? strings.settings.pluginUnknown
                : presence === 'installed'
                  ? strings.settings.pluginInstalled(advert?.version ?? '')
                  : strings.settings.pluginAbsent
            }
          />
          {/*
            The gateway's own log files, over `GET /api/logs`. It is the only
            surface a client has for them — there is no socket method — and a
            gateway that does not serve the route gets the command instead of
            an empty page.
          */}
          <InsetButtonRow
            detail={logStrings.settings.hint}
            onPress={() => setShowLogs(true)}
            title={logStrings.settings.row}
          />
        </InsetGroup>

        <InsetGroup header={strings.settings.account}>
          <InsetButtonRow
            title={strings.settings.signOut}
            detail={strings.settings.signOutHint}
            onPress={() => void signOut()}
          />
          {/*
            Two rows where there was one, because they were one thing with two
            meanings. Changing gateway is now the ordinary, reversible act —
            setup reopens on the address step with this address in it and
            nothing is dropped until a different one is saved — and forgetting
            is the destructive one that still asks.

            In a browser neither applies: Hermie Web fixes the gateway, and the
            wizard there has no address step to open.
          */}
          {WEB_GATEWAY_BASE_URL ? null : (
            <InsetButtonRow
              title={strings.settings.changeGateway}
              detail={strings.settings.changeGatewayHint}
              onPress={() => void changeGateway()}
            />
          )}
          {confirmingChange ? (
            <InsetButtonRow
              title={strings.settings.confirm}
              tone="danger"
              detail={strings.settings.changeGatewayConfirm}
              onPress={() => void forgetGateway()}
            />
          ) : null}
          {confirmingChange ? (
            <InsetButtonRow title={strings.settings.keepIt} tone="text" onPress={() => setConfirmingChange(false)} />
          ) : (
            <InsetButtonRow
              title={strings.settings.forgetGateway}
              tone="danger"
              detail={strings.settings.forgetGatewayHint}
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

        {/* ADR-0017, and off until the reader says otherwise: nothing here asks
            for permission or mints a token on mount. */}
        <NotificationsSection available={pushPlatform.available} push={runtime?.push ?? null} />

        {/* What a bot is told about whoever is holding the device. Nothing is
            written on a gateway with accounts until the notice is accepted. */}
        <ContextSection />

        {/* The app lock. Per device, and never carried to another one by
            ADR-0016's sync. */}
        <PrivacySection />

        {/* One row, into the feature's own two-deep stack: bots, then one
            bot's two memory files. */}
        <InsetGroup header={memoryStrings.botsTitle}>
          <InsetButtonRow
            detail={memoryStrings.botsHint}
            onPress={() => setShowMemory(true)}
            testID="settings-memory"
            title={memoryStrings.rowTitle}
          />
        </InsetGroup>

        <AppearanceSection onOpenAdvanced={() => setShowThemes(true)} />

        {/* Only the browser build has a server of its own to update; everywhere
            else this renders nothing. */}
        <WebUpdateRow />

        {/*
          The gateway-wide capability surfaces, plus the one action that makes a
          bot. They sit together because all three answer "what can my bots
          do" — and the New-bot row is here as well as in the chat list's header
          because Settings is where somebody looks for a thing they do once.

          There is deliberately no "delete a bot" anywhere. The gateway has no
          profile-delete method at all; see `PROFILE_DELETE_UNAVAILABLE` in
          `features/profiles/profiles-controller.ts` for the whole argument.
        */}
        <InsetGroup header={profileStrings.settings.group}>
          <InsetButtonRow
            detail={profileStrings.settings.newBotHint}
            onPress={() => setShowNewBot(true)}
            title={profileStrings.settings.newBot}
          />
          <InsetButtonRow
            detail={skillStrings.settings.hint}
            onPress={() => setShowSkills(true)}
            title={skillStrings.settings.row}
          />
          <InsetButtonRow
            detail={mcpStrings.settings.hint}
            onPress={() => setShowMcp(true)}
            title={mcpStrings.settings.row}
          />
          <InsetButtonRow
            detail={connectorStrings.settings.hint}
            onPress={() => setShowConnectors(true)}
            title={connectorStrings.settings.row}
          />
          <InsetButtonRow
            detail={kanbanStrings.settings.hint}
            onPress={() => setShowBoards(true)}
            title={kanbanStrings.settings.row}
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

        <AboutFooter />

        <View style={{ height: theme.space.xxl }} />
      </ScrollView>

      {/*
        A sheet rather than a page, and mounted beside the scroller rather than
        inside it: `BottomSheet` draws its own backdrop over the whole screen.
        No `onOpened` — from Settings there is nowhere to land, so the new bot
        simply appears in the chat list where somebody will look for it.
      */}
      <NewBotFlow onClose={() => setShowNewBot(false)} visible={showNewBot} />
    </Screen>
  )
}
