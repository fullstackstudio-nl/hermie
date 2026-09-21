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
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import type { PickerOption, Verbosity } from '../../chat-ui/types'
import { strings } from '../../i18n/strings'
import { AccentSwatches } from '../AccentSwatches'
import { BottomSheet, SheetEyebrow, SheetPage } from '../BottomSheet'
import { Button, InsetGroup, Text, TextField } from '../primitives'
import { useTheme } from '../theme'
import { TAP_SLOP, type AccentName } from '../tokens'
import { useEscapeKey } from '../useEscapeKey'
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

  /**
   * This chat's colour, and a way to change it.
   *
   * It is the same value the row menu sets, from the same store (ADR-0012), so
   * picking here retints the header ring, the selected row and the outgoing
   * bubbles as soon as the store writes — no reload, and no second copy of the
   * colour held by the sheet.
   */
  accent: AccentName
  onChangeAccent: (value: AccentName) => void

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
  /**
   * Which page the sheet opens on. Development only, and the reason it exists is
   * that a page behind a tap cannot be photographed on a simulator this machine
   * can only launch — see `src/dev/launch-intent.ts`. A tap still navigates
   * normally from wherever it puts you.
   */
  initialPane?: 'reasoning' | 'model' | 'colour'

  pendingExpensiveModel?: string | null
  confirmMessage?: string
  onCancelExpensiveModel?: () => void
  onConfirmExpensiveModel?: () => void
}

type Pane = 'root' | 'reasoning' | 'model' | 'colour'

/**
 * A page inside the sheet.
 *
 * `SheetPage` rather than a local copy: the back affordance has to be in the
 * same place with the same glyph in every sheet that goes a level deeper, which
 * is the visible half of "Escape goes back one level".
 */
function Page({ children, onBack, title }: { children: ReactNode; onBack: () => void; title: string }) {
  return (
    <SheetPage backLabel={strings.common.back} onBack={onBack} testID="picker-back" title={title}>
      {children}
    </SheetPage>
  )
}

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
    <Page onBack={onBack} title={title}>
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
                  <Text color="textMuted" variant="meta">
                    {option.detail}
                  </Text>
                ) : null}
              </View>
              {option.expensive ? (
                <Text color="dangerText" variant="meta">
                  {'$$'}
                </Text>
              ) : null}
              {option.value === value ? <Text color="accentText">{'✓'}</Text> : null}
            </View>
          </Pressable>
        ))}
      </InsetGroup>
    </Page>
  )
}

export function ChatOptionsSheet(props: ChatOptionsSheetProps) {
  const theme = useTheme()
  const [pane, setPane] = useState<Pane>(props.initialPane ?? 'root')

  /**
   * Escape goes back exactly ONE level.
   *
   * `useEscapeKey` delivers to whoever registered LAST, and effects flush
   * child-first — so the `BottomSheet` inside this component registers its
   * "close the sheet" handler before this one does. A page therefore wins
   * Escape while it is open, pops itself, unregisters, and hands the key back
   * to the sheet. Nothing coordinates that beyond mount order, which is the
   * whole reason the stack is a stack.
   */
  useEscapeKey(() => setPane('root'), props.visible && pane !== 'root')

  // The sheet is mounted for the life of the screen, so `useState`'s initial
  // value ran long before anyone asked for a page. Re-reading it as the sheet
  // BECOMES visible is what makes `initialPane` mean anything — and it is right
  // for an ordinary open too, which should never land on the page the last
  // reader happened to leave.
  const { visible, initialPane } = props

  useEffect(() => {
    if (visible) {
      setPane(initialPane ?? 'root')
    }
  }, [visible, initialPane])

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
        onClosed={props.onClosed}
        onRequestClose={() => props.onCancelExpensiveModel?.()}
        testID="chat-options-sheet"
        visible={props.visible}
      >
        <Text variant="sheetTitle">{chatStrings.options.expensiveTitle}</Text>
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
      // One level, the same rule Escape follows above. `onRequestClose` is the
      // platform's dismiss request, and on Android that is the hardware back
      // button — the only surface here that HAS one, and the one Escape cannot
      // reach because `useEscapeKey` is wired to a Mac keyboard. Without this a
      // back press from a page closed the whole sheet and skipped the level.
      onRequestClose={() => (pane === 'root' ? close() : setPane('root'))}
      testID="chat-options-sheet"
      visible={props.visible}
    >
      {pane === 'colour' ? (
        <Page onBack={() => setPane('root')} title={strings.layout.colour}>
          <Text color="textMuted" variant="preview">
            {chatStrings.options.colourHint}
          </Text>
          {/*
            The page stays open after a pick, unlike the model and reasoning
            pages. A colour is judged against the chat behind it, so closing on
            the first tap would make comparing two of them four taps each.
          */}
          <AccentSwatches accent={props.accent} onSelect={props.onChangeAccent} testIDPrefix={props.botName} />
        </Page>
      ) : pane === 'reasoning' ? (
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
          <View style={{ gap: theme.space.xs }}>
            <SheetEyebrow>{chatStrings.options.eyebrow}</SheetEyebrow>
            <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="sheetTitle">{chatStrings.options.title}</Text>
              <Pressable accessibilityRole="button" hitSlop={TAP_SLOP} onPress={close} testID="chat-options-done">
                <Text color="accentText">{chatStrings.options.done}</Text>
              </Pressable>
            </View>
            <Text color="textMuted" variant="preview">
              {chatStrings.options.subtitle(props.botName)}
            </Text>
          </View>

          {/*
            Four groups, each with a heading. Without them the sheet is eight
            controls in a column and the reader has to infer which two belong
            together — and the two verbosity/visibility groups in particular are
            about different things (what the model does, what this screen shows).
          */}
          <InsetGroup header={chatStrings.options.howHeader}>
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

          <InsetGroup header={chatStrings.options.thisChatHeader}>
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
            <DisclosureRow
              label={strings.layout.colour}
              onPress={() => setPane('colour')}
              testID="option-colour"
              value={strings.layout.accents[props.accent]}
            />
          </InsetGroup>

          {/*
            Verbosity and the two visibility switches are ONE group: all three
            are the client-side view filter (ADR-0008), they share the override
            footer, and split across two cards the footer looked like it only
            applied to the switches.
          */}
          <InsetGroup
            footer={props.viewOverridden ? chatStrings.options.usingOverride : chatStrings.options.usingDefault}
            header={chatStrings.options.viewHeader}
          >
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
