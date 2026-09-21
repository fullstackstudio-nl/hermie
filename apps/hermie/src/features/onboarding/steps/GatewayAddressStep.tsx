import { hasExplicitScheme, normalizeBaseUrl, resolveGatewayAddress } from '@hermie/gateway-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'

import { describeProbeError } from '../../../gateway/errors'
import { TransportNotice } from '../../../gateway/TransportNotice'
import { strings } from '../../../i18n/strings'
import { InsetButtonRow, InsetGroup, InsetRow, SecretField, Text, TextField } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { headerError, headerRecord, newHeaderRow, type OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

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
  // Only true when the user named no scheme and https did not answer. It is
  // said out loud rather than kept: a downgrade nobody is told about is the
  // thing worth avoiding, not the downgrade.
  const [foundOverHttp, setFoundOverHttp] = useState(false)

  // A probe is slower than typing, so answers can come back out of order. Every
  // run takes a ticket and a late answer with a stale ticket is dropped rather
  // than allowed to overwrite a newer result.
  const sequence = useRef(0)
  const updateRef = useRef(update)
  updateRef.current = update

  const raw = draft.rawAddress.trim()
  const headersKey = JSON.stringify(headerRecord(draft.headers))
  // The resolver tries https first and falls back to http only when the reader
  // left the scheme out, so which of the two is in flight is knowable here
  // without instrumenting the resolver.
  const pinnedScheme = raw && hasExplicitScheme(raw) ? raw.slice(0, raw.indexOf('://') + 3).toLowerCase() : null

  useEffect(() => {
    if (!raw) {
      sequence.current += 1
      setBusy(false)
      setError(null)
      setFoundOverHttp(false)
      updateRef.current({ probe: null, baseUrl: null })

      return
    }

    let normalized: string

    try {
      // Only to reject what is not an address at all, before a debounce and a
      // round trip. Which SCHEME answers is the resolver's question.
      normalized = normalizeBaseUrl(raw)
    } catch (normalizeError) {
      sequence.current += 1
      setBusy(false)
      setFoundOverHttp(false)
      setError(describeProbeError(normalizeError, raw))
      updateRef.current({ probe: null, baseUrl: null })

      return
    }

    // Not `normalized.startsWith('https://')` on its own: `normalizeBaseUrl`
    // puts that scheme on an address that named none, and those are the two
    // cases this has to tell apart.
    const httpsWasPinned = hasExplicitScheme(raw) && normalized.startsWith('https://')

    const ticket = ++sequence.current
    let cancelled = false
    setBusy(true)
    setError(null)

    const timer = setTimeout(() => {
      resolveGatewayAddress(raw, JSON.parse(headersKey) as Record<string, string>)
        .then(({ baseUrl, foundOverHttp: overHttp, ...result }) => {
          if (cancelled || ticket !== sequence.current) {
            return
          }

          setBusy(false)
          setError(null)
          setFoundOverHttp(overHttp)
          updateRef.current({ probe: result, baseUrl })
        })
        .catch(probeError => {
          if (cancelled || ticket !== sequence.current) {
            return
          }

          setBusy(false)
          setFoundOverHttp(false)
          setError(describeProbeError(probeError, normalized, httpsWasPinned))
          updateRef.current({ probe: null, baseUrl: null })
        })
    }, debounceMs)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [debounceMs, headersKey, raw])

  // Re-typing the address with the scheme spelled out is exactly what stops the
  // fallback from running again: an explicit `https://` is never downgraded.
  // The port and any path prefix come along — they are not the scheme's.
  const useHttpsInstead = useCallback(() => {
    const current = draft.baseUrl ?? draft.rawAddress.trim()

    update({ rawAddress: `https://${current.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}` })
  }, [draft.baseUrl, draft.rawAddress, update])

  const setHeader = useCallback(
    (id: string, patch: Partial<{ name: string; value: string }>) => {
      update({ headers: draft.headers.map(row => (row.id === id ? { ...row, ...patch } : row)) })
    },
    [draft.headers, update]
  )

  return (
    <View style={{ gap: theme.space.lg }}>
      <View style={{ gap: theme.space.sm }}>
        <Text color="textMuted" variant="micro">
          {strings.onboarding.address.label}
        </Text>
        {/*
          Outside an `InsetRow` on purpose, so `TextField` draws the sunk well
          the design board gives every editable thing. A row would have lent it
          its own chrome, which inside a card is a box around a box.
        */}
        <TextField
          accessibilityLabel={strings.onboarding.address.label}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          keyboardType="url"
          onChangeText={next => update({ rawAddress: next })}
          placeholder={strings.onboarding.address.placeholder}
          // The address is one line and the probe runs while you type, so
          // Return has nothing left to submit; it should put the keyboard
          // away and uncover the rest of the card.
          returnKeyType="done"
          testID="gateway-address"
          textContentType="URL"
          value={draft.rawAddress}
        />
        <Text color="textFaint" style={{ marginHorizontal: theme.space.xs }} variant="meta">
          {strings.onboarding.address.hint}
        </Text>
      </View>

      <View style={{ gap: theme.space.sm }}>
        <ProbeLine busy={busy} draft={draft} error={error} foundOverHttp={foundOverHttp} pinnedScheme={pinnedScheme} />
        <TransportNotice
          baseUrl={busy || error ? null : draft.baseUrl}
          onUseHttps={useHttpsInstead}
          testID="transport-notice"
        />
      </View>

      <View style={{ gap: theme.space.md }}>
        <Pressable
          accessibilityRole="button"
          aria-expanded={advanced}
          hitSlop={8}
          onPress={() => setAdvanced(current => !current)}
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
        >
          <Text color="accentText" variant="preview">
            {/* A static caret: a disclosure is not a thing that needs the reader. */}
            {advanced ? `▾ ${strings.onboarding.address.advanced}` : `▸ ${strings.onboarding.address.advanced}`}
          </Text>
        </Pressable>

        {advanced ? (
          <InsetGroup footer={strings.onboarding.address.advancedHint}>
            {draft.headers.map(row => (
              <InsetRow key={row.id} style={{ gap: theme.space.sm }}>
                <TextField
                  autoCapitalize="none"
                  autoCorrect={false}
                  label={strings.onboarding.address.headerName}
                  onChangeText={name => setHeader(row.id, { name })}
                  placeholder="CF-Access-Client-Id"
                  returnKeyType="done"
                  value={row.name}
                  {...(headerError(row) ? { error: headerError(row) } : {})}
                />
                <SecretField
                  autoCapitalize="none"
                  autoCorrect={false}
                  concealLabel={strings.onboarding.address.hideValue}
                  label={strings.onboarding.address.headerValue}
                  onChangeText={value => setHeader(row.id, { value })}
                  returnKeyType="done"
                  revealLabel={strings.onboarding.address.showValue}
                  value={row.value}
                />
                <Pressable
                  accessibilityLabel={strings.onboarding.address.removeHeader(row.name)}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => update({ headers: draft.headers.filter(other => other.id !== row.id) })}
                >
                  <Text color="dangerText" variant="meta">
                    {strings.common.remove}
                  </Text>
                </Pressable>
              </InsetRow>
            ))}
            <InsetButtonRow
              onPress={() => update({ headers: [...draft.headers, newHeaderRow()] })}
              title={strings.onboarding.address.addHeader}
            />
          </InsetGroup>
        ) : null}
      </View>
    </View>
  )
}

function ProbeLine({
  busy,
  error,
  draft,
  foundOverHttp,
  pinnedScheme
}: {
  busy: boolean
  error: string | null
  draft: OnboardingDraft
  foundOverHttp: boolean
  /** The scheme the reader typed, or `null` when they left it out. */
  pinnedScheme: string | null
}) {
  if (busy) {
    return (
      <StatusLine testID="probe-result" tone="checking">
        {pinnedScheme ? strings.onboarding.address.probingScheme(pinnedScheme) : strings.onboarding.address.probingBoth}
      </StatusLine>
    )
  }

  if (error) {
    return (
      <StatusLine testID="probe-error" tone="error">
        {error}
      </StatusLine>
    )
  }

  const probe = draft.probe

  if (!probe) {
    return null
  }

  // Which scheme answered is part of what the probe found, so it belongs on the
  // same line rather than in a notice the eye can skip. It is only said when
  // the reader left the scheme out, because that is the only time it was an
  // open question.
  const found = pinnedScheme
    ? ''
    : foundOverHttp
      ? ` · ${strings.transport.foundOverHttp}`
      : ` · ${strings.transport.foundOverHttps}`

  if (!probe.authRequired) {
    return (
      <StatusLine testID="probe-result" tone="ok">
        {`${strings.onboarding.address.sessionTokenRequired(probe.version)}${found}`}
      </StatusLine>
    )
  }

  if (probe.providers.length === 0) {
    return (
      <StatusLine testID="probe-result" tone="error">
        {`${strings.onboarding.address.signInRequiredNoProviders(probe.version)}${found}`}
      </StatusLine>
    )
  }

  return (
    <StatusLine testID="probe-result" tone="ok">
      {`${strings.onboarding.address.signInRequired(
        probe.version,
        probe.providers.map(provider => provider.displayName)
      )}${found}`}
    </StatusLine>
  )
}
