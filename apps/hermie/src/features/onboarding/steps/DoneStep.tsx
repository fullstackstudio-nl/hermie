import { View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { InsetGroup, InsetValueRow } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, type OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

export interface DoneStepProps {
  draft: OnboardingDraft
  error: string | null
}

export function DoneStep({ draft, error }: DoneStepProps) {
  const theme = useTheme()
  const authMode = authModeOf(draft.probe)

  return (
    <View style={{ gap: theme.space.md }}>
      <InsetGroup header={strings.onboarding.done.gateway}>
        <InsetValueRow label={strings.settings.address} value={draft.baseUrl ?? ''} />
        <InsetValueRow
          label={strings.settings.provider}
          value={
            authMode === 'session_token'
              ? strings.settings.authModeToken
              : (draft.provider?.displayName ?? strings.settings.unknown)
          }
        />
        <InsetValueRow label={strings.settings.version} value={draft.probe?.version || strings.settings.unknown} />
        {draft.test?.userDisplayName ? (
          <InsetValueRow label={strings.settings.user} value={draft.test.userDisplayName} />
        ) : null}
      </InsetGroup>

      {error ? (
        <StatusLine testID="done-error" tone="error">
          {error}
        </StatusLine>
      ) : null}
    </View>
  )
}
