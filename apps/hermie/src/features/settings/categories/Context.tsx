/**
 * Settings → Context about you: what a bot is told about whoever is holding the
 * device. Nothing is written on a gateway with accounts until the notice on this
 * page is accepted.
 */
import { strings } from '../../../i18n/strings'
import { needsSharingNotice, useDeviceContextStore } from '../../../store/device-context'
import { ContextSection } from '../ContextSection'
import { SettingsPage } from '../navigation/SettingsPage'

export function useSummary(): string {
  const loaded = useDeviceContextStore(state => state.loaded)
  const pending = useDeviceContextStore(needsSharingNotice)
  const summary = strings.settings.categories.summary

  return loaded && !pending ? summary.shared : summary.notShared
}

export function Page() {
  return (
    <SettingsPage route="Context">
      <ContextSection />
    </SettingsPage>
  )
}
