import { normalizeBaseUrl, probeGateway } from '@hermie/gateway-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'

import { describeProbeError } from '../../../gateway/errors'
import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup, InsetRow, SecretField, Text, TextField } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { headerError, headerRecord, newHeaderRow, type OnboardingDraft } from '../draft'

/** Long enough that typing an address does not fire a probe per keystroke. */
export const PROBE_DEBOUNCE_MS = 500

export interface GatewayAddressStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
  /** Tests drive this to zero; the app uses the debounce above. */
  debounceMs?: number
}

export function GatewayAddressStep({ draft, update, debounceMs = PROBE_DEBOUNCE_MS }: GatewayAddressStepProps) {
  const theme = useTheme()
  const [advanced, setAdvanced] = useState(draft.headers.length > 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A probe is slower than typing, so answers can come back out of order. Every
  // run takes a ticket and a late answer with a stale ticket is dropped rather
  // than allowed to overwrite a newer result.
  const sequence = useRef(0)
  const updateRef = useRef(update)
  updateRef.current = update

  const raw = draft.rawAddress.trim()
  const headersKey = JSON.stringify(headerRecord(draft.headers))

  useEffect(() => {
    if (!raw) {
      sequence.current += 1
      setBusy(false)
      setError(null)
      updateRef.current({ probe: null, baseUrl: null })

      return
    }

    let normalized: string

    try {
      normalized = normalizeBaseUrl(raw)
    } catch (normalizeError) {
      sequence.current += 1
      setBusy(false)
      setError(describeProbeError(normalizeError, raw))
      updateRef.current({ probe: null, baseUrl: null })

      return
    }

    const ticket = ++sequence.current
    let cancelled = false
    setBusy(true)
    setError(null)

    const timer = setTimeout(() => {
      probeGateway(normalized, JSON.parse(headersKey) as Record<string, string>)
        .then(result => {
          if (cancelled || ticket !== sequence.current) {
            return
          }

          setBusy(false)
          setError(null)
          updateRef.current({ probe: result, baseUrl: normalized })
        })
        .catch(probeError => {
          if (cancelled || ticket !== sequence.current) {
            return
          }

          setBusy(false)
          setError(describeProbeError(probeError, normalized))
          updateRef.current({ probe: null, baseUrl: null })
        })
    }, debounceMs)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [debounceMs, headersKey, raw])

  const setHeader = useCallback(
    (id: string, patch: Partial<{ name: string; value: string }>) => {
      update({ headers: draft.headers.map(row => (row.id === id ? { ...row, ...patch } : row)) })
    },
    [draft.headers, update]
  )

  return (
    <View style={{ gap: theme.space.xl }}>
      <View style={{ gap: theme.space.sm }}>
        <Text variant="title">{strings.onboarding.address.title}</Text>
        <Text color="textMuted">{strings.onboarding.address.subtitle}</Text>
      </View>

      <InsetGroup header={strings.onboarding.address.label} footer={strings.onboarding.address.hint}>
        <InsetRow>
          <TextField
            testID="gateway-address"
            value={draft.rawAddress}
            onChangeText={next => update({ rawAddress: next })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            inputMode="url"
            // The address is one line and the probe runs while you type, so
            // Return has nothing left to submit; it should put the keyboard
            // away and uncover the footer.
            returnKeyType="done"
            placeholder={strings.onboarding.address.placeholder}
            accessibilityLabel={strings.onboarding.address.label}
          />
        </InsetRow>
      </InsetGroup>

      <ProbeLine busy={busy} error={error} draft={draft} />

      <View style={{ gap: theme.space.md }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: advanced }}
          onPress={() => setAdvanced(current => !current)}
          hitSlop={8}
        >
          <Text variant="preview" color="accent">
            {advanced ? `− ${strings.onboarding.address.advanced}` : `+ ${strings.onboarding.address.advanced}`}
          </Text>
        </Pressable>

        {advanced ? (
          <InsetGroup footer={strings.onboarding.address.advancedHint}>
            {draft.headers.map(row => (
              <InsetRow key={row.id} style={{ gap: theme.space.sm }}>
                <TextField
                  label={strings.onboarding.address.headerName}
                  value={row.name}
                  onChangeText={name => setHeader(row.id, { name })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  placeholder="CF-Access-Client-Id"
                  {...(headerError(row) ? { error: headerError(row) } : {})}
                />
                <SecretField
                  label={strings.onboarding.address.headerValue}
                  value={row.value}
                  onChangeText={value => setHeader(row.id, { value })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  concealLabel={strings.onboarding.address.hideValue}
                  revealLabel={strings.onboarding.address.showValue}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={strings.onboarding.address.removeHeader(row.name)}
                  onPress={() => update({ headers: draft.headers.filter(other => other.id !== row.id) })}
                  hitSlop={8}
                >
                  <Text variant="meta" color="dangerText">
                    {strings.common.remove}
                  </Text>
                </Pressable>
              </InsetRow>
            ))}
            <InsetButtonRow
              title={strings.onboarding.address.addHeader}
              onPress={() => update({ headers: [...draft.headers, newHeaderRow()] })}
            />
          </InsetGroup>
        ) : null}
      </View>
    </View>
  )
}

function ProbeLine({ busy, error, draft }: { busy: boolean; error: string | null; draft: OnboardingDraft }) {
  if (busy) {
    return (
      <Text color="textMuted" testID="probe-result">
        {strings.onboarding.address.probing}
      </Text>
    )
  }

  if (error) {
    return (
      <Text color="dangerText" testID="probe-error">
        {error}
      </Text>
    )
  }

  const probe = draft.probe

  if (!probe) {
    return null
  }

  if (!probe.authRequired) {
    return (
      <Text color="ok" testID="probe-result">
        {strings.onboarding.address.sessionTokenRequired(probe.version)}
      </Text>
    )
  }

  if (probe.providers.length === 0) {
    return (
      <Text color="dangerText" testID="probe-result">
        {strings.onboarding.address.signInRequiredNoProviders(probe.version)}
      </Text>
    )
  }

  return (
    <Text color="ok" testID="probe-result">
      {strings.onboarding.address.signInRequired(
        probe.version,
        probe.providers.map(provider => provider.displayName)
      )}
    </Text>
  )
}
