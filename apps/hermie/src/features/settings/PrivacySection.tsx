/**
 * Privacy & security: today, the app lock and nothing else.
 *
 * The section exists as its own group rather than as a row under Appearance
 * because of what the next thing in it will be. A lock, what a notification
 * says on a locked screen, what a bot is told about the device — these are the
 * questions a reader comes to a settings screen looking for a single place to
 * answer, and a lock filed under "Chat" is a lock nobody finds.
 */
import { useEffect, useState } from 'react'

import { strings } from '../../i18n/strings'
import { biometrics } from '../../platform/biometrics'
import type { BiometricEnrolment } from '../../platform/platform-contracts'
import { InsetGroup, InsetRow, Text } from '../../ui/primitives'
import { SegmentedRow } from '../../ui/sheets'
import { LOCK_THRESHOLDS, type LockThreshold, useLockStore } from '../lock'

const OPTIONS: { value: LockThreshold; label: string }[] = LOCK_THRESHOLDS.map(value => ({
  value,
  label: strings.settings.lock.options[value]
}))

/**
 * The sentence under the picker, which is doing more work than a hint usually
 * does: three of its four cases are the reasons the picker will not take.
 */
function footerFor(enrolment: BiometricEnrolment | null, threshold: LockThreshold): string {
  switch (enrolment) {
    case 'none':
      return strings.settings.lock.noEnrolment
    case 'unavailable':
      return strings.settings.lock.unavailable
    case 'passcode':
      return strings.settings.lock.passcodeOnly
    default:
      return threshold === 'off' ? strings.settings.lock.hint : strings.settings.lock.hintOn
  }
}

export function PrivacySection() {
  const threshold = useLockStore(state => state.machine.threshold)
  const enrolment = useLockStore(state => state.enrolment)
  const checkEnrolment = useLockStore(state => state.checkEnrolment)
  const setThreshold = useLockStore(state => state.setThreshold)
  const [refused, setRefused] = useState(false)

  // Asked here rather than at launch: it is a native round trip nobody needs
  // until they are looking at this row, and what it answers can change between
  // launches — a passcode is a thing people add and remove.
  useEffect(() => {
    if (biometrics.available) {
      void checkEnrolment()
    }
  }, [checkEnrolment])

  /*
    The browser says so and offers nothing.

    A plate drawn over this app's own DOM is not a lock: the page and the thing
    that would enforce it are the same JavaScript, and a tab is closed by the
    operating system rather than by us. Offering a switch that cannot do what
    its name says is worse than the note. See `platform/biometrics.web.ts`.
  */
  if (!biometrics.available) {
    return (
      <InsetGroup header={strings.settings.privacy}>
        <InsetRow>
          <Text color="textMuted" variant="meta">
            {strings.settings.lock.web}
          </Text>
        </InsetRow>
      </InsetGroup>
    )
  }

  return (
    <InsetGroup
      footer={refused ? strings.settings.lock.noEnrolment : footerFor(enrolment, threshold)}
      header={strings.settings.privacy}
    >
      <SegmentedRow
        label={strings.settings.lock.label}
        onChange={(next: LockThreshold) => {
          void setThreshold(next).then(accepted => setRefused(!accepted))
        }}
        options={OPTIONS}
        testID="settings-app-lock"
        value={threshold}
      />
    </InsetGroup>
  )
}
