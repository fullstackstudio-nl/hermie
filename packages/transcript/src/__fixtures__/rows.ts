/**
 * Hand-written transcript rows in both wire shapes.
 *
 * The RPC rows mirror `tui_gateway/session_history.py::_history_to_messages`
 * (`text`, `row_id`, projected tool rows without a result); the REST rows mirror
 * `GET /api/sessions/{id}/messages` (`content` / `display_content`, numeric
 * `id`). Every `display_kind` the gateway can emit appears at least once.
 */
import type { TranscriptRow } from '../rows-to-items'

export const DM_DELIVERY_COMMAND =
  '/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file ' +
  '/root/.hermes/dm/2f9c.json hermes -p writer chat -c "Bot Chat" -Q -q @/root/.hermes/dm/2f9c.json'

export const LEGACY_DELIVERY_COMMAND =
  'hermes -p writer chat -c "Bot Chat" --create-if-missing -Q -q "Message from 🤖 Researcher (@researcher): ping"'

export const dmReplyProcessText = [
  '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
  `Command: ${DM_DELIVERY_COMMAND}`,
  'Output:',
  'Message from 🤖 Writer (@writer): Draft is ready, I pushed it to the shared folder.]'
].join('\n')

export const plainProcessText = [
  '[IMPORTANT: Background process proc-aa01 exited (exit code 1).',
  'Command: npm run build',
  'Output:',
  'error TS2345: Argument of type string is not assignable.]'
].join('\n')

/** A full canonical Bot Chat as `session.history` projects it. */
export const rpcHistoryRows: TranscriptRow[] = [
  { role: 'user', text: 'Summarise the release notes.', timestamp: 1_700_000_000, row_id: 1 },
  {
    role: 'assistant',
    text: 'Reading them now.',
    reasoning: 'The user wants a summary; read the file first.',
    timestamp: 1_700_000_001,
    row_id: 2
  },
  { role: 'tool', name: 'read_file', context: 'read_file(CHANGELOG.md)', args: { path: 'CHANGELOG.md' } },
  { role: 'assistant', text: 'Three fixes and one feature.', timestamp: 1_700_000_005, row_id: 3 },
  { role: 'user', text: 'Switched model', timestamp: 1_700_000_006, row_id: 4, display_kind: 'model_switch' },
  {
    role: 'user',
    text: 'Switched personality',
    timestamp: 1_700_000_007,
    row_id: 5,
    display_kind: 'personality_switch'
  },
  { role: 'user', text: 'Resuming', timestamp: 1_700_000_008, row_id: 6, display_kind: 'auto_continue' },
  { role: 'user', text: '/release-notes', timestamp: 1_700_000_009, row_id: 7, display_kind: 'skill_invocation' },
  { role: 'user', text: 'actually make it shorter', timestamp: 1_700_000_010, row_id: 8, display_kind: 'steer' },
  {
    role: 'user',
    text: 'Bot roster refreshed',
    timestamp: 1_700_000_011,
    row_id: 9,
    display_kind: 'internal_notification'
  },
  { role: 'user', text: 'Something new', timestamp: 1_700_000_012, row_id: 10, display_kind: 'brand_new_kind' },
  { role: 'user', text: 'Hidden scaffolding', timestamp: 1_700_000_013, row_id: 11, display_kind: 'hidden' },
  {
    role: 'tool',
    name: 'message_agent',
    tool_id: 'call_dm_1',
    context: 'message_agent(writer)',
    args: { target: '@writer', message: 'Can you draft the announcement?' }
  },
  {
    role: 'user',
    text: dmReplyProcessText,
    timestamp: 1_700_000_020,
    row_id: 12,
    display_kind: 'process_complete',
    display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
  },
  {
    role: 'tool',
    name: 'delegate_task',
    tool_id: 'call_delegate_1',
    context: 'delegate_task(3 tasks)',
    args: { tasks: [{ goal: 'Audit deps' }, { goal: 'Write tests' }, { goal: 'Update docs' }] }
  },
  {
    role: 'user',
    text: '[ASYNC DELEGATION BATCH COMPLETE]\n--- ✓ TASK 1/3: Audit deps  (status=completed) ---\nNo drift.',
    timestamp: 1_700_000_030,
    row_id: 13,
    display_kind: 'async_delegation_complete',
    display_metadata: { task_count: 3 }
  },
  {
    role: 'user',
    text: 'Message from 🤖 Writer (@writer): The announcement draft is in docs/announce.md.',
    timestamp: 1_700_000_040,
    row_id: 14
  },
  { role: 'assistant', text: 'Thanks — I will fold that in.', timestamp: 1_700_000_041, row_id: 15 }
]

/** The same conversation as the REST transcript prefetch ships it. */
export const restHistoryRows: TranscriptRow[] = [
  { role: 'user', content: 'Summarise the release notes.', timestamp: 1_700_000_000, id: 1 },
  {
    role: 'assistant',
    content: 'Reading them now.',
    reasoning_content: 'Read the file first.',
    timestamp: 1_700_000_001,
    id: 2
  },
  { role: 'tool', name: 'read_file', tool_id: 'call_read_1', context: 'read_file(CHANGELOG.md)' },
  {
    role: 'user',
    content: 'raw stored body',
    display_content: 'Message from 🤖 Writer (@writer): The announcement draft is in docs/announce.md.',
    timestamp: 1_700_000_040,
    id: 14
  },
  { role: 'assistant', content: 'Thanks — I will fold that in.', timestamp: 1_700_000_041, id: 15 }
]

/** A user turn persisted with the model-facing scaffolding still attached. */
export const attachedContextRow: TranscriptRow = {
  role: 'user',
  row_id: 42,
  text: [
    'Look at @image:/tmp/shot.png and tell me what broke.',
    '',
    '--- Attached Context ---',
    '@file:/srv/app/server.ts',
    '@image:/tmp/shot.png',
    '',
    '--- Context Warnings ---',
    'one file was too large to inline'
  ].join('\n')
}

/** An assistant row whose reply only survives in the Responses-API sidecar. */
export const codexSidecarRow: TranscriptRow = {
  role: 'assistant',
  row_id: 77,
  text: '',
  codex_message_items: [
    {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'thinking out loud' }]
    },
    { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Recovered reply.' }] }
  ]
}
