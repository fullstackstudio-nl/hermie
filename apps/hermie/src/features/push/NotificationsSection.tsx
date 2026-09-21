/**
 * Settings → Notifications: ADR-0017 as five switches and a sentence.
 *
 * Off by default, and off means off: nothing here asks for permission, obtains
 * a token or writes a row until the reader moves the first switch. That is not
 * only politeness — a permission dialog raised by opening a settings screen is
 * a dialog people say no to, and iOS only offers it once.
 *
 * The per-type switches and the preview switch are shown only while the section
 * is ON. A column of controls that do nothing is a column somebody has to reason
 * about, and their state is already visible in the one switch above them.
 *
 * **`preview` is the one with a warning under it.** ADR-0017's default is that a
 * notification says who and what KIND, never what was said, because it is
 * rendered by Apple, Google or a browser vendor on a lock screen. Turning that
 * off is a decision, so the hint says where the text will end up rather than
 * describing the switch.
 */
import { PUSH_TYPES, type PushType } from '@hermie/gateway-client/push'
import { useCallback, useEffect, useState } from 'react'

import { strings } from '../../i18n/strings'
import { usePushStore } from '../../store/push'
import { InsetGroup } from '../../ui/primitives'
import { SwitchRow } from '../../ui/sheets'
import type { PushPermission } from './platform-contract'
import type { PushSync } from './push-sync'

const TYPE_LABELS: Record<PushType, string> = {
  message: strings.settings.notifications.typeMessage,
  request: strings.settings.notifications.typeRequest,
  dm: strings.settings.notifications.typeDm,
  cron: strings.settings.notifications.typeCron
}

export interface NotificationsSectionProps {
  /** `null` before the gateway connection exists, which is when this renders nothing. */
  push: PushSync | null
  /** False where the platform has no notifications at all — the browser over http. */
  available?: boolean
  testID?: string
}

export function NotificationsSection({ push, available = true, testID = 'settings-push' }: NotificationsSectionProps) {
  const enabled = usePushStore(state => state.enabled)
  const types = usePushStore(state => state.types)
  const preview = usePushStore(state => state.preview)
  const setType = usePushStore(state => state.setType)
  const setPreview = usePushStore(state => state.setPreview)
  const [permission, setPermission] = useState<PushPermission>('undetermined')
  const [busy, setBusy] = useState(false)

  // Read once on mount and again after every change of the switch, because the
  // reader can have revoked it in system settings while the app was away and
  // this screen is where that has to become visible.
  useEffect(() => {
    let live = true

    void push?.permission().then(value => {
      if (live) {
        setPermission(value)
      }
    })

    return () => {
      live = false
    }
  }, [enabled, push])

  const onToggle = useCallback(
    (next: boolean) => {
      if (!push || busy) {
        return
      }

      setBusy(true)

      const settle = (): void => {
        setBusy(false)
        void push.permission().then(setPermission)
      }

      if (next) {
        void push.enable().then(settle).catch(settle)
      } else {
        void push.disable().then(settle).catch(settle)
      }
    },
    [busy, push]
  )

  if (!push) {
    return null
  }

  /*
    One footer slot, three things it could say, and they are not the same kind of
    statement. "Turned off in your device settings" is an instruction to go
    somewhere else; "this device cannot register" is a fact about the platform;
    the ordinary hint explains what the daemon is. They are ordered by how much
    they change what the reader should do next.
  */
  const footer = !available
    ? strings.settings.notifications.unavailable
    : permission === 'denied'
      ? strings.settings.notifications.denied
      : strings.settings.notifications.enabledHint

  return (
    <>
      <InsetGroup footer={footer} header={strings.settings.notifications.header}>
        <SwitchRow
          disabled={!available || busy}
          label={strings.settings.notifications.enabled}
          onChange={onToggle}
          testID={`${testID}-enabled`}
          value={enabled}
        />
      </InsetGroup>

      {enabled ? (
        <InsetGroup footer={strings.settings.notifications.typesHint} header={strings.settings.notifications.types}>
          {PUSH_TYPES.map(type => (
            <SwitchRow
              key={type}
              label={TYPE_LABELS[type]}
              onChange={on => setType(type, on)}
              testID={`${testID}-type-${type}`}
              value={types[type] === true}
            />
          ))}
        </InsetGroup>
      ) : null}

      {enabled ? (
        <InsetGroup footer={strings.settings.notifications.previewHint}>
          <SwitchRow
            label={strings.settings.notifications.preview}
            onChange={setPreview}
            testID={`${testID}-preview`}
            value={preview}
          />
        </InsetGroup>
      ) : null}
    </>
  )
}
