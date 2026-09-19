/**
 * The agents bar expanded: the delegation tree, each child's stream, and the
 * three things you can actually do to a running child — steer it, stop it, or
 * open its own transcript.
 *
 * Steering is a text field rather than a menu because a correction is prose;
 * `subagent.steer` takes the words as written.
 */
import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { BottomSheet } from '../ui/BottomSheet'
import { Button, Text, TextField } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { formatDuration } from './format'
import { statusGlyph, statusTone } from './SubagentGroupCard'
import { chatStrings } from './strings'
import type { SubagentNode } from './types'

export interface AgentsSheetProps {
  visible: boolean
  onClose: () => void
  /** `subagentTree(state)` — roots first, children nested. */
  tree: SubagentNode[]
  onSteer?: (subagentId: string, text: string) => void
  onInterrupt?: (subagentId: string) => void
  onOpenTranscript?: (subagentId: string) => void
}

function AgentRow({
  node,
  depth,
  onSteer,
  onInterrupt,
  onOpenTranscript
}: {
  node: SubagentNode
  depth: number
  onSteer?: (subagentId: string, text: string) => void
  onInterrupt?: (subagentId: string) => void
  onOpenTranscript?: (subagentId: string) => void
}) {
  const theme = useTheme()
  const [steering, setSteering] = useState(false)
  const [draft, setDraft] = useState('')

  const live = node.status === 'running' || node.status === 'queued'

  const submitSteer = () => {
    const text = draft.trim()

    if (!text) {
      return
    }

    onSteer?.(node.id, text)
    setDraft('')
    setSteering(false)
  }

  return (
    <View style={{ gap: theme.space.xs, marginLeft: depth * theme.space.md }}>
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          gap: theme.space.xs,
          padding: theme.space.md
        }}
        testID={`agent-row-${node.id}`}
      >
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          <Text color={statusTone(node.status)} style={{ fontSize: 12, width: 14 }}>
            {statusGlyph(node.status)}
          </Text>
          <Text style={{ color: theme.colors.text, flex: 1, fontSize: 15, fontWeight: '600' }}>{node.goal}</Text>
          <Text color="textMuted" style={{ fontSize: 11 }}>
            {formatDuration(node.durationSeconds ?? Math.max(0, (node.updatedAt - node.startedAt) / 1000))}
          </Text>
        </View>

        <Text color="textMuted" style={{ fontSize: 11 }}>
          {`${chatStrings.subagents.status[node.status]}${node.currentTool ? ` · ${node.currentTool}` : ''}`}
        </Text>

        {node.stream.length ? (
          <View style={{ gap: 2 }}>
            {node.stream.slice(-4).map((entry, index) => (
              <Text
                color={entry.isError ? 'danger' : 'textMuted'}
                key={index}
                numberOfLines={2}
                style={{ fontSize: 12, lineHeight: 17 }}
              >
                {entry.text}
              </Text>
            ))}
          </View>
        ) : null}

        {node.summary ? (
          <Text color="text" style={{ fontSize: 13, lineHeight: 19 }}>
            {node.summary}
          </Text>
        ) : null}

        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          {live && onSteer ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSteering(current => !current)}
              testID={`agent-steer-${node.id}`}
            >
              <Text color="accent" variant="caption">
                {chatStrings.subagents.steer}
              </Text>
            </Pressable>
          ) : null}

          {live && onInterrupt ? (
            <Pressable accessibilityRole="button" onPress={() => onInterrupt(node.id)} testID={`agent-stop-${node.id}`}>
              <Text color="danger" variant="caption">
                {chatStrings.subagents.stop}
              </Text>
            </Pressable>
          ) : null}

          {onOpenTranscript && node.childSessionId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenTranscript(node.id)}
              testID={`agent-transcript-${node.id}`}
            >
              <Text color="accent" variant="caption">
                {chatStrings.subagents.openTranscript}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {steering ? (
          <View style={{ gap: theme.space.sm }}>
            <TextField
              onChangeText={setDraft}
              onSubmitEditing={submitSteer}
              placeholder={chatStrings.subagents.steerPlaceholder}
              returnKeyType="send"
              testID={`agent-steer-input-${node.id}`}
              value={draft}
            />
            <Button
              disabled={!draft.trim()}
              onPress={submitSteer}
              testID={`agent-steer-send-${node.id}`}
              title={chatStrings.subagents.steer}
            />
          </View>
        ) : null}
      </View>

      {node.children.map(child => (
        <AgentRow
          depth={depth + 1}
          key={child.id}
          node={child}
          onInterrupt={onInterrupt}
          onOpenTranscript={onOpenTranscript}
          onSteer={onSteer}
        />
      ))}
    </View>
  )
}

export function AgentsSheet({ visible, onClose, tree, onSteer, onInterrupt, onOpenTranscript }: AgentsSheetProps) {
  const theme = useTheme()

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.subagents.title}
      onRequestClose={onClose}
      testID="agents-sheet"
      visible={visible}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="title">{chatStrings.subagents.title}</Text>
        <Pressable accessibilityRole="button" onPress={onClose} testID="agents-sheet-close">
          <Text color="accent" variant="body">
            {chatStrings.options.done}
          </Text>
        </Pressable>
      </View>

      {tree.length ? (
        <View style={{ gap: theme.space.sm }}>
          {tree.map(node => (
            <AgentRow
              depth={0}
              key={node.id}
              node={node}
              onInterrupt={onInterrupt}
              onOpenTranscript={onOpenTranscript}
              onSteer={onSteer}
            />
          ))}
        </View>
      ) : (
        <Text color="textMuted">{chatStrings.subagents.idle}</Text>
      )}
    </BottomSheet>
  )
}
