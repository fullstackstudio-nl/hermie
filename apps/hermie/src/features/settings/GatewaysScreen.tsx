/**
 * Every gateway this device knows about, and the one it is talking to.
 *
 * Three pages in one file, because they are one flow and the flow is short:
 * the list, one gateway's own page, and the setup wizard in "add" mode. They
 * REPLACE each other rather than pushing onto a navigator, for the reason
 * `SettingsScreen` gives: Settings has to work both inside a native stack on a
 * phone and as the content of an overlay panel on a wide window, where there
 * is no navigator above it at all.
 *
 * Two decisions are worth stating because the alternative is what a reader
 * would expect:
 *
 *  - **Adding does not switch.** The wizard here writes a new entry and comes
 *    straight back; the gateway the reader is on stays connected the whole
 *    time. Somebody describing a second machine has not asked to be moved onto
 *    it, and an add that switched would tear down a socket mid-conversation.
 *  - **The destructive act is on the gateway's own page**, not on its row. A
 *    row that can both connect and delete is a row where a mis-tap costs a
 *    conversation.
 */
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { useGateway } from '../../gateway'
import { gatewaysInOrder, type GatewayRecord } from '../../gateway/registry'
import { strings } from '../../i18n/strings'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { InsetButtonRow, InsetGroup, InsetValueRow, Screen, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { OnboardingNavigator } from '../onboarding'

/** What a row says under the name: the address, the sign-in, and the auth kind. */
export function describeGateway(gateway: GatewayRecord): string {
  const text = strings.settings.gateways
  const who =
    gateway.authKind === 'session_token'
      ? text.authModeToken
      : gateway.signedInUser
        ? text.signedInAs(gateway.signedInUser)
        : text.signedOut

  return `${gateway.address} · ${who}`
}

export interface GatewaysScreenProps {
  onClose: () => void
}

export function GatewaysScreen({ onClose }: GatewaysScreenProps) {
  const theme = useTheme()
  const text = strings.settings.gateways
  const { registry, gatewayId, switchGateway, refreshRegistry } = useGateway()
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const back = useCallback(() => {
    if (adding) {
      setAdding(false)
    } else if (openId) {
      setOpenId(null)
    } else {
      onClose()
    }
  }, [adding, onClose, openId])

  // Escape and Android's back both go back ONE level, the same way Settings
  // handles the pages it opens over itself.
  useEscapeKey(back, true)
  useHardwareBack(back, true)

  const finishAdd = useCallback(async () => {
    // The wizard wrote a new entry; this provider's copy of the list is the one
    // every screen reads, so it has to be told. Nothing switches — see the note
    // at the top of the file.
    await refreshRegistry()
    setAdding(false)
  }, [refreshRegistry])

  if (adding) {
    return (
      <OnboardingNavigator
        // `null` is what makes this an ADD rather than an edit: the wizard mints
        // an entry instead of writing into the one that is live.
        gatewayId={null}
        onCancel={() => setAdding(false)}
        onComplete={finishAdd}
      />
    )
  }

  if (openId) {
    return <GatewayDetail id={openId} onClose={() => setOpenId(null)} />
  }

  const gateways = gatewaysInOrder(registry)

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
        ref={directTouchPanRef}
      >
        <InsetGroup footer={text.hint} header={text.header}>
          {gateways.map(gateway => (
            <GatewayRow
              active={gateway.id === gatewayId}
              gateway={gateway}
              key={gateway.id}
              onManage={() => setOpenId(gateway.id)}
              onSwitch={() => void switchGateway(gateway.id)}
            />
          ))}
        </InsetGroup>

        <InsetGroup footer={text.addHint}>
          <InsetButtonRow onPress={() => setAdding(true)} testID="gateways-add" title={text.add} />
        </InsetGroup>

        <InsetGroup>
          <InsetButtonRow onPress={onClose} testID="gateways-close" title={strings.common.back} tone="text" />
        </InsetGroup>
      </ScrollView>
    </Screen>
  )
}

interface GatewayRowProps {
  gateway: GatewayRecord
  active: boolean
  onSwitch: () => void
  onManage: () => void
}

/**
 * One gateway.
 *
 * Two targets rather than one, and they are deliberately far apart: the body
 * connects and the trailing word opens the page that can delete. A single row
 * carrying both would make "remove everything on this device" a mis-tap away
 * from "read my messages".
 */
function GatewayRow({ gateway, active, onSwitch, onManage }: GatewayRowProps) {
  const theme = useTheme()
  const text = strings.settings.gateways

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        paddingRight: theme.space.lg
      }}
      testID={`gateway-row-${gateway.id}`}
    >
      <Pressable
        accessibilityRole="button"
        aria-selected={active}
        disabled={active}
        onPress={onSwitch}
        style={({ pressed }) => ({
          backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
          flex: 1,
          gap: theme.space.xxs,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.md
        })}
        testID={`gateway-switch-${gateway.id}`}
      >
        <Text variant="preview">{gateway.name}</Text>
        <Text color="textMuted" variant="meta">
          {describeGateway(gateway)}
        </Text>
        {active ? (
          <Text color="accentText" testID={`gateway-active-${gateway.id}`} variant="meta">
            {text.active}
          </Text>
        ) : null}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={onManage}
        style={{ cursor: 'pointer', padding: theme.space.sm }}
        testID={`gateway-manage-${gateway.id}`}
      >
        <Text color="accentText" variant="meta">
          {text.manage}
        </Text>
      </Pressable>
    </View>
  )
}

interface GatewayDetailProps {
  id: string
  onClose: () => void
}

/** One gateway's own page: what it is called, and the three things you can do to it. */
function GatewayDetail({ id, onClose }: GatewayDetailProps) {
  const theme = useTheme()
  const text = strings.settings.gateways
  const { registry, gatewayId, renameGateway, signOutOf, removeGateway, switchGateway } = useGateway()
  const gateway = registry.gateways.find(entry => entry.id === id)
  const [name, setName] = useState(gateway?.name ?? '')
  const [confirming, setConfirming] = useState(false)

  if (!gateway) {
    // Removed from under us — by this page, on the way out. The list is where
    // the reader should be, and it is already correct.
    onClose()

    return null
  }

  const active = gateway.id === gatewayId

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
        ref={directTouchPanRef}
      >
        <InsetGroup footer={text.nameHint} header={text.detailTitle}>
          <TextField
            label={text.name}
            onChangeText={setName}
            onSubmitEditing={() => void renameGateway(gateway.id, name)}
            testID="gateway-name"
            value={name}
          />
          <InsetButtonRow
            disabled={name.trim() === gateway.name}
            onPress={() => void renameGateway(gateway.id, name)}
            testID="gateway-rename"
            title={text.save}
          />
        </InsetGroup>

        <InsetGroup>
          <InsetValueRow label={strings.settings.address} value={gateway.address} />
          <InsetValueRow
            label={strings.settings.provider}
            value={gateway.authKind === 'session_token' ? text.authModeToken : gateway.authKind}
          />
          <InsetValueRow label={strings.settings.user} value={gateway.signedInUser ?? text.signedOut} />
        </InsetGroup>

        {active ? null : (
          <InsetGroup footer={text.connectHint}>
            <InsetButtonRow
              onPress={() => {
                void switchGateway(gateway.id)
                onClose()
              }}
              testID="gateway-connect"
              title={text.connect}
            />
          </InsetGroup>
        )}

        <InsetGroup footer={`${text.removeHint} ${text.removeNotifyNote}`}>
          <InsetButtonRow
            detail={text.signOutHint}
            onPress={() => void signOutOf(gateway.id)}
            testID="gateway-sign-out"
            title={text.signOut}
          />
          {confirming ? (
            <InsetButtonRow
              detail={text.removeConfirm}
              onPress={() => {
                void removeGateway(gateway.id)
                onClose()
              }}
              testID="gateway-remove-confirm"
              title={text.removeConfirmAction}
              tone="danger"
            />
          ) : null}
          {confirming ? (
            <InsetButtonRow onPress={() => setConfirming(false)} title={text.keepIt} tone="text" />
          ) : (
            <InsetButtonRow
              onPress={() => setConfirming(true)}
              testID="gateway-remove"
              title={text.remove}
              tone="danger"
            />
          )}
        </InsetGroup>

        <InsetGroup>
          <InsetButtonRow onPress={onClose} testID="gateway-detail-close" title={text.back} tone="text" />
        </InsetGroup>
      </ScrollView>
    </Screen>
  )
}
