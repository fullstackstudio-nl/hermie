import { useCallback, useState } from 'react'
import { View } from 'react-native'

import { describeConnectionError } from '../../../gateway/errors'
import { strings } from '../../../i18n/strings'
import { Button, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, isTestCurrent, type OnboardingDraft } from '../draft'
import { StatusLine, type StatusTone } from '../StatusLine'
import { runConnectionTest, type ConnectionTestStage } from '../test-connection'

export interface TestConnectionStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

/** The checklist, in the order `runConnectionTest` actually works through it. */
const STAGES: ConnectionTestStage[] = ['rest', 'socket', 'profiles']

const STAGE_LABEL: Record<ConnectionTestStage, string> = {
  rest: strings.onboarding.test.checklist.rest,
  socket: strings.onboarding.test.checklist.socket,
  profiles: strings.onboarding.test.checklist.profiles
}

export function TestConnectionStep({ draft, update }: TestConnectionStepProps) {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How far the run got. It is reported by the test rather than guessed here,
  // because WHICH half failed is the whole diagnosis: REST refused is a
  // credential, the socket refused is a reverse proxy that drops upgrades.
  const [reached, setReached] = useState<ConnectionTestStage | null>(null)
  const current = isTestCurrent(draft)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    setReached(null)

    try {
      const outcome = await runConnectionTest(draft, undefined, setReached)

      // The test may have rotated the credential it dialled with; the draft has
      // to carry the live one into the save, not the one it started with.
      update({ test: outcome, ...(outcome.tokens ? { tokens: outcome.tokens } : {}) })
    } catch (testError) {
      update({ test: null })
      setError(describeConnectionError(testError, draft.baseUrl ?? ''))
    } finally {
      setBusy(false)
    }
  }, [draft, update])

  const passed = current && draft.test !== null

  return (
    <View style={{ gap: theme.space.lg }}>
      <View style={{ gap: theme.space.sm }}>
        {STAGES.map(stage => (
          <StatusLine
            key={stage}
            testID={`test-stage-${stage}`}
            tone={toneFor(stage, { busy, error, passed, reached })}
          >
            {STAGE_LABEL[stage]}
          </StatusLine>
        ))}
      </View>

      <Button
        busy={busy}
        onPress={() => void run()}
        title={busy ? strings.onboarding.test.running : strings.onboarding.test.run}
      />

      {error ? (
        <StatusLine testID="test-error" tone="error">
          {error}
        </StatusLine>
      ) : null}

      {passed && draft.test ? (
        <View style={{ gap: theme.space.xs }}>
          <StatusLine testID="test-result" tone="ok">
            {authModeOf(draft.probe) === 'native_pkce' && draft.test.userDisplayName
              ? strings.onboarding.test.connectedAs(draft.test.userDisplayName, draft.test.botCount)
              : strings.onboarding.test.connected(draft.test.botCount)}
          </StatusLine>
          {draft.test.botCount === 0 ? (
            <Text color="textMuted" variant="meta">
              {strings.onboarding.test.noBots}
            </Text>
          ) : null}
        </View>
      ) : null}

      {!busy && !error && !passed ? (
        <Text color="textMuted" testID="test-required" variant="meta">
          {draft.test ? strings.onboarding.test.invalidated : strings.onboarding.test.required}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * Which dot a checklist row gets.
 *
 * A pass marks all three regardless of what the run reported, so a caller that
 * cannot report stages — a test double, or an older code path — still produces
 * an honest checklist rather than three hollow rings beside "Connected".
 */
function toneFor(
  stage: ConnectionTestStage,
  state: { busy: boolean; error: string | null; passed: boolean; reached: ConnectionTestStage | null }
): StatusTone {
  if (state.passed) {
    return 'ok'
  }

  const index = STAGES.indexOf(stage)
  const reachedIndex = state.reached === null ? -1 : STAGES.indexOf(state.reached)

  if (index < reachedIndex) {
    return 'ok'
  }

  if (index > reachedIndex) {
    return 'pending'
  }

  // The stage the run stopped on: still working, or the one that failed.
  return state.busy ? 'checking' : state.error ? 'error' : 'pending'
}
