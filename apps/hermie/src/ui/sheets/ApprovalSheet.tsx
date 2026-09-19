/**
 * The approval sheet (ADR-0010).
 *
 * Three rules this component exists to enforce:
 *
 *  1. The buttons are EXACTLY the server's `choices`, in the server's order.
 *     Never a hard-coded set — the gateway decides what may be answered, and
 *     inventing an "Always allow" the server did not offer would send a choice
 *     it will reject.
 *  2. Only an explicit tap answers. The sheet is `blocking`, so the backdrop
 *     does nothing, and there is no gesture anywhere near it.
 *  3. A 400 ms guard after mount. A sheet that appears under a finger already
 *     travelling toward the screen would otherwise answer a question the user
 *     never read.
 */
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import { MONOSPACE } from '../../markdown'
import { chatStrings } from '../../chat-ui/strings'
import type { ApprovalItem } from '../../chat-ui/types'
import { BottomSheet, SheetEyebrow } from '../BottomSheet'
import { Button, Text } from '../primitives'
import { useTheme } from '../theme'

export interface ApprovalSheetProps {
  visible: boolean
  item: ApprovalItem
  /** The bot whose chat asked; shown in the eyebrow. */
  botHandle: string
  /** `choice` is one of `item.choices`, verbatim. */
  onRespond: (choice: string) => void
  /** Only reachable once the request is no longer open. */
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  /** Milliseconds before taps are accepted. Tests pass 0. */
  tapGuardMs?: number
  /** Extra context line, e.g. the working directory. */
  workingDirectory?: string
}

const DEFAULT_TAP_GUARD_MS = 400

/** `always` → "Always allow"; an unknown choice keeps its own name. */
function choiceLabel(choice: string): string {
  return chatStrings.approval.choices[choice] ?? choice.replace(/_/g, ' ')
}

function choiceVariant(choice: string): 'primary' | 'secondary' | 'danger' {
  if (choice === 'deny') {
    return 'danger'
  }

  return choice === 'once' ? 'primary' : 'secondary'
}

export function ApprovalSheet({
  visible,
  item,
  botHandle,
  onRespond,
  onClose,
  onClosed,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  workingDirectory
}: ApprovalSheetProps) {
  const theme = useTheme()
  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // `item.id` is in here on purpose. The sheet host keeps ONE approval sheet
  // mounted and swaps the request into it, so a second question can arrive
  // without `visible` ever going false — and a guard that only re-armed on
  // `visible` would hand the next question a live "Allow once" under the
  // finger that just answered the previous one.
  useEffect(() => {
    if (!visible) {
      setArmed(tapGuardMs <= 0)

      return
    }

    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)
    timer.current = setTimeout(() => setArmed(true), tapGuardMs)

    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [item.id, tapGuardMs, visible])

  const open = item.state === 'open'

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.approval.title}
      // Still blocking once answered: the sheet then shows why it closed, and
      // a stray backdrop tap should not race the reason off the screen.
      blocking
      onClosed={onClosed}
      onRequestClose={onClose}
      testID="approval-sheet"
      visible={visible}
    >
      <SheetEyebrow>{chatStrings.approval.eyebrow(botHandle)}</SheetEyebrow>
      <Text variant="sheetTitle">{chatStrings.approval.title}</Text>

      {item.description ? (
        <Text color="textMuted" style={{ fontSize: 16, lineHeight: 22 }}>
          {item.description}
        </Text>
      ) : null}

      <View
        style={{
          backgroundColor: theme.tintSunk,
          borderRadius: theme.radii.lg,
          padding: theme.space.md
        }}
      >
        <Text
          selectable
          style={{ color: theme.colors.text, fontFamily: MONOSPACE, fontSize: 13, lineHeight: 19 }}
          testID="approval-command"
        >
          {item.command}
        </Text>
      </View>

      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '600' }}>{chatStrings.approval.runsOn}</Text>
        {item.toolName ? (
          <Text color="textMuted" variant="meta" testID="approval-tool-name">
            {item.toolName}
          </Text>
        ) : null}
        {workingDirectory ? (
          <Text color="textMuted" variant="meta">
            {workingDirectory}
          </Text>
        ) : null}
      </View>

      {open ? (
        <View style={{ gap: theme.space.sm }}>
          {item.choices.map(choice => (
            <Button
              disabled={!armed}
              key={choice}
              onPress={() => onRespond(choice)}
              testID={`approval-choice-${choice}`}
              title={choiceLabel(choice)}
              variant={choiceVariant(choice)}
            />
          ))}

          {item.choices.includes('always') ? (
            <Text color="textMuted" variant="meta">
              {chatStrings.approval.fine}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: theme.space.sm }}>
          <Text color="textMuted" testID="approval-resolution">
            {item.state === 'answered'
              ? chatStrings.approval.answered(choiceLabel(item.answer ?? ''))
              : item.cancelReason === 'timeout'
                ? chatStrings.approval.timedOut
                : chatStrings.approval.answeredElsewhere}
          </Text>
          <Button onPress={onClose} testID="approval-close" title={chatStrings.sheet.close} variant="secondary" />
        </View>
      )}
    </BottomSheet>
  )
}
