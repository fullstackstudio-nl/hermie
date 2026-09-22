/**
 * Settings → Privacy & security: the app lock. Per device, and never carried to
 * another one by ADR-0016's sync.
 *
 * The control is still the segmented row `PrivacySection` draws; HERM-106 turns
 * it into a pushed `LockThreshold` picker, which is why this is a page of its
 * own already.
 */
import { strings } from '../../../i18n/strings'
import { biometrics } from '../../../platform/biometrics'
import { useLockStore } from '../../lock'
import { SettingsPage } from '../navigation/SettingsPage'
import { PrivacySection } from '../PrivacySection'

export function useSummary(): string {
  const threshold = useLockStore(state => state.machine.threshold)

  return biometrics.available
    ? strings.settings.lock.options[threshold]
    : strings.settings.categories.summary.lockBrowser
}

export function Page() {
  return (
    <SettingsPage route="Privacy">
      <PrivacySection />
    </SettingsPage>
  )
}
