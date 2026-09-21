/**
 * Settings ▸ MCP servers, and one server's detail.
 *
 * One screen with an early-return sub-screen, which is the shape the Crons
 * feature uses and for the same reason: the compact and regular shells own
 * their own navigation and disagree about what "push" means, so a feature that
 * pushed for itself would be right on one of them.
 *
 * Nothing here probes on the reader's behalf. `mcp.servers.test` connects, and
 * a cold `npx` server takes seconds — testing three of them on arrival would
 * make the page feel broken while it was working. So the list paints from the
 * config and the cached runtime view, and connecting is a button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Linking, Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { Button, InsetGroup, InsetRow, InsetValueRow, Screen, Text } from '../../ui/primitives'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useHardwareBack } from '../../ui/useHardwareBack'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'
import { ScreenHeader } from '../cron/ScreenHeader'
import { McpController, type McpProbe, type McpServerView } from './mcp-controller'
import { mcpStrings } from './strings'

export interface McpScreenProps {
  onClose: () => void
  /** Scope every call to one bot. Omitted means the gateway's own profile. */
  profile?: string | null
}

export function McpScreen({ onClose, profile = null }: McpScreenProps) {
  const theme = useTheme()
  const { connection } = useGateway()
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [probes, setProbes] = useState<Record<string, McpProbe>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const controller = useMemo(
    () =>
      connection
        ? new McpController({
            gateway: chatGatewayFor(connection),
            openUrl: url => void Linking.openURL(url).catch(() => undefined)
          })
        : null,
    [connection]
  )

  const load = useCallback(async () => {
    if (!controller) {
      return
    }

    try {
      setServers(await controller.load(profile))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [controller, profile])

  useEffect(() => {
    void load()
  }, [load])

  useEscapeKey(() => setSelected(null), selected !== null)
  useHardwareBack(() => setSelected(null), selected !== null)

  const server = servers?.find(entry => entry.name === selected) ?? null

  const test = (name: string) => {
    if (!controller) {
      return
    }

    setBusy(name)
    setNotice(null)
    void controller
      .test(name, profile)
      .then(probe => {
        setProbes(current => ({ ...current, [name]: probe }))
        setNotice(probe.ok ? mcpStrings.testOk(probe.tools.length) : mcpStrings.testFailed(probe.error ?? ''))
      })
      .catch((cause: unknown) =>
        setNotice(mcpStrings.testFailed(cause instanceof Error ? cause.message : String(cause)))
      )
      .finally(() => setBusy(null))
  }

  const authorise = (name: string) => {
    if (!controller) {
      return
    }

    setBusy(name)
    setNotice(mcpStrings.authorising)
    void controller
      .authorise(name, profile)
      .then(probe => {
        setProbes(current => ({ ...current, [name]: probe }))
        setNotice(mcpStrings.authoriseOk)

        return load()
      })
      .catch((cause: unknown) =>
        setNotice(mcpStrings.authoriseFailed(cause instanceof Error ? cause.message : String(cause)))
      )
      .finally(() => setBusy(null))
  }

  if (server) {
    return (
      <McpDetail
        busy={busy === server.name}
        notice={notice}
        onAuthorise={() => authorise(server.name)}
        onBack={() => {
          setSelected(null)
          setNotice(null)
        }}
        onTest={() => test(server.name)}
        probe={probes[server.name] ?? null}
        server={server}
      />
    )
  }

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader back={mcpStrings.back} onBack={onClose} subtitle={mcpStrings.subtitle} title={mcpStrings.title} />

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
        {error ? (
          <Text color="dangerText" testID="mcp-error">
            {mcpStrings.failed(error)}
          </Text>
        ) : servers === null ? (
          <Text color="textMuted">{mcpStrings.loading}</Text>
        ) : servers.length === 0 ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {mcpStrings.emptyHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted">{mcpStrings.empty}</Text>
            </InsetRow>
          </InsetGroup>
        ) : (
          <InsetGroup>
            {servers.map(entry => (
              <ServerRow
                key={entry.name}
                needsAuth={probes[entry.name]?.needsAuth === true}
                onPress={() => setSelected(entry.name)}
                server={entry}
              />
            ))}
          </InsetGroup>
        )}

        {notice && !selected ? (
          <Text color="textMuted" testID="mcp-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        <InsetGroup
          footer={
            <Text color="textMuted" variant="meta">
              {mcpStrings.reloadHint}
            </Text>
          }
        >
          <InsetRow>
            <Button
              onPress={() => {
                // The confirm gate lives in `ReloadMcpSheet`, which the bot's
                // Capabilities sheet owns. Here the reload is a plain action on
                // a page the reader came to on purpose, so it asks in place.
                setNotice(null)
                void controller
                  ?.reload({ confirm: true })
                  .then(() => setNotice(mcpStrings.reload))
                  .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
              }}
              testID="mcp-reload"
              title={mcpStrings.reload}
              variant="secondary"
            />
          </InsetRow>
        </InsetGroup>
      </ScrollView>
    </Screen>
  )
}

function ServerRow({ server, needsAuth, onPress }: { server: McpServerView; needsAuth: boolean; onPress: () => void }) {
  const theme = useTheme()
  const state = needsAuth ? mcpStrings.needsAuth : mcpStrings.runtime[server.runtime]

  return (
    <Pressable
      accessibilityLabel={`${server.name}, ${state}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
        gap: theme.space.xxs,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      })}
      testID={`mcp-row-${server.name}`}
    >
      <Text>{server.name}</Text>
      <Text
        color={needsAuth || server.runtime === 'failed' ? 'dangerText' : 'textMuted'}
        testID={`mcp-state-${server.name}`}
        variant="meta"
      >
        {state}
        {server.toolCount ? ` · ${mcpStrings.toolCount(server.toolCount)}` : ''}
      </Text>
    </Pressable>
  )
}

function McpDetail({
  server,
  probe,
  busy,
  notice,
  onBack,
  onTest,
  onAuthorise
}: {
  server: McpServerView
  probe: McpProbe | null
  busy: boolean
  notice: string | null
  onBack: () => void
  onTest: () => void
  onAuthorise: () => void
}) {
  const theme = useTheme()

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader
        back={mcpStrings.detail.back}
        onBack={onBack}
        subtitle={mcpStrings.runtime[server.runtime]}
        title={server.name}
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
        <InsetGroup>
          <InsetValueRow label={mcpStrings.detail.transport} value={server.transport} />
          <InsetValueRow label={mcpStrings.detail.address} mono value={server.address} />
          <InsetValueRow label={mcpStrings.detail.auth} value={server.auth ?? mcpStrings.detail.authNone} />
        </InsetGroup>

        {server.env.length ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {mcpStrings.detail.envHint}
              </Text>
            }
            header={mcpStrings.detail.env}
          >
            {server.env.map(key => (
              <InsetRow key={key}>
                <Text variant="code">{key}</Text>
              </InsetRow>
            ))}
          </InsetGroup>
        ) : null}

        <InsetGroup>
          <InsetRow>
            <Button
              busy={busy}
              onPress={onTest}
              testID="mcp-test"
              title={busy ? mcpStrings.testing : mcpStrings.test}
              variant="secondary"
            />
          </InsetRow>
          {probe?.needsAuth ? (
            <InsetRow>
              <Button busy={busy} onPress={onAuthorise} testID="mcp-authorise" title={mcpStrings.authorise} />
            </InsetRow>
          ) : null}
        </InsetGroup>

        {notice ? (
          <Text color={probe && !probe.ok ? 'dangerText' : 'textMuted'} testID="mcp-detail-notice" variant="meta">
            {notice}
          </Text>
        ) : null}

        <InsetGroup header={mcpStrings.detail.tools}>
          {probe === null ? (
            <InsetRow>
              <Text color="textMuted" variant="meta">
                {mcpStrings.detail.toolsUnknown}
              </Text>
            </InsetRow>
          ) : probe.tools.length === 0 ? (
            <InsetRow>
              <Text color="textMuted" variant="meta">
                {mcpStrings.detail.toolsEmpty}
              </Text>
            </InsetRow>
          ) : (
            probe.tools.map(tool => (
              <InsetRow key={tool.name}>
                <View style={{ gap: theme.space.xxs }}>
                  <Text variant="code">{tool.name}</Text>
                  {tool.description ? (
                    <Text color="textMuted" variant="meta">
                      {tool.description}
                    </Text>
                  ) : null}
                </View>
              </InsetRow>
            ))
          )}
        </InsetGroup>
      </ScrollView>
    </Screen>
  )
}
