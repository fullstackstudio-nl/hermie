import { type GatewayConnection, probeGateway, type ConnectionStatus, type ProbeResult } from '@hermie/gateway-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, TextInput, View } from 'react-native'

import { createGatewayConnection } from '../../gateway'
import { strings } from '../../i18n/strings'
import { hasHardwareKeyboard } from '../../platform/keyboard-modifiers'
import { RUNS_ON_MAC } from '../../platform/runs-on-mac'
import { Button, Screen, Text } from '../../ui/primitives'
import { GLASS_MATERIAL } from '../../ui/glass'
import { useTheme } from '../../ui/theme'

/**
 * A developer screen, not a product screen: it exists so a build on a real
 * device can be pointed at the fake gateway (or the test gateway) and prove the
 * transport works before any of the chat UI exists. The onboarding wizard in M2
 * replaces it for real users; native PKCE sign-in is not wired up here.
 */

// The Android emulator reaches the host machine through 10.0.2.2, never localhost.
const DEFAULT_BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:9119' : 'http://localhost:9119'

export function DebugConnectionScreen({ onClose }: { onClose?: () => void }) {
  const theme = useTheme()
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [sessionToken, setSessionToken] = useState('fake-session-token')
  const [showToken, setShowToken] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [transitions, setTransitions] = useState<string[]>([])
  const [profiles, setProfiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const connectionRef = useRef<GatewayConnection | null>(null)

  const disconnect = useCallback(() => {
    connectionRef.current?.stop()
    connectionRef.current = null
  }, [])

  useEffect(() => disconnect, [disconnect])

  const runProbe = useCallback(async () => {
    setError(null)
    setProbe(null)

    try {
      setProbe(await probeGateway(baseUrl))
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : String(probeError))
    }
  }, [baseUrl])

  const connect = useCallback(() => {
    disconnect()
    setError(null)
    setProfiles([])
    setTransitions([])

    const connection = createGatewayConnection({
      config: { baseUrl, authMode: 'session_token' },
      sessionToken
    })
    connectionRef.current = connection

    connection.onStatus((next, statusError) => {
      setStatus(next)
      setTransitions(seen => [...seen, next])

      if (statusError && next !== 'ready') {
        setError(statusError.message)
      }

      if (next !== 'ready') {
        return
      }

      connection
        .request('profiles.list', { include_sessions: true })
        .then(result => setProfiles((result.profiles ?? []).map(profile => profile.name)))
        .catch(listError => setError(listError instanceof Error ? listError.message : String(listError)))
    })

    connection.start()
  }, [baseUrl, disconnect, sessionToken])

  const inputStyle = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    color: theme.colors.text,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: theme.space.md, paddingVertical: theme.space.lg }}>
        <Text variant="display">Connection test</Text>
        <Text color="textMuted">
          Points a raw gateway connection at an address and reports what happens. Session-token gateways only; signing
          in with a provider arrives with onboarding.
        </Text>

        <View style={{ gap: theme.space.xs }}>
          <Text variant="caption" color="textMuted">
            GATEWAY ADDRESS
          </Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            placeholder={DEFAULT_BASE_URL}
            placeholderTextColor={theme.colors.textMuted}
            style={inputStyle}
          />
        </View>

        <View style={{ gap: theme.space.xs }}>
          <Text variant="caption" color="textMuted">
            SESSION TOKEN
          </Text>
          <TextInput
            value={sessionToken}
            onChangeText={setSessionToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!showToken}
            style={inputStyle}
          />
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setShowToken(current => !current)}>
            <Text color="accent" variant="caption">
              {showToken ? strings.onboarding.signIn.hideToken : strings.onboarding.signIn.showToken}
            </Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
          <Button title="Probe" variant="secondary" onPress={() => void runProbe()} style={{ flex: 1 }} />
          <Button title="Connect" onPress={connect} style={{ flex: 1 }} />
          <Button title="Stop" variant="secondary" onPress={disconnect} style={{ flex: 1 }} />
        </View>

        {error ? (
          <Text color="danger" testID="debug-error">
            {error}
          </Text>
        ) : null}

        {probe ? (
          <View style={{ gap: theme.space.xxs }}>
            <Text variant="heading">Probe</Text>
            <Text color="textMuted">version {probe.version || 'unknown'}</Text>
            <Text color="textMuted">auth required: {String(probe.authRequired)}</Text>
            <Text color="textMuted">flows: {probe.authFlows.join(', ') || 'none'}</Text>
            <Text color="textMuted">native PKCE: {String(probe.supportsNativePkce)}</Text>
            <Text color="textMuted">
              providers: {probe.providers.map(provider => provider.displayName).join(', ') || 'none'}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: theme.space.xxs }}>
          <Text variant="heading">Runtime</Text>
          <Text color="textMuted" testID="debug-runs-on-mac">
            iOS app on a Mac: {String(RUNS_ON_MAC)}
          </Text>
          <Text color="textMuted" testID="debug-hardware-keyboard">
            hardware keyboard: {String(hasHardwareKeyboard())}
          </Text>
          {/*
            Which material the glass surfaces are actually drawing. It is not
            knowable from a screenshot — the native material and the blur
            fallback look similar over a light wallpaper — and it is the first
            thing to check when a surface looks flat.
          */}
          <Text color="textMuted" testID="debug-glass-material">
            glass material: {GLASS_MATERIAL}
          </Text>
          <Text color="textMuted" testID="debug-reduce-transparency">
            reduce transparency: {String(theme.reduceTransparency)} · reduce motion: {String(theme.reduceMotion)}
          </Text>
        </View>

        <View style={{ gap: theme.space.xxs }}>
          <Text variant="heading">Status</Text>
          <Text testID="debug-status">{status}</Text>
          <Text variant="caption" color="textMuted">
            {transitions.join(' → ') || 'not started'}
          </Text>
        </View>

        {profiles.length > 0 ? (
          <View style={{ gap: theme.space.xxs }}>
            <Text variant="heading">profiles.list</Text>
            <Text testID="debug-profiles">{profiles.join(', ')}</Text>
          </View>
        ) : null}

        {onClose ? <Button title="Back to settings" variant="secondary" onPress={onClose} /> : null}
      </ScrollView>
    </Screen>
  )
}
