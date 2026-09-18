import { useCallback, useState } from 'react'
import { View } from 'react-native'

import { describeConnectionError } from '../../../gateway/errors'
import { strings } from '../../../i18n/strings'
import { Button, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, isTestCurrent, type OnboardingDraft } from '../draft'
import { runConnectionTest } from '../test-connection'

export interface TestConnectionStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

export function TestConnectionStep({ draft, update }: TestConnectionStepProps) {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = isTestCurrent(draft)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)

    try {
      update({ test: await runConnectionTest(draft) })
    } catch (testError) {
      update({ test: null })
      setError(describeConnectionError(testError, draft.baseUrl ?? ''))
    } finally {
      setBusy(false)
    }
  }, [draft, update])

  return (
    <View style={{ gap: theme.space.xl }}>
      <View style={{ gap: theme.space.sm }}>
        <Text variant="title">{strings.onboarding.test.title}</Text>
        <Text color="textMuted">{strings.onboarding.test.subtitle}</Text>
      </View>

      <Button
        title={busy ? strings.onboarding.test.running : strings.onboarding.test.run}
        onPress={() => void run()}
        busy={busy}
      />

      {error ? (
        <Text color="danger" testID="test-error">
          {error}
        </Text>
      ) : null}

      {current && draft.test ? (
        <View style={{ gap: theme.space.xs }}>
          <Text color="success" testID="test-result">
            {authModeOf(draft.probe) === 'native_pkce' && draft.test.userDisplayName
              ? strings.onboarding.test.connectedAs(draft.test.userDisplayName, draft.test.botCount)
              : strings.onboarding.test.connected(draft.test.botCount)}
          </Text>
          {draft.test.botCount === 0 ? (
            <Text variant="caption" color="textMuted">
              {strings.onboarding.test.noBots}
            </Text>
          ) : null}
        </View>
      ) : null}

      {!busy && !error && !current ? (
        <Text variant="caption" color="textMuted" testID="test-required">
          {draft.test ? strings.onboarding.test.invalidated : strings.onboarding.test.required}
        </Text>
      ) : null}
    </View>
  )
}
