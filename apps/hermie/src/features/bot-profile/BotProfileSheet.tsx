/**
 * One bot's profile, as a sheet.
 *
 * Reached two ways — the chat header's pill and the row menu's **Edit profile**
 * — because those are the two places a reader is already looking at the bot
 * they mean. Both open THIS component; there is no second, smaller editor.
 *
 * ## What saves when
 *
 * The sheet is deliberately not one big Save. Three of its four editable things
 * write the moment they are touched, because they are local or already
 * debounced, and only the two that cost a round trip wait for a button:
 *
 *  - **Colour** calls `chat-layout`'s `setAccent` on the tap. It is the chat
 *    list's own setting, it rides to the gateway with the rest of the
 *    arrangement on ADR-0016's debounce, and a swatch that needed confirming
 *    would be the only one in the app that did.
 *  - **The per-bot note** calls `setBotNote` as it is typed, exactly as the same
 *    field in Settings → Context does. The device-context store stamps and
 *    persists; the `ui_meta` bridge notices the projection changed and sends it.
 *  - **Description and photo** are `profiles.configure` and
 *    `profiles.set_asset`, which are writes to the profile on the gateway's
 *    disk. Those wait for Save, and Save is what reports a failure.
 *
 * ## The identity block is read-only apart from the name, and that is the point
 *
 * Model, provider, session id and gateway version are facts, not settings —
 * this sheet is not the model picker, which is the chat options sheet's job and
 * is a guarded call with a confirmation of its own.
 *
 * The NAME used to be a fact too, with the sentence "Set on the gateway, in
 * this profile." beside it. That was true of `profiles.configure`, which
 * carries a description and no display name — and it was never true of the
 * REST route beside it. Core serves `PATCH /api/profiles/{name}`, so the name
 * is a field now, and `features/bot-rename` owns it because which name it edits
 * depends on the profile: `default` takes a display name and keeps its id,
 * every other profile is really RENAMED. The second case needs `http` and it
 * needs the stores rekeyed, both of which live there.
 *
 * ## The sharing notice is not asked twice
 *
 * On a gateway with accounts, nothing is projected into the context section
 * until the reader has been shown who can read it and said yes — and that
 * answer belongs to the gateway, not to the screen it was given on. So this
 * reads the same `needsSharingNotice` and calls the same `acknowledge` as
 * Settings → Context: a reader who accepted it there is not asked here, and
 * accepting it here settles it there.
 */
import type { GatewayHttp } from '@hermie/gateway-client'
import { CONTEXT_LIMITS } from '@hermie/gateway-client/context'
import { prettyModelName, type ContextUsage } from '@hermie/transcript'
import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'

import type { ChatGateway } from '../../gateway/link'
import { strings } from '../../i18n/strings'
import { contextSummary } from '../../chat-ui/ContextMeter'
import { Avatar } from '../../chat-ui/primitives/Avatar'
import { chatStrings } from '../../chat-ui/strings'
import { useChatLayoutStore } from '../../store/chat-layout'
import { effectiveDisplayName, needsSharingNotice, useDeviceContextStore } from '../../store/device-context'
import { botNames, useNameOrder } from '../../store/bot-names'
import type { Bot } from '../../store/bots'
import { AccentSwatches } from '../../ui/AccentSwatches'
import { BottomSheet } from '../../ui/BottomSheet'
import { Button, InsetButtonRow, InsetGroup, InsetRow, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { AVATAR_SIZE } from '../../ui/tokens'
import { asRenameError, BotNameFields, botNameChanged, initialBotName, saveBotName } from '../bot-rename'
import { memoryStrings } from '../memory/strings'
import { CapabilitiesSheet } from '../profiles/CapabilitiesSheet'
import { profileStrings } from '../profiles/strings'
import { clearAvatar, changesFor, saveDescription, uploadAvatar } from './bot-profile-controller'
import { pickAvatar } from './avatar'

const stamp = (): number => Math.floor(Date.now() / 1000)

export interface BotProfileSheetProps {
  visible: boolean
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  bot: Bot
  /** The picture the roster already loaded, if any. */
  avatarUri?: string
  /** Null while the connection is down; Save is disabled rather than hidden. */
  gateway: ChatGateway | null
  /**
   * The REST half, for the one thing on this sheet that is not a socket call.
   *
   * Absent means the name rows go back to being read-only facts: renaming is
   * `PATCH /api/profiles/{name}` and nothing else on this connection can do it,
   * so an editable field over a gateway with no REST surface would be a field
   * whose Save has nowhere to go.
   */
  http?: GatewayHttp | null
  /** What the gateway reported about itself when it was configured. */
  gatewayVersion?: string
  /**
   * How full this bot's canonical session is, or nothing.
   *
   * Read-only here, like everything else in the About group: the profile sheet
   * describes the bot, and a context window is a fact about the conversation
   * rather than a setting on it. Absent means the gateway did not report a
   * window size and the row is not drawn — see `contextUsageOf`.
   */
  contextUsage?: ContextUsage | null
  /**
   * Open this bot's memory browser. The row is not drawn without it.
   *
   * A callback rather than a page this sheet presents itself: the memory
   * browser is a SCREEN, and a screen opened from inside a `Modal` would be a
   * second modal over the first — which `ChatSheetHost` exists to avoid, and
   * which iOS drops when the first is still dismissing. So the host that opened
   * this sheet is the thing that swaps it for the page.
   */
  onOpenMemory?: () => void
  /** A save landed: the roster should re-read so the new values reach every surface. */
  onSaved?: () => void
  testID?: string
}

export function BotProfileSheet({
  visible,
  onClose,
  onClosed,
  bot,
  avatarUri,
  gateway,
  http,
  gatewayVersion,
  contextUsage,
  onOpenMemory,
  onSaved,
  testID = 'bot-profile'
}: BotProfileSheetProps) {
  const theme = useTheme()
  const text = strings.botProfile
  /* The same two lines every other surface draws, in this reader's own order. */
  const names = botNames(bot, useNameOrder())

  const [description, setDescription] = useState(bot.description)
  /* The name field's draft. Which NAME it holds is `initialBotName`'s decision. */
  const [name, setName] = useState(() => initialBotName(bot))
  /**
   * The gateway took the name and part of the local move did not land.
   *
   * Separate from `error` because it is not a failure to retry: the rename
   * happened, and pressing Save again would aim at a profile that is gone.
   */
  const [warning, setWarning] = useState<string | null>(null)
  /** A picked picture, `null` to remove the current one, `undefined` to leave it. */
  const [avatar, setAvatar] = useState<{ base64: string; uri: string } | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCapabilities, setShowCapabilities] = useState(false)

  /*
    Reopening on a different bot — which the wide layout does without unmounting
    the sheet — has to start from that bot's values rather than the last one's.

    Keyed on the NAME alone, and the description is deliberately not a
    dependency. The roster re-reads on a poll, on a reconnect and on every save,
    and each of those rewrites `bot.description` with the gateway's copy; an
    effect that followed it would wipe a half-typed edit the moment a poll
    landed underneath the reader. The name is the only thing here that means
    "this is a different bot now".
  */
  useEffect(() => {
    setDescription(bot.description)
    setName(initialBotName(bot))
    setAvatar(undefined)
    setError(null)
    setWarning(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- following `bot.description` or `bot.displayName` would let a roster poll overwrite what is being typed; see above.
  }, [bot.name])

  const accent = useChatLayoutStore(state => state.accents[bot.name] ?? 'default')
  const setAccent = useChatLayoutStore(state => state.setAccent)

  const note = useDeviceContextStore(state => state.perBot[bot.name] ?? '')
  const setBotNote = useDeviceContextStore(state => state.setBotNote)
  const shareDisplayName = useDeviceContextStore(state => state.shareDisplayName)
  const shareAbout = useDeviceContextStore(state => state.shareAbout)
  // The same fallback ladder the Settings row prints, so this line cannot say a
  // name is withheld while the projection is sending one.
  const contextDisplayName = useDeviceContextStore(effectiveDisplayName)
  const contextAbout = useDeviceContextStore(state => state.about)
  const pendingNotice = useDeviceContextStore(needsSharingNotice)
  const contextBaseUrl = useDeviceContextStore(state => state.baseUrl)
  const acknowledge = useDeviceContextStore(state => state.acknowledge)

  const onPickPhoto = useCallback(async () => {
    setError(null)

    try {
      const picked = await pickAvatar()

      if (picked) {
        setAvatar(picked)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text.photoFailed)
    }
  }, [text.photoFailed])

  // `undefined` leave it, `null` remove it, a string upload it — the three
  // states the draft distinguishes, flattened out of the picked object.
  const pickedBytes: string | null | undefined = avatar === undefined ? undefined : (avatar?.base64 ?? null)
  const changes = changesFor({ description: bot.description }, { description, avatar: pickedBytes })
  /* The name travels on the REST half, so it is its own question from `changes`. */
  const nameChanged = Boolean(http) && botNameChanged(initialBotName(bot), name)

  const onSave = useCallback(async () => {
    if (!gateway) {
      return
    }

    setBusy(true)
    setError(null)
    setWarning(null)

    try {
      if (changes.description !== null) {
        await saveDescription({ gateway, botName: bot.name }, changes.description)
      }

      // The picture second, so a description that saved is not undone by a
      // photo that did not. Both are independent writes on the gateway anyway.
      if (avatar === null) {
        await clearAvatar({ gateway, botName: bot.name })
      } else if (avatar) {
        await uploadAvatar({ gateway, botName: bot.name }, avatar.base64)
      }

      /*
        The name LAST, and not because it is least important. On every profile
        but `default` it really renames the profile, so the two calls above —
        both of which address the profile by its current name — would be aimed
        at a name that no longer exists if the order were the other way round.
      */
      if (nameChanged && http) {
        const saved = await saveBotName({ http, bot, draft: name })

        if (saved.warning) {
          // The rename landed; the local half did not, all of it. Reported and
          // the sheet stays open, because closing on it would hide the only
          // sentence that says which part to expect back after a reconnect.
          setWarning(saved.warning)
          onSaved?.()

          return
        }
      }

      onSaved?.()
      onClose()
    } catch (failure) {
      setError(
        nameChanged
          ? asRenameError(failure, bot.name).message
          : failure instanceof Error
            ? failure.message
            : text.saveFailed
      )
    } finally {
      setBusy(false)
    }
  }, [avatar, bot, changes.description, gateway, http, name, nameChanged, onClose, onSaved, text.saveFailed])

  /*
    What this bot gets BESIDES the note, said in the same breath as the note
    itself. It is read off the switches as they stand rather than described in
    general, because the whole complaint the Settings screen answers is that a
    reader cannot decide about a value they cannot see.
  */
  const alsoParts: string[] = [
    ...(shareDisplayName && contextDisplayName ? [text.contextAlsoName] : []),
    ...(shareAbout && contextAbout ? [text.contextAlsoAbout] : []),
    text.contextAlsoDevice
  ]

  const shown = avatar === null ? undefined : (avatar?.uri ?? avatarUri)

  return (
    <BottomSheet
      accessibilityLabel={text.open(names.primary)}
      onRequestClose={onClose}
      {...(onClosed ? { onClosed } : {})}
      testID={testID}
      visible={visible}
    >
      <View style={{ gap: theme.space.md }}>
        <Text variant="sheetTitle">{text.title}</Text>

        <InsetGroup footer={text.photoHint} header={text.photo}>
          <InsetRow style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
            <Avatar name={names.primary} size={AVATAR_SIZE.list} {...(shown ? { uri: shown } : {})} />
            <View style={{ flex: 1, gap: theme.space.xs }}>
              <Button
                onPress={() => void onPickPhoto()}
                testID={`${testID}-photo`}
                title={shown ? text.photoReplace : text.photoChange}
                variant="secondary"
              />
              {shown ? (
                <Button
                  onPress={() => setAvatar(null)}
                  testID={`${testID}-photo-remove`}
                  title={text.photoRemove}
                  variant="danger"
                />
              ) : null}
            </View>
          </InsetRow>
        </InsetGroup>

        <InsetGroup header={text.description}>
          <InsetRow>
            <TextField
              multiline
              onChangeText={setDescription}
              placeholder={text.descriptionPlaceholder}
              testID={`${testID}-description`}
              value={description}
            />
          </InsetRow>
        </InsetGroup>

        {onOpenMemory ? (
          <InsetGroup header={memoryStrings.rowTitle}>
            <InsetButtonRow
              detail={memoryStrings.rowHint}
              onPress={onOpenMemory}
              testID={`${testID}-memory`}
              title={memoryStrings.rowTitle}
            />
          </InsetGroup>
        ) : null}

        <InsetGroup footer={text.colourHint} header={text.colour}>
          <InsetRow>
            <AccentSwatches
              accent={accent}
              onSelect={name => setAccent(bot.name, name)}
              testIDPrefix={`${testID}-${bot.name}`}
            />
          </InsetRow>
        </InsetGroup>

        {/*
          The notice, or the field — never both. Showing the field under a notice
          that has not been accepted would be offering a control whose effect is
          suspended, which is the same call `ContextSection` makes.
        */}
        {pendingNotice ? (
          <InsetGroup footer={strings.settings.context.noticePending} header={text.context}>
            <InsetRow>
              <Text variant="body">{strings.settings.context.noticeTitle}</Text>
              <Text color="textMuted" testID={`${testID}-notice`} variant="meta">
                {strings.settings.context.notice}
              </Text>
            </InsetRow>
            <InsetButtonRow
              onPress={() => acknowledge(contextBaseUrl)}
              testID={`${testID}-notice-accept`}
              title={strings.settings.context.noticeConfirm}
            />
          </InsetGroup>
        ) : (
          <InsetGroup header={text.context}>
            <InsetRow>
              <TextField
                multiline
                maxLength={CONTEXT_LIMITS.perBot}
                onChangeText={next => setBotNote(bot.name, next, stamp())}
                placeholder={text.contextPlaceholder}
                testID={`${testID}-note`}
                value={note}
              />
              <Text color="textMuted" variant="meta">
                {text.contextCount(note.length, CONTEXT_LIMITS.perBot)}
              </Text>
            </InsetRow>
            <InsetRow>
              <Text color="textMuted" testID={`${testID}-note-also`} variant="meta">
                {text.contextAlso(alsoParts)}
              </Text>
              <Text color="textFaint" variant="micro">
                {text.contextSettingsLink}
              </Text>
            </InsetRow>
          </InsetGroup>
        )}

        {/*
          One row, because the three groups behind it are one question: what can
          this bot do. Its own sheet rather than a section here — three lists of
          switches would bury the two fields this sheet is actually for, and the
          switches write immediately while those fields wait for Save, which is
          a difference worth keeping on two surfaces rather than explaining on
          one.

          There is no row under this for deleting the bot. The gateway has no
          profile-delete method at all; the argument is written out in
          `features/profiles/profiles-controller.ts`.
        */}
        <InsetGroup>
          <InsetButtonRow
            detail={profileStrings.capabilities.rowDetail}
            onPress={() => setShowCapabilities(true)}
            testID={`${testID}-capabilities`}
            title={profileStrings.capabilities.row}
          />
        </InsetGroup>

        <InsetGroup header={text.about}>
          {/*
            TWO rows, because they are two facts.

            One row showed the display name under the label "Profile", which
            said neither thing: the handle — the name `@`-addressing, crons, DM
            lines and the gateway's own logs all use — was not on this sheet at
            all, and the label promised the other one. The handle is `mono`
            because it is an identifier and reads as one.
          */}
          {http ? (
            <BotNameFields
              botName={bot.name}
              displayName={bot.displayName}
              isDefault={bot.isDefault}
              onChangeText={setName}
              testID={`${testID}-name`}
              value={name}
            />
          ) : (
            <>
              <InsetValueRow detail={text.profileNameHint} label={text.profileName} mono value={bot.name} />
              <InsetValueRow
                detail={text.displayNameReadOnly}
                label={text.displayName}
                mono={false}
                value={bot.displayName && bot.displayName !== bot.name ? bot.displayName : text.displayNameUnset}
              />
            </>
          )}
          <InsetValueRow
            label={text.model}
            mono={false}
            value={bot.model ? prettyModelName(bot.model) : text.unknown}
          />
          <InsetValueRow label={text.provider} value={bot.provider || text.unknown} />
          <InsetValueRow label={text.session} mono value={bot.canonical?.id ?? text.unknown} />
          <InsetValueRow label={text.gatewayVersion} value={gatewayVersion || text.unknown} />
          {/*
            The same words the options sheet's ring says, without the ring: this
            group is a column of label-and-value rows and one drawing in the
            middle of it would read as a control rather than as a fact.
          */}
          {contextUsage ? (
            <InsetValueRow label={chatStrings.context.label} mono={false} value={contextSummary(contextUsage)} />
          ) : null}
        </InsetGroup>

        {error ? (
          <Text color="dangerText" testID={`${testID}-error`} variant="meta">
            {error}
          </Text>
        ) : null}

        {warning ? (
          <Text color="textMuted" testID={`${testID}-warning`} variant="meta">
            {warning}
          </Text>
        ) : null}

        <Button
          busy={busy}
          disabled={!gateway || (!changes.any && !nameChanged)}
          onPress={() => void onSave()}
          testID={`${testID}-save`}
          title={busy ? text.saving : text.save}
        />
      </View>

      <CapabilitiesSheet
        gateway={gateway}
        onClose={() => setShowCapabilities(false)}
        profile={bot.name}
        visible={showCapabilities}
      />
    </BottomSheet>
  )
}
