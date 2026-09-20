/**
 * A message the reader sent while the bot was still working.
 *
 * It is the reader's OWN bubble, in the reader's own place at the end of the
 * conversation — the same fill, the same side, the same width. Nothing about
 * "your message is waiting" is a system notice, and drawing it as one (a chip,
 * a banner, a line of grey text) would make the reader look for their message
 * somewhere other than where they wrote it.
 *
 * What is different is underneath: the word `Queued` where a clock would be,
 * and the three things that can still be done about a message that has not
 * gone yet.
 *
 * Deliberately NOT `UserBubble`. That component draws a sent message — a clock
 * from `item.ts`, a receipt, a tail decided by grouping — and a queued message
 * has no time, no receipt and no run to belong to.
 */
import { Pressable, View } from 'react-native'

import { Markdown } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { FileChip } from './FileChip'
import { Bubble } from './primitives/Bubble'
import { chatStrings } from './strings'
import { attachmentName } from './UserBubble'

export interface QueuedRowProps {
  id: string
  text: string
  /** The same `@file:` references a sent bubble carries. */
  attachments?: readonly string[]
  /** Inject it into the turn that is running, now. */
  onSteer?: (id: string) => void
  /**
   * Put it back in the composer. Absent where there is something to lose: a
   * queued message's attachments travel with the message, and the composer
   * cannot be handed bytes back — so a message WITH an attachment offers Steer
   * and Delete, and nothing that would silently drop a file.
   */
  onEdit?: (id: string) => void
  onDelete?: (id: string) => void
  /** The chat's outgoing fill, from `useChatAccent`. */
  accent?: string
  testID?: string
}

function Action({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable accessibilityRole="button" hitSlop={TAP_SLOP} onPress={onPress} testID={testID}>
      {({ pressed }) => (
        <Text color="accentText" style={{ opacity: pressed ? 0.6 : 1 }} variant="meta">
          {label}
        </Text>
      )}
    </Pressable>
  )
}

export function QueuedRow({ id, text, attachments, onSteer, onEdit, onDelete, accent, testID }: QueuedRowProps) {
  const theme = useTheme()
  const bubble = accent ?? theme.accent().bubble

  return (
    <View style={{ gap: theme.space.xs }} testID={testID}>
      <Bubble
        accent={bubble}
        // The word where the clock goes. It is inside the bubble's own metadata
        // line rather than under it, so the row is one object rather than a
        // bubble with a caption.
        meta={
          <Text color="onAccent" style={{ opacity: 0.75 }} testID={`queued-label-${id}`} variant="meta">
            {chatStrings.queue.label}
          </Text>
        }
        side="own"
        tail
        testID={`queued-${id}`}
      >
        {text ? (
          <Markdown
            color="onAccent"
            inlineCodeBackground="rgba(255,255,255,0.22)"
            inlineCodeBorderColor="rgba(255,255,255,0.32)"
            linkColor={theme.colors.onAccent}
            mutedColor="onAccent"
            surface="rgba(255,255,255,0.16)"
            text={text}
          />
        ) : null}

        {attachments?.length ? (
          <View style={{ gap: theme.space.xs, marginTop: text ? theme.space.sm : 0 }}>
            {attachments.map(reference => (
              <FileChip key={reference} name={attachmentName(reference)} onAccent testID={`queued-file-${id}`} />
            ))}
          </View>
        ) : null}
      </Bubble>

      <View style={{ alignSelf: 'flex-end', flexDirection: 'row', gap: theme.space.md }}>
        {onSteer ? (
          <Action label={chatStrings.queue.steer} onPress={() => onSteer(id)} testID={`queued-steer-${id}`} />
        ) : null}
        {onEdit ? (
          <Action label={chatStrings.queue.edit} onPress={() => onEdit(id)} testID={`queued-edit-${id}`} />
        ) : null}
        {onDelete ? (
          <Action label={chatStrings.queue.delete} onPress={() => onDelete(id)} testID={`queued-delete-${id}`} />
        ) : null}
      </View>
    </View>
  )
}
