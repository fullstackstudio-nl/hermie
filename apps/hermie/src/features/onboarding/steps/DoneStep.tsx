import { View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { InsetGroup, InsetValueRow, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, type OnboardingDraft } from '../draft'

export interface DoneStepProps {
  draft: OnboardingDraft
  error: string | null
}

export function DoneStep({ draft, error }: DoneStepProps) {
  const theme = useTheme()
  const authMode = authModeOf(draft.probe)

  return (
    <View style={{ gap: theme.space.xl }}>
      <View style={{ gap: theme.space.sm }}>
        <Text variant="title">{strings.onboarding.done.title}</Text>
        <Text color="textMuted">{strings.onboarding.done.subtitle}</Text>
      </View>

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
        <Text color="danger" testID="done-error">
          {error}
        </Text>
      ) : null}
    </View>
  )
}
