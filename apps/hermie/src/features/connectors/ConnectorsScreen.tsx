/**
 * Settings ▸ Connectors, and one connector's detail.
 *
 * The page is scoped to a CHAT, and that is the gateway's shape rather than a
 * choice. `connectors.list` takes a `session_id`, and upstream authorises it by
 * whether this socket is attached to that session — so a connector list exists
 * for a conversation that is open and for nothing else. A page that asked for
 * "your connectors" would have no call to make.
 *
 * One screen with an early-return sub-screen, the way the MCP and Crons pages
 * are built: the compact and regular shells own their own navigation and
 * disagree about what "push" means, so a feature that pushed for itself would
 * be right on exactly one of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Linking, Pressable, RefreshControl, ScrollView } from 'react-native'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useBotsStore } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { Button, InsetGroup, InsetRow, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'
import { ScreenHeader } from '../cron/ScreenHeader'
import { ConnectorsController, type ConnectorList, type ConnectorView } from './connectors-controller'
import { connectorStrings } from './strings'

export interface ConnectorsScreenProps {
  onClose: () => void
}

/** One chat this socket is attached to, which is what a connector list needs. */
interface LiveChat {
  botName: string
  displayName: string
  sessionId: string
}

export function ConnectorsScreen({ onClose }: ConnectorsScreenProps) {
  const theme = useTheme()
  const { connection } = useGateway()
  const runtimeToBot = useChatsStore(state => state.runtimeToBot)
  const byName = useBotsStore(state => state.byName)

  /*
    Every chat the app currently holds a runtime session for. `runtimeToBot` is
    the only honest source: it is populated when a chat ATTACHES, which is
    exactly the condition `_current_session_steer_authority` checks before it
    will answer `connectors.list` at all.
  */
  const chats = useMemo<LiveChat[]>(
    () =>
      Object.entries(runtimeToBot)
        .map(([sessionId, botName]) => ({
          botName,
          displayName: byName[botName]?.displayName ?? botName,
          sessionId
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [runtimeToBot, byName]
  )

  const [chosen, setChosen] = useState<string | null>(null)
  const [list, setList] = useState<ConnectorList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // One chat means no choice to make. More than one and the reader picks, so a
  // session that went away does not silently move the page to another bot.
  const chat = chats.find(entry => entry.sessionId === chosen) ?? (chats.length === 1 ? chats[0] : null)

  const controller = useMemo(
    () =>
      connection
        ? new ConnectorsController({
            gateway: chatGatewayFor(connection),
            openUrl: url => void Linking.openURL(url).catch(() => undefined)
          })
        : null,
    [connection]
  )

  /*
    The operation a flow is currently walking, so returning from the browser can
    tell the gateway to read the account NOW instead of on its next watcher
    tick. A ref rather than state: nothing draws it, and re-rendering the page
    every time it moved would restart the very poll that sets it.
  */
  const flow = useRef<{ sessionId: string; opId: string } | null>(null)

  const load = useCallback(async () => {
    if (!controller || !chat) {
      return
    }

    try {
      setList(await controller.load(chat.sessionId))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [controller, chat])

  useEffect(() => {
    void load()
  }, [load])

  /*
    Coming back to the app during an authorisation is this client's version of
    the desktop's `hermes://connections/done` deep link. Hermie has no such
    link, and the foreground edge is the same fact arriving a different way: the
    reader was in a browser and is now here.
  */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const open = flow.current

      if (state === 'active' && open && controller) {
        void controller.wake(open.sessionId, open.opId)
      }
    })

    return () => subscription.remove()
  }, [controller])

  useEscapeKey(() => setSelected(null), selected !== null)
  useHardwareBack(() => setSelected(null), selected !== null)

  const connector = list?.connectors.find(entry => entry.slug === selected) ?? null

  const connect = (slug: string, reconnect: boolean) => {
    if (!controller || !chat) {
      return
    }

    setBusy(slug)
    setNotice(connectorStrings.connecting)

    void controller
      .connect(chat.sessionId, slug, {
        reconnect,
        onOperation: opId => {
          flow.current = { opId, sessionId: chat.sessionId }
        }
      })
      .then(outcome => {
        if (outcome.status === 'connected') {
          setNotice(connectorStrings.connectOk(slug))
        } else if (outcome.status === 'expired') {
          setNotice(connectorStrings.connectExpired)
        } else if (outcome.status === 'skipped') {
          setNotice(connectorStrings.connectSkipped)
        } else {
          setNotice(connectorStrings.connectFailed(outcome.reason))
        }

        return load()
      })
      .catch((cause: unknown) =>
        setNotice(connectorStrings.connectFailed(cause instanceof Error ? cause.message : String(cause)))
      )
      .finally(() => {
        flow.current = null
        setBusy(null)
      })
  }

  if (connector && chat) {
    return (
      <ConnectorDetail
        busy={busy === connector.slug}
        connector={connector}
        notice={notice}
        onBack={() => {
          setSelected(null)
          setNotice(null)
        }}
        onConnect={() => connect(connector.slug, connector.connected)}
      />
    )
  }

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader
        back={connectorStrings.back}
        onBack={onClose}
        subtitle={connectorStrings.subtitle}
        title={connectorStrings.title}
      />

      <ScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
          />
        }
      >
        {chats.length === 0 ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {connectorStrings.scope.noneHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted" testID="connectors-no-chat">
                {connectorStrings.scope.none}
              </Text>
            </InsetRow>
          </InsetGroup>
        ) : (
          <>
            {/* The picker is drawn only when there is something to pick. */}
            {chats.length > 1 ? (
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {connectorStrings.scope.hint}
                  </Text>
                }
                header={connectorStrings.scope.header}
              >
                {chats.map(entry => (
                  <Pressable
                    accessibilityLabel={entry.displayName}
                    accessibilityRole="button"
                    aria-selected={entry.sessionId === chat?.sessionId}
                    key={entry.sessionId}
                    onPress={() => {
                      setChosen(entry.sessionId)
                      setList(null)
                      setNotice(null)
                    }}
                    style={{
                      backgroundColor: entry.sessionId === chat?.sessionId ? theme.elevation.e2 : 'transparent',
                      paddingHorizontal: theme.space.md,
                      paddingVertical: theme.space.sm
                    }}
                    testID={`connectors-chat-${entry.botName}`}
                  >
                    <Text>{entry.displayName}</Text>
                  </Pressable>
                ))}
              </InsetGroup>
            ) : null}

            {error ? (
              <Text color="dangerText" testID="connectors-error">
                {connectorStrings.failed(error)}
              </Text>
            ) : list === null ? (
              <Text color="textMuted">{connectorStrings.loading}</Text>
            ) : !list.available ? (
              /*
                A successful answer that means the bot's Connections toolset is
                off. Drawing "no connectors" here would report an empty account
                for what is actually a switch the reader owns.
              */
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {connectorStrings.unavailableHint}
                  </Text>
                }
              >
                <InsetRow>
                  <Text color="textMuted" testID="connectors-unavailable">
                    {connectorStrings.unavailable}
                  </Text>
                </InsetRow>
              </InsetGroup>
            ) : list.connectors.length === 0 ? (
              <InsetGroup>
                <InsetRow>
                  <Text color="textMuted" testID="connectors-empty">
                    {connectorStrings.empty}
                  </Text>
                </InsetRow>
              </InsetGroup>
            ) : (
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {connectorStrings.disconnect}
                  </Text>
                }
              >
                {list.connectors.map(entry => (
                  <ConnectorRowView key={entry.slug} connector={entry} onPress={() => setSelected(entry.slug)} />
                ))}
              </InsetGroup>
            )}

            {notice ? (
              <Text color="textMuted" testID="connectors-notice" variant="meta">
                {notice}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

/** The word for one row's state, kept in one place so the row and the detail agree. */
export const stateLabel = (connector: ConnectorView): string => {
  if (connector.connected) {
    return connectorStrings.state.connected
  }

  if (connector.enabled === false) {
    return connectorStrings.state.disabled
  }

  return connectorStrings.state.notConnected
}

function ConnectorRowView({ connector, onPress }: { connector: ConnectorView; onPress: () => void }) {
  const theme = useTheme()
  const state = stateLabel(connector)

  return (
    <Pressable
      accessibilityLabel={`${connector.label}, ${state}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
        gap: theme.space.xxs,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      })}
      testID={`connector-row-${connector.slug}`}
    >
      <Text>{connector.label}</Text>
      <Text color="textMuted" testID={`connector-state-${connector.slug}`} variant="meta">
        {state}
      </Text>
    </Pressable>
  )
}

function ConnectorDetail({
  connector,
  busy,
  notice,
  onBack,
  onConnect
}: {
  connector: ConnectorView
  busy: boolean
  notice: string | null
  onBack: () => void
  onConnect: () => void
}) {
  const theme = useTheme()

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader
        back={connectorStrings.detail.back}
        onBack={onBack}
        subtitle={stateLabel(connector)}
        title={connector.label}
      />

      <ScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
      >
        {connector.description ? <Text color="textMuted">{connector.description}</Text> : null}

        <InsetGroup>
          <InsetValueRow label={connectorStrings.detail.slug} mono value={connector.slug} />
          <InsetValueRow
            label={connectorStrings.detail.status}
            value={connector.connectionStatus ?? stateLabel(connector)}
          />
          {connector.enabled === null ? null : (
            <InsetValueRow
              label={connectorStrings.detail.enabled}
              value={connector.enabled ? connectorStrings.detail.yes : connectorStrings.detail.no}
            />
          )}
        </InsetGroup>

        {connector.statusReason ? (
          <Text color="textMuted" variant="meta">
            {connectorStrings.reason(connector.statusReason)}
          </Text>
        ) : null}

        <InsetGroup
          footer={
            <Text color="textMuted" variant="meta">
              {connectorStrings.connectHint}
            </Text>
          }
        >
          <InsetRow>
            <Button
              busy={busy}
              onPress={onConnect}
              testID="connector-connect"
              title={
                busy
                  ? connectorStrings.connecting
                  : connector.connected
                    ? connectorStrings.reconnect
                    : connectorStrings.connect
              }
              variant={connector.connected ? 'secondary' : 'primary'}
            />
          </InsetRow>
        </InsetGroup>

        {notice ? (
          <Text color="textMuted" testID="connector-detail-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        {/*
          The missing control, explained. There is no disconnect anywhere in the
          gateway or the CLI, and upstream refuses the verb on purpose — see
          `CONNECTOR_DISCONNECT_UNAVAILABLE` in the controller.
        */}
        <Text color="textMuted" testID="connector-disconnect-note" variant="meta">
          {connectorStrings.disconnect}
        </Text>
      </ScrollView>
    </Screen>
  )
}
