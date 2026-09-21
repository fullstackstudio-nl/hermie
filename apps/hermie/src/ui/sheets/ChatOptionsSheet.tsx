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

import { prettyModelName, type ContextUsage } from '@hermie/transcript'

import { ContextMeter } from '../../chat-ui/ContextMeter'
import { chatStrings } from '../../chat-ui/strings'
import type { PickerOption, Verbosity } from '../../chat-ui/types'
import { formatMuteUntil, MUTE_DURATIONS, MUTE_FOREVER, muteUntil, type MuteDuration } from '../../store/mute'
import { DICTATION_AUTO, RATE_STEPS } from '../../features/voice/voice-settings'
import { strings } from '../../i18n/strings'
import { AccentSwatches } from '../AccentSwatches'
import { BottomSheet, SheetEyebrow, SheetPage } from '../BottomSheet'
import { SHARE_FILE_VERB } from '../../platform/share-text'
import { Button, InsetButtonRow, InsetGroup, Text, TextField } from '../primitives'
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

  /**
   * When this chat's silence lapses, `0` for never, `null` when it is not muted.
   *
   * The same value the row menu reads, from the same store, so muting from the
   * header and muting from the list are one decision with one home.
   */
  mutedUntil: number | null
  /** `null` unmutes; a number is the second the silence lapses, `0` for never. */
  onChangeMute: (until: number | null) => void

  /**
   * How full this session's context window is, or nothing.
   *
   * Absent means the gateway did not report a window size, and the row is then
   * not drawn at all — not drawn empty, and never drawn as an error. A gateway
   * without `session.usage` is a gateway with one fewer row in this sheet, which
   * is the whole of the capability gate.
   */
  contextUsage?: ContextUsage | null

  /**
   * Write the conversation out as a file and hand it to the platform.
   *
   * The sheet does not build the file: it has the transcript nowhere near it,
   * and the serializer is a pure function in `@hermie/transcript` that the
   * screen owns. Absent removes the group, which is what a surface with no
   * transcript behind it — the developer gallery — gets.
   */
  onExport?: (format: 'md' | 'txt') => void

  /**
   * Speaking and listening, or nothing at all.
   *
   * Absent removes the whole group, which is the case on a platform with no
   * synthesiser — a browser without `speechSynthesis`. The same rule `onExport`
   * follows: a group whose controls cannot act is worse than a missing group.
   *
   * The two halves are deliberately different in scope and the footer says so.
   * `autoRead` belongs to THIS chat — a phone in a car and a Mac in an office
   * want different answers for the same bot — while the rate is one voice for
   * the whole app, because a reader who finds the default too slow finds it too
   * slow everywhere.
   */
  voice?: {
    autoRead: boolean
    onChangeAutoRead: (value: boolean) => void
    /** Engine multiplier, 1 being the platform's normal. One of `RATE_STEPS`. */
    rate: number
    onChangeRate: (rate: number) => void
    /** Something is being read right now, so there is something to stop. */
    reading: boolean
    onStopReading: () => void
    /**
     * The dictation half, or nothing where the platform cannot listen.
     *
     * Separate from the speaking half because the two capabilities really are
     * separate: a browser with `speechSynthesis` and no `SpeechRecognition` is
     * the common case, and it should get the reading rows and not a language
     * picker for a microphone it does not have.
     */
    dictation?: {
      /** `auto`, or a BCP-47 tag. */
      language: string
      onChangeLanguage: (language: string) => void
      /**
       * Tags this device can recognise offline, from the platform itself.
       *
       * Empty is the ordinary case rather than a failure — Android below API 31
       * will not say and the web has no way to ask — and it means the picker
       * offers the device's own language alone.
       */
      languages: readonly string[]
    }
  }

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
  initialPane?: 'reasoning' | 'model' | 'colour' | 'mute'

  pendingExpensiveModel?: string | null
  confirmMessage?: string
  onCancelExpensiveModel?: () => void
  onConfirmExpensiveModel?: () => void
}

type Pane = 'root' | 'reasoning' | 'model' | 'colour' | 'mute' | 'rate' | 'dictationLanguage'

/**
 * A language tag, in the reader's own words where the platform knows them.
 *
 * `Intl.DisplayNames` is in every engine this app runs on and is still wrapped:
 * it throws on a tag it cannot parse, and the tags here come from the device's
 * recognizer rather than from this repository. The tag itself is the fallback,
 * which is worse to read and never wrong.
 */
export function languageLabel(tag: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/**
 * The five speaking rates, named rather than numbered.
 *
 * "0.75×" is a number about an engine; "Slow" is what a person means. The values
 * behind them are `RATE_STEPS` and the labels are `chatStrings.voice.rateOptions`,
 * zipped here so the two lists cannot drift in length — a sixth step with no name
 * would draw a row with an empty label.
 */
const RATE_LABELS = ['slowest', 'slow', 'normal', 'fast', 'fastest'] as const

const RATE_OPTIONS: PickerOption[] = RATE_STEPS.map((value, index) => ({
  value: String(value),
  label: chatStrings.voice.rateOptions[RATE_LABELS[index] ?? 'normal']
}))

/**
 * The picker's id for "stop being quiet".
 *
 * Not one of `MUTE_DURATIONS`, and deliberately not a value the duration parser
 * would take: the picker hands back one string and this is the one that means
 * the opposite of the other four.
 */
const UNMUTE = 'unmute'

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

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
            aria-selected={option.value === value}
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

/**
 * The context-window row.
 *
 * Not a `DisclosureRow` and not pressable: there is nowhere for it to go. A row
 * that looks like the four above it and does nothing when tapped is worse than a
 * row that plainly does not invite one, so it carries no chevron and no press
 * state.
 */
function ContextRow({ usage }: { usage: ContextUsage }) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        minHeight: 44,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.sm
      }}
      testID="option-context"
    >
      <View style={{ flex: 1 }}>
        <Text>{chatStrings.context.label}</Text>
        {usage.estimated ? (
          <Text color="textMuted" variant="meta">
            {chatStrings.context.estimated}
          </Text>
        ) : null}
      </View>
      <ContextMeter detail usage={usage} />
    </View>
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

  // The catalogue's label when the gateway listed this model, and the id's own
  // reading when it did not — a chat can sit on a model the inventory has since
  // dropped, and that row should not be the one place a wire id shows through.
  const modelLabel =
    props.modelOptions.find(option => option.value === props.model)?.label ?? prettyModelName(props.model)
  const reasoningLabel =
    props.reasoningOptions.find(option => option.value === props.reasoningEffort)?.label ?? props.reasoningEffort
  // The named stop, or the bare multiplier for a value no step produces — which
  // only an older build or a hand-edited preference file can supply, and which
  // is still better shown than silently redrawn as "Normal".
  const rateLabel =
    RATE_OPTIONS.find(option => option.value === String(props.voice?.rate))?.label ?? String(props.voice?.rate ?? 1)
  const muteLabel =
    props.mutedUntil === null
      ? chatStrings.options.notMuted
      : props.mutedUntil === MUTE_FOREVER
        ? strings.layout.muted
        : strings.layout.mutedUntil(formatMuteUntil(props.mutedUntil, nowSeconds(), strings.layout.muteWeekdays))

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
      {pane === 'mute' ? (
        /*
          The four spans, and Unmute when there is something to undo.

          A picker rather than a switch, because "mute" is not a boolean the
          reader is toggling — it is a span they are choosing. Nothing is
          ticked: the stored value is a DEADLINE, and a deadline cannot say
          which of the four buttons produced it once an hour has passed.
        */
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.onChangeMute(option.value === UNMUTE ? null : muteUntil(option.value as MuteDuration, nowSeconds()))
            setPane('root')
          }}
          options={[
            ...MUTE_DURATIONS.map(duration => ({
              value: duration,
              label: strings.layout.muteFor[duration]
            })),
            ...(props.mutedUntil === null ? [] : [{ value: UNMUTE, label: strings.layout.unmute }])
          ]}
          title={strings.layout.mute}
          value=""
        />
      ) : pane === 'colour' ? (
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
      ) : pane === 'rate' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.voice?.onChangeRate(Number(option.value))
            setPane('root')
          }}
          options={RATE_OPTIONS}
          title={chatStrings.voice.rate}
          // Stringified, because a picker deals in ids and 1 and 1.0 are the
          // same rate but not the same string. `RATE_STEPS` is the only source
          // of these values, so the round trip through `String` is exact.
          value={String(props.voice?.rate ?? 1)}
        />
      ) : pane === 'dictationLanguage' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.voice?.dictation?.onChangeLanguage(option.value)
            setPane('root')
          }}
          options={[
            { value: DICTATION_AUTO, label: chatStrings.voice.dictationAuto },
            ...(props.voice?.dictation?.languages ?? []).map(tag => ({
              value: tag,
              label: languageLabel(tag),
              detail: tag
            }))
          ]}
          // A list of installed models can be long on a phone that has collected
          // a few, and it is the same shape as the model list next door.
          searchable
          title={chatStrings.voice.dictationLanguage}
          value={props.voice?.dictation?.language ?? DICTATION_AUTO}
        />
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
            {/*
              The row says the STATE, not the action: "Muted until Thu 09:00" is
              the only place a reader who set this on another device two days
              ago can find out when the chat comes back.
            */}
            <DisclosureRow
              label={strings.layout.mute}
              onPress={() => setPane('mute')}
              testID="option-mute"
              value={muteLabel}
            />
            {/*
              Read-only, and the only row here that is. Everything else in this
              group is a decision the reader makes; this is a fact they check one
              of those decisions against — whether there is room for another long
              turn before the session has to compact.
            */}
            {props.contextUsage ? <ContextRow usage={props.contextUsage} /> : null}
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

          {props.voice ? (
            <InsetGroup footer={chatStrings.voice.autoReadHint} header={chatStrings.voice.header}>
              <SwitchRow
                label={chatStrings.voice.autoRead}
                onChange={props.voice.onChangeAutoRead}
                testID="option-auto-read"
                value={props.voice.autoRead}
              />
              <DisclosureRow
                label={chatStrings.voice.rate}
                onPress={() => setPane('rate')}
                testID="option-voice-rate"
                value={rateLabel}
              />
              {/*
                Only while there is something to stop.

                A permanently present Stop row would be a control that does
                nothing almost all of the time, and the sheet already has a rule
                about those — see the context row above, and `onExport`. It is
                here rather than in the message menu because this is the one
                surface that can stop a read the reader did not start from a
                row: an automatic one.
              */}
              {props.voice.dictation ? (
                <DisclosureRow
                  label={chatStrings.voice.dictationLanguage}
                  onPress={() => setPane('dictationLanguage')}
                  testID="option-dictation-language"
                  value={
                    props.voice.dictation.language === DICTATION_AUTO
                      ? chatStrings.voice.dictationAuto
                      : languageLabel(props.voice.dictation.language)
                  }
                />
              ) : null}
              {props.voice.reading ? (
                <InsetButtonRow
                  onPress={props.voice.onStopReading}
                  testID="option-stop-reading"
                  title={chatStrings.menu.stopReading}
                />
              ) : null}
            </InsetGroup>
          ) : null}

          {props.onExport ? (
            <InsetGroup footer={chatStrings.export.hint} header={chatStrings.export.header}>
              {/*
                Two formats rather than one, and neither is a default. A
                Markdown file is for somewhere that renders it and a .txt is for
                somewhere that does not, and guessing which a reader meant is
                the same mistake offering only one Copy line would be — which is
                the argument `message-menu.ts` already makes about exactly this.
              */}
              <InsetButtonRow
                onPress={() => props.onExport?.('md')}
                testID="option-export-markdown"
                title={
                  SHARE_FILE_VERB === 'download'
                    ? chatStrings.export.downloadMarkdown
                    : chatStrings.export.shareMarkdown
                }
              />
              <InsetButtonRow
                onPress={() => props.onExport?.('txt')}
                testID="option-export-text"
                title={SHARE_FILE_VERB === 'download' ? chatStrings.export.downloadText : chatStrings.export.shareText}
              />
            </InsetGroup>
          ) : null}

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
