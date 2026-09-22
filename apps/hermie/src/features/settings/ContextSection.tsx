/**
 * Settings → Context: what a bot is told about the person it is talking to.
 *
 * The gateway-side plugin renders this into a bot's system prompt once per
 * session. Three things about the layout follow from that and from where the
 * section is actually kept, which is the gateway's own profile:
 *
 *  - **The notice comes first and it blocks.** On a gateway with accounts,
 *    "everyone with access to this gateway can read it" is true of the device
 *    facts as much as of the free text, and those are sent without being asked
 *    about. So on such a gateway nothing at all is projected until the reader
 *    has been shown that sentence and pressed the button — which is what turns
 *    "the first save" into a moment they chose. A session-token gateway has no
 *    accounts and therefore no second reader, so it skips this entirely.
 *  - **The device facts are shown, not described.** A row that said "your
 *    device model is sent" would leave the reader guessing what their device
 *    model IS, and on iOS it is whatever they named the phone. Printing the
 *    five values back is the only honest version.
 *  - **The per-bot notes are a field per bot, in roster order.** A note is
 *    addressed to one conversation, and a single field with a bot picker above
 *    it would hide the fact that three of them already have one.
 *  - **The name switch shows the DECISION, and the name is a row of its own.**
 *    The switch used to be rendered from "the setting, and a name to use it
 *    on", so a gateway that names nobody showed it off while the setting was
 *    on — and an off switch says "this is not being sent", which was the one
 *    thing it did not mean. The row under it is the same honesty as the device
 *    facts: the name that will travel, printed, rather than described.
 */
import { CONTEXT_LIMITS } from '@hermie/gateway-client/context'
import { useCallback } from 'react'

import { strings } from '../../i18n/strings'
import { useBotsStore } from '../../store/bots'
import { effectiveDisplayName, needsSharingNotice, useDeviceContextStore } from '../../store/device-context'
import { InsetButtonRow, InsetGroup, InsetRow, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { SwitchRow } from '../../ui/sheets'

const stamp = (): number => Math.floor(Date.now() / 1000)

export interface ContextSectionProps {
  testID?: string
}

export function ContextSection({ testID = 'settings-context' }: ContextSectionProps) {
  const loaded = useDeviceContextStore(state => state.loaded)
  const baseUrl = useDeviceContextStore(state => state.baseUrl)
  const displayName = useDeviceContextStore(effectiveDisplayName)
  const shareDisplayName = useDeviceContextStore(state => state.shareDisplayName)
  const shareAbout = useDeviceContextStore(state => state.shareAbout)
  const about = useDeviceContextStore(state => state.about)
  const perBot = useDeviceContextStore(state => state.perBot)
  const facts = useDeviceContextStore(state => state.facts)
  const pendingNotice = useDeviceContextStore(needsSharingNotice)

  const setShareDisplayName = useDeviceContextStore(state => state.setShareDisplayName)
  const setShareAbout = useDeviceContextStore(state => state.setShareAbout)
  const setAbout = useDeviceContextStore(state => state.setAbout)
  const setBotNote = useDeviceContextStore(state => state.setBotNote)
  const acknowledge = useDeviceContextStore(state => state.acknowledge)

  const bots = useBotsStore(state => state.bots)
  const text = strings.settings.context

  const onAcknowledge = useCallback(() => acknowledge(baseUrl), [acknowledge, baseUrl])

  if (!loaded) {
    return null
  }

  const value = (raw: string): string => raw || text.deviceUnknown

  /*
    The notice is the whole section while it stands. Showing the switches under
    it would be showing controls whose effect is suspended, and a reader who
    moved one would reasonably believe something had been sent.
  */
  if (pendingNotice) {
    return (
      <InsetGroup footer={text.noticePending} header={text.header}>
        <InsetRow>
          <Text variant="body">{text.noticeTitle}</Text>
          <Text color="textMuted" testID={`${testID}-notice`} variant="meta">
            {text.notice}
          </Text>
        </InsetRow>
        <InsetButtonRow onPress={onAcknowledge} testID={`${testID}-accept`} title={text.noticeConfirm} />
      </InsetGroup>
    )
  }

  return (
    <>
      <InsetGroup footer={text.hint} header={text.header}>
        <SwitchRow
          label={text.displayName}
          onChange={on => setShareDisplayName(on, stamp())}
          testID={`${testID}-name`}
          value={shareDisplayName}
        />
        <InsetValueRow
          detail={displayName ? text.displayNameSource : undefined}
          label={text.displayNameValue}
          value={displayName || text.displayNameNone}
        />
      </InsetGroup>

      <InsetGroup footer={text.aboutHint}>
        <SwitchRow
          label={text.about}
          onChange={on => setShareAbout(on, stamp())}
          testID={`${testID}-about-enabled`}
          value={shareAbout}
        />
        {shareAbout ? (
          <InsetRow>
            <TextField
              multiline
              maxLength={CONTEXT_LIMITS.about}
              onChangeText={next => setAbout(next, stamp())}
              placeholder={text.aboutPlaceholder}
              testID={`${testID}-about`}
              value={about}
            />
            <Text color="textMuted" variant="meta">
              {text.aboutCount(about.length, CONTEXT_LIMITS.about)}
            </Text>
          </InsetRow>
        ) : null}
      </InsetGroup>

      <InsetGroup footer={text.deviceHint} header={text.device} testID={`${testID}-device`}>
        <InsetValueRow label={text.deviceModel} value={value(facts.model)} />
        <InsetValueRow label={text.deviceOs} value={value(facts.os)} />
        <InsetValueRow label={text.deviceApp} value={value(facts.appVersion)} />
        <InsetValueRow label={text.deviceTimezone} value={value(facts.timezone)} />
        <InsetValueRow label={text.deviceLocale} value={value(facts.locale)} />
      </InsetGroup>

      <InsetGroup footer={text.perBotHint} header={text.perBot}>
        {bots.length ? (
          bots.map(bot => (
            <InsetRow key={bot.name}>
              <TextField
                label={bot.displayName || bot.name}
                maxLength={CONTEXT_LIMITS.perBot}
                onChangeText={next => setBotNote(bot.name, next, stamp())}
                placeholder={text.perBotPlaceholder}
                testID={`${testID}-bot-${bot.name}`}
                value={perBot[bot.name] ?? ''}
              />
            </InsetRow>
          ))
        ) : (
          <InsetRow>
            <Text color="textMuted" variant="meta">
              {text.perBotEmpty}
            </Text>
          </InsetRow>
        )}
      </InsetGroup>
    </>
  )
}
