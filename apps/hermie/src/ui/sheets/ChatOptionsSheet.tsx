/**
 * Chat options: toggles and pickers that are commands underneath.
 *
 * Every control is fully controlled from props. The sheet never sends anything
 * itself — `config.set`, `slash.exec` and the local verbosity filter live in
 * three different places, and a sheet that decided which one to use would have
 * to know all three.
 *
 * The verbosity, bot-to-bot and thinking controls are the CLIENT-side filter
 * (ADR-0008); the gateway's own `display.tool_progress` is deliberately not
 * here, because changing it writes global config shared with other surfaces.
 */
import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import type { PickerOption, Verbosity } from '../../chat-ui/types'
import { BottomSheet } from '../BottomSheet'
import { Button, InsetGroup, Text, TextField } from '../primitives'
import { useTheme } from '../theme'
import { DisclosureRow, SegmentedRow, SwitchRow } from './controls'

export interface ChatOptionsSheetProps {
  visible: boolean
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  botName: string

  yolo: boolean
  onChangeYolo: (value: boolean) => void

  fast: boolean
  onChangeFast: (value: boolean) => void

  reasoningEffort: string
  reasoningOptions: PickerOption[]
  onChangeReasoningEffort: (value: string) => void

  model: string
  modelOptions: PickerOption[]
  onChangeModel: (value: string) => void
  /**
   * Called instead of `onChangeModel` when the catalogue already flags the
   * picked model as expensive; the caller runs the confirmation itself.
   */
  onPickExpensiveModel?: (value: string) => void

  verbosity: Verbosity
  onChangeVerbosity: (value: Verbosity) => void

  showBotToBot: boolean
  onChangeShowBotToBot: (value: boolean) => void

  showThinking: boolean
  onChangeShowThinking: (value: boolean) => void

  /**
   * True when this chat pins its own verbosity/toggles rather than following
   * the global default. Only then is there anything to reset.
   */
  viewOverridden?: boolean
  /** Drop this chat's override so it follows the Settings default again. */
  onResetView?: () => void

  /** The gateway answered `confirm_required` for the model just picked. */
  pendingExpensiveModel?: string | null
  confirmMessage?: string
  onCancelExpensiveModel?: () => void
  onConfirmExpensiveModel?: () => void
}

type Pane = 'root' | 'reasoning' | 'model'

function PickerPane({
  title,
  options,
  value,
  searchable,
  onPick,
  onBack
}: {
  title: string
  options: PickerOption[]
  value: string
  searchable?: boolean
  onPick: (option: PickerOption) => void
  onBack: () => void
}) {
  const theme = useTheme()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()

    if (!needle) {
      return options
    }

    return options.filter(
      option =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle) ||
        (option.detail ?? '').toLowerCase().includes(needle)
    )
  }, [options, query])

  return (
    <View style={{ gap: theme.space.md }}>
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Pressable accessibilityRole="button" onPress={onBack} testID="picker-back">
          <Text color="accent" style={{ fontSize: 22 }}>
            {'‹'}
          </Text>
        </Pressable>
        <Text style={{ flex: 1 }} variant="title">
          {title}
        </Text>
      </View>

      {searchable ? (
        <TextField
          autoCapitalize="none"
          autoCorrect={false}
          label={chatStrings.options.modelSearch}
          onChangeText={setQuery}
          testID="picker-search"
          value={query}
        />
      ) : null}

      <InsetGroup>
        {filtered.map(option => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: option.value === value }}
            key={option.value}
            onPress={() => onPick(option)}
            testID={`picker-option-${option.value}`}
          >
            <View
              style={{
                alignItems: 'center',
                flexDirection: 'row',
                gap: theme.space.sm,
                minHeight: 44,
                paddingHorizontal: theme.space.lg,
                paddingVertical: theme.space.sm
              }}
            >
              <View style={{ flex: 1 }}>
                <Text>{option.label}</Text>
                {option.detail ? (
                  <Text color="textMuted" variant="caption">
                    {option.detail}
                  </Text>
                ) : null}
              </View>
              {option.expensive ? (
                <Text color="danger" variant="caption">
                  {'$$'}
                </Text>
              ) : null}
              {option.value === value ? <Text color="accent">{'✓'}</Text> : null}
            </View>
          </Pressable>
        ))}
      </InsetGroup>
    </View>
  )
}

export function ChatOptionsSheet(props: ChatOptionsSheetProps) {
  const theme = useTheme()
  const [pane, setPane] = useState<Pane>('root')

  const close = () => {
    setPane('root')
    props.onClose()
  }

  const modelLabel = props.modelOptions.find(option => option.value === props.model)?.label ?? props.model
  const reasoningLabel =
    props.reasoningOptions.find(option => option.value === props.reasoningEffort)?.label ?? props.reasoningEffort

  if (props.pendingExpensiveModel) {
    // A confirmation replaces the sheet's body rather than stacking a second
    // modal on it: two sheets deep is where a `Modal` stops behaving the same
    // on all four targets.
    return (
      <BottomSheet
        accessibilityLabel={chatStrings.options.expensiveTitle}
        blocking
        onClosed={props.onClosed}
        onRequestClose={() => props.onCancelExpensiveModel?.()}
        testID="chat-options-sheet"
        visible={props.visible}
      >
        <Text variant="title">{chatStrings.options.expensiveTitle}</Text>
        <Text color="textMuted">{props.confirmMessage || props.pendingExpensiveModel}</Text>
        <Button
          onPress={() => props.onConfirmExpensiveModel?.()}
          testID="option-model-confirm"
          title={chatStrings.options.expensiveConfirm}
        />
        <Button
          onPress={() => props.onCancelExpensiveModel?.()}
          testID="option-model-cancel"
          title={chatStrings.options.cancel}
          variant="secondary"
        />
      </BottomSheet>
    )
  }

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.options.title}
      onClosed={props.onClosed}
      onRequestClose={close}
      testID="chat-options-sheet"
      visible={props.visible}
    >
      {pane === 'reasoning' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.onChangeReasoningEffort(option.value)
            setPane('root')
          }}
          options={props.reasoningOptions}
          title={chatStrings.options.reasoning}
          value={props.reasoningEffort}
        />
      ) : pane === 'model' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            if (option.expensive && props.onPickExpensiveModel) {
              props.onPickExpensiveModel(option.value)
            } else {
              props.onChangeModel(option.value)
            }

            setPane('root')
          }}
          options={props.modelOptions}
          searchable
          title={chatStrings.options.model}
          value={props.model}
        />
      ) : (
        <View style={{ gap: theme.space.lg }}>
          <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="title">{chatStrings.options.title}</Text>
            <Pressable accessibilityRole="button" onPress={close} testID="chat-options-done">
              <Text color="accent">{chatStrings.options.done}</Text>
            </Pressable>
          </View>

          <Text color="textMuted" variant="caption">
            {chatStrings.options.subtitle(props.botName)}
          </Text>

          <InsetGroup>
            <SwitchRow
              hint={chatStrings.options.yoloHint}
              label={chatStrings.options.yolo}
              onChange={props.onChangeYolo}
              testID="option-yolo"
              value={props.yolo}
            />
            <SwitchRow
              hint={chatStrings.options.fastHint}
              label={chatStrings.options.fast}
              onChange={props.onChangeFast}
              testID="option-fast"
              value={props.fast}
            />
          </InsetGroup>

          <InsetGroup>
            <DisclosureRow
              label={chatStrings.options.reasoning}
              onPress={() => setPane('reasoning')}
              testID="option-reasoning"
              value={reasoningLabel}
            />
            <DisclosureRow
              label={chatStrings.options.model}
              onPress={() => setPane('model')}
              testID="option-model"
              value={modelLabel}
            />
          </InsetGroup>

          <InsetGroup>
            <SegmentedRow
              label={chatStrings.options.verbosity}
              onChange={props.onChangeVerbosity}
              options={[
                { label: chatStrings.options.verbosityOptions.quiet, value: 'quiet' },
                { label: chatStrings.options.verbosityOptions.normal, value: 'normal' },
                { label: chatStrings.options.verbosityOptions.verbose, value: 'verbose' }
              ]}
              testID="option-verbosity"
              value={props.verbosity}
            />
          </InsetGroup>

          <InsetGroup
            footer={props.viewOverridden ? chatStrings.options.usingOverride : chatStrings.options.usingDefault}
          >
            <SwitchRow
              label={chatStrings.options.showBotToBot}
              onChange={props.onChangeShowBotToBot}
              testID="option-bot-to-bot"
              value={props.showBotToBot}
            />
            <SwitchRow
              label={chatStrings.options.showThinking}
              onChange={props.onChangeShowThinking}
              testID="option-thinking"
              value={props.showThinking}
            />
          </InsetGroup>

          {props.viewOverridden && props.onResetView ? (
            <Button
              onPress={props.onResetView}
              testID="option-use-default"
              title={chatStrings.options.useDefault}
              variant="secondary"
            />
          ) : null}

          <Button onPress={close} title={chatStrings.options.done} variant="secondary" />
        </View>
      )}
    </BottomSheet>
  )
}
