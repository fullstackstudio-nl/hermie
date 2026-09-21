/**
 * The two name rows on the bot profile sheet: one editable, one a fact.
 *
 * ## Which one is editable depends on the profile, and that is the feature
 *
 * `PATCH /api/profiles/{name}` is one route with two behaviours. On `default`
 * it sets a presentation-only display name and the profile keeps its id; on any
 * other profile it RENAMES the profile — directory, wrapper script, service and
 * active-profile pointer — and there is no display name involved at all.
 *
 * So there is no single honest label for one field. On `default` the editable
 * row is **Display name** and the profile name below it is untouchable. On
 * every other bot the editable row is **Profile name**, because that is
 * literally what changes, and it carries the warning out loud: the handle is
 * what `@`-mentions, crons, DM lines and the gateway's own logs use, and
 * somebody renaming what they think is a label is about to break all four.
 *
 * The sheet used to show both rows read-only with the sentence "Set on the
 * gateway, in this profile." That was true of `profiles.configure`, which is
 * the only thing the app had; it was never true of the REST route beside it.
 */
import { View } from 'react-native'

import { InsetRow, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { PROFILE_NAME_MAX } from './rename-controller'
import { renameStrings } from './strings'

export interface BotNameFieldsProps {
  /** The profile's identifier as the roster last reported it. */
  botName: string
  /** The label the roster reported, which may equal the identifier. */
  displayName: string
  /** `default` keeps its id and takes a label; everything else is renamed. */
  isDefault: boolean
  /** The draft, held by the sheet so Save can send it. */
  value: string
  onChangeText: (next: string) => void
  /** Shown under the input, in the danger colour. */
  error?: string | null
  testID?: string
}

/**
 * What the field starts on for a given bot.
 *
 * Exported because "what has changed" has to be computed against the same
 * value the field was seeded with, and a second opinion about that is how a
 * sheet sends a rename nobody asked for.
 */
export function initialBotName(bot: { name: string; displayName: string; isDefault: boolean }): string {
  if (!bot.isDefault) {
    return bot.name
  }

  // A roster row whose `display_name` is absent is projected as the name
  // itself (`botFromProfileRow`), and a field pre-filled with the id would
  // make "never set" look like a label somebody chose.
  return bot.displayName && bot.displayName !== bot.name ? bot.displayName : ''
}

export function BotNameFields({
  botName,
  displayName,
  isDefault,
  value,
  onChangeText,
  error,
  testID = 'bot-profile-name'
}: BotNameFieldsProps) {
  const theme = useTheme()

  return (
    <View>
      <InsetRow>
        <TextField
          autoCapitalize={isDefault ? 'words' : 'none'}
          autoCorrect={false}
          error={error ?? null}
          label={isDefault ? renameStrings.displayLabel : renameStrings.profileLabel}
          maxLength={PROFILE_NAME_MAX}
          onChangeText={onChangeText}
          placeholder={renameStrings.placeholder}
          testID={testID}
          value={value}
        />
        <Text color="textMuted" variant="meta">
          {isDefault ? renameStrings.displayHint : renameStrings.profileHint}
        </Text>
        {isDefault ? null : (
          <Text color="dangerText" style={{ marginTop: theme.space.xxs }} testID={`${testID}-warning`} variant="meta">
            {renameStrings.profileWarning}
          </Text>
        )}
      </InsetRow>

      {/*
        The group draws its own hairlines between CHILDREN, and these two rows
        arrive as one child, so the separator between them is drawn here — same
        inset, same colour — rather than the pair reading as one tall row.
      */}
      <View style={{ height: 1, marginLeft: theme.space.lg, backgroundColor: theme.hairline }} />

      {/*
        The other half of the pair, always read-only, because on either kind of
        profile exactly one of the two names is settable over this route.
      */}
      {isDefault ? (
        <InsetValueRow detail={renameStrings.profileHint} label={renameStrings.profileLabel} mono value={botName} />
      ) : (
        <InsetValueRow
          label={renameStrings.displayLabel}
          mono={false}
          value={displayName && displayName !== botName ? displayName : renameStrings.placeholder}
        />
      )}
    </View>
  )
}
