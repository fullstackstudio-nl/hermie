/**
 * The developer gallery: every chat component with realistic data, on one
 * screen, on every platform.
 *
 * It exists because the chat kit is built ahead of the data layer. Without it
 * the only way to look at a tool card, a forwarded DM or the approval sheet
 * would be to drive a real gateway into the exact state that produces one — and
 * some of those states (a failed delivery, an untrusted-output banner) are hard
 * to produce on purpose.
 *
 * The streaming section appends to a real reply on an interval, so the
 * incremental Markdown path is exercised the way a live turn exercises it.
 */
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'

import {
  AgentsBar,
  AgentsSheet,
  AssistantBubble,
  AttachMenu,
  BotDmInBubble,
  BotDmOutLine,
  BotDmRollup,
  ChatHeader,
  Composer,
  CronDeliveryCard,
  DateSeparator,
  DiffView,
  ErrorCard,
  ExpandedProvider,
  FileChip,
  JumpToLatestPill,
  NoticePill,
  QueuedChip,
  ReasoningDisclosure,
  rollupDmRuns,
  StatusRow,
  SubagentGroupCard,
  ToolCard,
  TranscriptList,
  TypingIndicator,
  UserBubble
} from '../../chat-ui'
import {
  approvalItem,
  assistantItem,
  assistantMarkdown,
  botDmInItem,
  botDmOutItem,
  clarifyItem,
  cronDeliveryItem,
  dmRunItems,
  errorAssistantItem,
  failedDmOutItem,
  failedToolItem,
  galleryTranscript,
  inlineCodeRegressionItem,
  interimAssistantItem,
  longReportItem,
  noticeItem,
  patchToolItem,
  pendingDmOutItem,
  processNoticeItem,
  recoverableAssistantItem,
  runningToolItem,
  sampleDiff,
  searchToolItem,
  statusItem,
  subagentGroupItem,
  subagentMap,
  subagentTree,
  userItem
} from '../../chat-ui/fixtures'
import type { ApprovalItem, ClarifyItem, PickerOption, Verbosity } from '../../chat-ui/types'
import { Button, InsetButtonRow, InsetGroup, Screen, Text } from '../../ui/primitives'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import type { AccentName } from '../../ui/tokens'

export interface GalleryScreenProps {
  onClose?: () => void
}

/** The Settings row that opens this screen; kept here so the two cannot drift. */
export const GALLERY_ROW_TITLE = 'Component gallery'

const STREAM_INTERVAL_MS = 120
const STREAM_CHUNK = 24

const REASONING_OPTIONS: PickerOption[] = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' }
]

const SLASH_SUGGESTIONS = [
  { description: 'Compact the conversation', name: 'compact' },
  { description: 'Show the current model', name: 'model' },
  { description: 'Reset this chat', name: 'reset' }
]

const MODEL_OPTIONS: PickerOption[] = [
  { detail: 'Whatever the gateway is configured for', label: 'Gateway default', value: 'default' },
  { detail: 'Runs on the gateway host', label: 'example-model-local', value: 'example-model-local' },
  { detail: 'Long context', expensive: true, label: 'example-model-large', value: 'example-model-large' }
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm }}>
      <Text color="textFaint" variant="micro">
        {title.toUpperCase()}
      </Text>
      <View
        style={{
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.card,
          borderWidth: 1,
          gap: theme.space.sm,
          padding: theme.space.md
        }}
      >
        {children}
      </View>
    </View>
  )
}

/**
 * The simulated turn, in its own component on purpose.
 *
 * The timer fires several times a second; if the state lived on the gallery,
 * every tick would re-render every other section — four tool cards, a diff, a
 * table — and the screen would stop scrolling. Isolating the state is the same
 * discipline a real chat needs, which makes it the right thing to demonstrate.
 */
function StreamingSection() {
  const [streaming, setStreaming] = useState(true)
  const [length, setLength] = useState(0)

  useEffect(() => {
    if (!streaming) {
      return
    }

    const timer = setInterval(() => {
      setLength(current =>
        current >= assistantMarkdown.length ? 0 : Math.min(assistantMarkdown.length, current + STREAM_CHUNK)
      )
    }, STREAM_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [streaming])

  const text = assistantMarkdown.slice(0, length)

  const item = useMemo(
    () => ({ ...assistantItem, id: 'a-live', reasoning: undefined, streaming: true, text, version: text.length }),
    [text]
  )

  return (
    <Section title="Streaming reply">
      {/* Fixed height: the reply grows and resets several times a second, and a
          section that changes height would shove the whole gallery around
          under the reader's finger. */}
      <View style={{ height: 320, overflow: 'hidden' }}>
        <AssistantBubble item={item} presentation="full" />
      </View>
      <Button
        onPress={() => setStreaming(current => !current)}
        title={streaming ? 'Pause stream' : 'Resume stream'}
        variant="secondary"
      />
    </Section>
  )
}

export function GalleryScreen({ onClose }: GalleryScreenProps) {
  const theme = useTheme()

  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [lastAction, setLastAction] = useState('Nothing yet')

  const [agentsOpen, setAgentsOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalItem>(approvalItem)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [clarifyOpen, setClarifyOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [cronExpanded, setCronExpanded] = useState(false)

  const [yolo, setYolo] = useState(false)
  const [fast, setFast] = useState(true)
  const [reasoning, setReasoning] = useState('medium')
  const [model, setModel] = useState('default')
  const [verbosity, setVerbosity] = useState<Verbosity>('normal')
  const [accent, setAccent] = useState<AccentName>('violet')
  const [showBotToBot, setShowBotToBot] = useState(true)
  const [showThinking, setShowThinking] = useState(false)

  const clarify: ClarifyItem = clarifyItem

  // The transcript demo is its own screen rather than a section: a `FlatList`
  // inside a vertical `ScrollView` is a nested virtualized list, which React
  // Native warns about and which measures wrong on every platform. Giving it
  // the whole screen is also the honest demo — header, agents bar, list and
  // composer in the layout a real chat uses.
  const chatDemo = (
    <Screen edgeToEdgeTop={false} padded={false} testID="gallery-chat">
      <ChatHeader
        handle="researcher"
        name="Researcher"
        onBack={() => setTranscriptOpen(false)}
        onOpenOptions={() => setOptionsOpen(true)}
        presence="working"
      />

      <TranscriptList
        header={<AgentsBar count={3} elapsedSeconds={72} onPress={() => setAgentsOpen(true)} />}
        items={galleryTranscript}
        onOpenBot={handle => setLastAction(`Open bot @${handle}`)}
        onOpenRequest={item => (item.kind === 'approval' ? setApprovalOpen(true) : setClarifyOpen(true))}
        onOpenTranscript={id => setLastAction(`Open transcript ${id}`)}
        onRetry={id => setLastAction(`Retry ${id}`)}
        receipt="delivered"
        selfHandle="researcher"
        subagents={subagentMap}
        testID="gallery-transcript"
        typing={running}
      />

      <Composer
        botName="Researcher"
        // Nothing above it is avoiding the keyboard here, unlike in a chat.
        keyboardAvoiding
        onAttach={() => setLastAction('Attach pressed')}
        onChangeText={setDraft}
        onSend={text => {
          setLastAction(`Sent: ${text}`)
          setDraft('')
          setRunning(true)
        }}
        onStop={() => setRunning(false)}
        running={running}
        suggestions={SLASH_SUGGESTIONS}
        value={draft}
      />
    </Screen>
  )

  const componentList = (
    <Screen edgeToEdgeTop={false} padded={false}>
      <ScrollView contentContainerStyle={{ gap: theme.space.xl, padding: theme.space.lg }}>
        <View style={{ gap: theme.space.sm }}>
          <Text variant="title">Component gallery</Text>
          <Text color="textMuted" variant="preview">
            Every chat surface with fixture data. Last action: {lastAction}
          </Text>
          {onClose ? <Button onPress={onClose} title="Back to settings" variant="secondary" /> : null}
        </View>

        <Section title="Chat header">
          <ChatHeader
            handle="researcher"
            name="Researcher"
            onOpenOptions={() => setOptionsOpen(true)}
            presence="working"
            testID="gallery-chat-header"
          />
          <ChatHeader
            handle="writer"
            lastSeenAt={1_767_000_000}
            name="Writer"
            onOpenOptions={() => setOptionsOpen(true)}
            presence="offline"
            testID="gallery-chat-header-offline"
          />
          <ChatHeader
            handle="bookkeeper"
            name="Bookkeeper"
            onOpenOptions={() => setOptionsOpen(true)}
            presence="needsInput"
            testID="gallery-chat-header-needs-input"
          />
        </Section>

        <Section title="Agents bar">
          <AgentsBar count={3} elapsedSeconds={72} onPress={() => setAgentsOpen(true)} testID="gallery-agents-bar" />
        </Section>

        <StreamingSection />

        <Section title="Bubbles">
          <DateSeparator label="Yesterday" />
          {/* Grouping: three own bubbles in a run, only the last with a tail. */}
          <UserBubble grouped={false} item={userItem} tail={false} />
          <UserBubble grouped item={{ ...userItem, id: 'u1b', text: 'And keep it short.' }} tail={false} />
          <UserBubble grouped item={{ ...userItem, id: 'u1c', text: 'Thanks.' }} receipt="read" tail />
          <AssistantBubble item={assistantItem} presentation="full" showFooter />
          <AssistantBubble item={interimAssistantItem} presentation="full" />
          <BotDmInBubble
            answered
            item={botDmInItem}
            onOpenBot={handle => setLastAction(`Open bot @${handle}`)}
            selfHandle="researcher"
          />
          <TypingIndicator />
        </Section>

        <Section title="Receipts">
          <UserBubble item={{ ...userItem, id: 'u-r1', text: 'Sending.' }} receipt="sending" />
          <UserBubble item={{ ...userItem, id: 'u-r2', text: 'Sent.' }} receipt="sent" />
          <UserBubble item={{ ...userItem, id: 'u-r3', text: 'Delivered.' }} receipt="delivered" />
          <UserBubble item={{ ...userItem, id: 'u-r4', text: 'Read.' }} receipt="read" />
        </Section>

        <Section title="Long reply — reading treatment and fold">
          {/* The fold's state lives above the list, so the gallery provides one. */}
          <ExpandedProvider>
            <AssistantBubble item={longReportItem} presentation="full" showFooter />
          </ExpandedProvider>
        </Section>

        <Section title="Markdown regressions">
          {/* The exact sentence the owner hit: a code span near a line end, and
              emphasis a model opened with a stray space. */}
          <ExpandedProvider>
            <AssistantBubble item={inlineCodeRegressionItem} presentation="full" />
          </ExpandedProvider>
        </Section>

        <Section title="Cron delivery">
          <CronDeliveryCard
            body={cronDeliveryItem.body}
            expanded={cronExpanded}
            name={cronDeliveryItem.jobName}
            onOpenCron={() => setLastAction('Open cron')}
            onRunNow={() => setLastAction('Run cron now')}
            onToggle={() => setCronExpanded(current => !current)}
            testID="gallery-cron-card"
            ts={cronDeliveryItem.ts}
          />
        </Section>

        <Section title="Errors">
          <AssistantBubble item={errorAssistantItem} onRetry={() => setLastAction('Retry pressed')} />
          <AssistantBubble item={recoverableAssistantItem} />
          <ErrorCard message="The gateway is unreachable." onRetry={() => setLastAction('Retry')} retryable />
        </Section>

        <Section title="Reasoning">
          <ReasoningDisclosure durationS={4} text="Compare the changelog with the docs, then hand off to Writer." />
        </Section>

        <Section title="Tool cards">
          <ToolCard item={searchToolItem} presentation="collapsed" />
          <ToolCard item={patchToolItem} presentation="full" />
          <ToolCard item={failedToolItem} presentation="collapsed" />
          <ToolCard item={runningToolItem} presentation="collapsed" />
        </Section>

        <Section title="Diff">
          <DiffView diff={sampleDiff} />
        </Section>

        <Section title="Bot-to-bot lines">
          <ExpandedProvider>
            <View style={{ gap: theme.space.sm + 1 }}>
              <BotDmOutLine
                item={botDmOutItem}
                onOpenBot={handle => setLastAction(`Open bot @${handle}`)}
                presentation="collapsed"
              />
              <BotDmOutLine item={pendingDmOutItem} presentation="collapsed" />
              <BotDmOutLine item={failedDmOutItem} presentation="collapsed" />
            </View>
          </ExpandedProvider>
        </Section>

        <Section title="Bot-to-bot roll-up">
          <ExpandedProvider>
            <BotDmRollup
              run={{
                handle: 'writer',
                id: dmRunItems[0]?.id ?? 'dm-run-0',
                items: dmRunItems,
                replies: 4
              }}
            />
          </ExpandedProvider>
          <Text color="textFaint" variant="micro">
            {`${Object.values(rollupDmRuns(dmRunItems.map(item => ({ item, presentation: 'collapsed' as const })))).length} rows in the run`}
          </Text>
        </Section>

        <Section title="Agents">
          <SubagentGroupCard
            item={subagentGroupItem}
            onOpenTranscript={id => setLastAction(`Open transcript ${id}`)}
            presentation="full"
            subagents={[subagentMap['sa-1']!, subagentMap['sa-2']!, subagentMap['sa-3']!]}
          />
        </Section>

        <Section title="Rows and pills">
          <StatusRow item={statusItem} presentation="chip" />
          <NoticePill item={noticeItem} presentation="collapsed" />
          <NoticePill item={processNoticeItem} presentation="full" />
          <QueuedChip text="Include source links" />
          <JumpToLatestPill count={3} onPress={() => setLastAction('Jump to latest')} />
        </Section>

        <Section title="File chips">
          <View style={{ alignItems: 'flex-start', gap: theme.space.sm }}>
            <FileChip
              name="quarterly-report-final-v4.xlsx"
              onRemove={() => setLastAction('Remove chip')}
              size={48210}
            />
            <FileChip name="archive.zip" progress={0.4} size={98_000_000} status="uploading" />
            <FileChip error="Too large · 100 MB max" name="capture.mov" size={420_000_000} status="error" />
            <FileChip name="notes.md" onAccent size={1240} />
          </View>
        </Section>

        <Section title="Attach menu">
          <AttachMenu
            choices={[
              { id: 'photo', label: 'Photo library' },
              { busy: true, id: 'file', label: 'Choose file' }
            ]}
            onChoose={id => setLastAction(`Attach ${id}`)}
            testID="gallery-attach-menu"
          />
        </Section>

        <Section title="Composer">
          <Composer
            attachments={[
              { id: 'att-1', kind: 'image', name: 'diagram.png' },
              { id: 'att-2', kind: 'file', name: 'quarterly-report-final-v4.xlsx', size: 48210, status: 'uploaded' },
              { error: 'Too large · 100 MB max', id: 'att-3', kind: 'file', name: 'capture.mov', status: 'error' }
            ]}
            botName="Researcher"
            onAttach={() => setLastAction('Attach pressed')}
            onChangeText={setDraft}
            onRemoveAttachment={id => setLastAction(`Remove ${id}`)}
            onSend={text => {
              setLastAction(`Sent: ${text}`)
              setDraft('')
              setRunning(true)
            }}
            onStop={() => {
              setRunning(false)
              setLastAction('Stopped')
            }}
            queuedText="Include source links"
            running={running}
            suggestions={SLASH_SUGGESTIONS}
            value={draft}
          />
        </Section>

        <Section title="Sheets">
          <InsetGroup>
            <InsetButtonRow onPress={() => setApprovalOpen(true)} title="Open approval sheet" />
            <InsetButtonRow onPress={() => setClarifyOpen(true)} title="Open clarify sheet" />
            <InsetButtonRow onPress={() => setOptionsOpen(true)} title="Open chat options" />
            <InsetButtonRow onPress={() => setAgentsOpen(true)} title="Open agents sheet" />
            <InsetButtonRow onPress={() => setTranscriptOpen(true)} title="Open the full chat screen" />
          </InsetGroup>
        </Section>

        <View style={{ height: theme.space.xxxl }} />
      </ScrollView>
    </Screen>
  )

  // The sheets are rendered once, outside the body switch: a `Modal` that
  // unmounts because the screen behind it changed would take its own dismiss
  // animation with it.
  return (
    <>
      {transcriptOpen ? chatDemo : componentList}

      <AgentsSheet
        onClose={() => setAgentsOpen(false)}
        onInterrupt={id => setLastAction(`Stop ${id}`)}
        onOpenTranscript={id => setLastAction(`Open transcript ${id}`)}
        onSteer={(id, text) => setLastAction(`Steer ${id}: ${text}`)}
        tree={subagentTree}
        visible={agentsOpen}
      />

      <ApprovalSheet
        botHandle="researcher"
        item={approval}
        onClose={() => {
          setApprovalOpen(false)
          setApproval(approvalItem)
        }}
        onRespond={choice => {
          setApproval(current => ({ ...current, answer: choice, state: 'answered', version: current.version + 1 }))
          setLastAction(`Approval: ${choice}`)
        }}
        visible={approvalOpen}
        workingDirectory="/workspace/docs"
      />

      <ClarifySheet
        item={clarify}
        onClose={() => setClarifyOpen(false)}
        onLock={(qid, answer) => setLastAction(`Locked ${qid}: ${answer}`)}
        onSkip={() => {
          setClarifyOpen(false)
          setLastAction('Clarify skipped')
        }}
        onSubmit={answers => {
          setClarifyOpen(false)
          setLastAction(`Clarify: ${JSON.stringify(answers)}`)
        }}
        visible={clarifyOpen}
      />

      <ChatOptionsSheet
        accent={accent}
        botName="Researcher"
        fast={fast}
        model={model}
        modelOptions={MODEL_OPTIONS}
        onChangeFast={setFast}
        onChangeModel={setModel}
        onChangeReasoningEffort={setReasoning}
        onChangeShowBotToBot={setShowBotToBot}
        onChangeShowThinking={setShowThinking}
        onChangeAccent={setAccent}
        onChangeVerbosity={setVerbosity}
        onChangeYolo={setYolo}
        onClose={() => setOptionsOpen(false)}
        onPickExpensiveModel={value => setLastAction(`Confirm expensive model ${value}`)}
        reasoningEffort={reasoning}
        reasoningOptions={REASONING_OPTIONS}
        showBotToBot={showBotToBot}
        showThinking={showThinking}
        verbosity={verbosity}
        visible={optionsOpen}
        yolo={yolo}
      />
    </>
  )
}
