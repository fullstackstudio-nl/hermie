/**
 * The clarify sheet: one question, or a stepper over a batch.
 *
 * `clarify` arrives either as a single question or as several at once. A batch
 * is a stepper rather than a long scroll, because the server accepts answers
 * one at a time (`clarify.lock`) and a locked answer may not be edited — the
 * stepper is the shape that makes that visible instead of surprising.
 *
 * Choices and free text coexist on purpose: the model offers options, and the
 * answer the user actually has is often neither of them.
 */
import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import type { ClarifyItem } from '../../chat-ui/types'
import { BottomSheet, SheetEyebrow } from '../BottomSheet'
import { Button, Text, TextField } from '../primitives'
import { useTheme } from '../theme'

export interface ClarifySheetProps {
  visible: boolean
  item: ClarifyItem
  /** Answers the user has committed per question, keyed by `qid`. */
  onLock?: (qid: string, answer: string) => void
  onSubmit: (answers: Record<string, string>) => void
  /**
   * Put the question aside. It stays open on the gateway and in the transcript
   * — this only takes the sheet off the screen — which is why the button says
   * "Later" rather than "Skip".
   */
  onSkip: () => void
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
}

const MULTI_SEPARATOR = ', '

function toggleValue(current: string, choice: string, multiSelect: boolean): string {
  if (!multiSelect) {
    return current === choice ? '' : choice
  }

  const parts = current ? current.split(MULTI_SEPARATOR).filter(Boolean) : []
  const next = parts.includes(choice) ? parts.filter(part => part !== choice) : [...parts, choice]

  return next.join(MULTI_SEPARATOR)
}

function isSelected(current: string, choice: string, multiSelect: boolean): boolean {
  if (!multiSelect) {
    return current === choice
  }

  return current.split(MULTI_SEPARATOR).includes(choice)
}

export function ClarifySheet({ visible, item, onLock, onSubmit, onSkip, onClose, onClosed }: ClarifySheetProps) {
  const theme = useTheme()
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...item.answers }))

  const question = item.questions[Math.min(index, item.questions.length - 1)]
  const batch = item.questions.length > 1
  const locked = useMemo(() => new Set(item.locked), [item.locked])

  if (!question) {
    return null
  }

  // The host keeps a resolved question on screen so its outcome can be read;
  // without this branch the sheet would go on offering Submit for a question
  // the gateway has already closed.
  if (item.state !== 'open') {
    return (
      <BottomSheet
        accessibilityLabel={chatStrings.clarify.title}
        blocking
        onClosed={onClosed}
        onRequestClose={onClose}
        testID="clarify-sheet"
        visible={visible}
      >
        <SheetEyebrow>{chatStrings.clarify.eyebrow}</SheetEyebrow>
        <Text variant="sheetTitle">{chatStrings.clarify.title}</Text>
        <Text color="textMuted" testID="clarify-resolution">
          {item.state === 'answered'
            ? chatStrings.clarify.outcome(Object.keys(item.answers).length, item.questions.length)
            : item.cancelReason === 'timeout'
              ? chatStrings.approval.timedOut
              : chatStrings.approval.answeredElsewhere}
        </Text>
        <Button onPress={onClose} testID="clarify-close" title={chatStrings.sheet.close} variant="secondary" />
      </BottomSheet>
    )
  }

  const value = answers[question.qid] ?? ''
  const isLocked = locked.has(question.qid)

  const setValue = (next: string) => setAnswers(current => ({ ...current, [question.qid]: next }))

  const lastQuestion = index >= item.questions.length - 1

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.clarify.title}
      blocking
      onClosed={onClosed}
      onRequestClose={onClose}
      testID="clarify-sheet"
      visible={visible}
    >
      <SheetEyebrow>{chatStrings.clarify.eyebrow}</SheetEyebrow>

      {batch ? (
        <Text color="textMuted" variant="meta" testID="clarify-step">
          {chatStrings.clarify.step(index + 1, item.questions.length)}
        </Text>
      ) : null}

      <Text variant="sheetTitle" testID="clarify-question">
        {question.question}
      </Text>

      {question.multiSelect ? (
        <Text color="textMuted" variant="meta">
          {chatStrings.clarify.multiSelectHint}
        </Text>
      ) : null}

      {question.choices?.length ? (
        <View style={{ gap: theme.space.sm }}>
          {question.choices.map(choice => {
            const selected = isSelected(value, choice, question.multiSelect)

            return (
              <Pressable
                accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: selected, disabled: isLocked }}
                disabled={isLocked}
                key={choice}
                onPress={() => setValue(toggleValue(value, choice, question.multiSelect))}
                testID={`clarify-choice-${choice}`}
              >
                <View
                  style={{
                    alignItems: 'center',
                    backgroundColor: theme.elevation.e3c,
                    borderColor: selected ? theme.colors.accent : theme.hairline,
                    borderRadius: theme.radii.lg,
                    borderWidth: selected ? 2 : 1,
                    flexDirection: 'row',
                    gap: theme.space.sm,
                    minHeight: 48,
                    opacity: isLocked ? 0.5 : 1,
                    paddingHorizontal: theme.space.md,
                    paddingVertical: theme.space.sm
                  }}
                >
                  <Text color={selected ? 'accent' : 'textMuted'} style={{ fontSize: 16 }}>
                    {question.multiSelect ? (selected ? '☑' : '☐') : selected ? '◉' : '○'}
                  </Text>
                  <Text style={{ flex: 1 }}>{choice}</Text>
                </View>
              </Pressable>
            )
          })}
        </View>
      ) : null}

      <TextField
        editable={!isLocked}
        label={chatStrings.clarify.freeText}
        multiline
        onChangeText={setValue}
        placeholder={chatStrings.clarify.freeTextPlaceholder}
        testID="clarify-free-text"
        value={value}
      />

      <View style={{ gap: theme.space.sm }}>
        {onLock && !isLocked ? (
          <Button
            disabled={!value.trim()}
            onPress={() => onLock(question.qid, value)}
            testID="clarify-lock"
            title={chatStrings.clarify.lock}
            variant="secondary"
          />
        ) : null}

        {isLocked ? (
          <Text color="ok" variant="meta" testID="clarify-locked">
            {chatStrings.clarify.locked}
          </Text>
        ) : null}

        {batch && !lastQuestion ? (
          <Button
            onPress={() => setIndex(current => current + 1)}
            testID="clarify-next"
            title={chatStrings.clarify.next}
          />
        ) : (
          <Button onPress={() => onSubmit(answers)} testID="clarify-submit" title={chatStrings.clarify.submit} />
        )}

        {batch && index > 0 ? (
          <Button
            onPress={() => setIndex(current => current - 1)}
            testID="clarify-previous"
            title={chatStrings.clarify.previous}
            variant="secondary"
          />
        ) : null}

        <Button onPress={onSkip} testID="clarify-skip" title={chatStrings.clarify.later} variant="secondary" />
      </View>
    </BottomSheet>
  )
}
