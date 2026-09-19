/**
 * The one sheet a chat has on screen.
 *
 * Four sibling sheets used to decide their own visibility, which on iOS means
 * four sibling `Modal`s: the first one presented wins and the rest are never
 * shown. A permission request arriving while the options sheet was open was
 * therefore silently dropped, and the agent sat waiting on a question the user
 * was never offered.
 *
 * This component mounts at most ONE of them. `sheet-host.ts` decides which —
 * priority and the close-then-open swap live there, with no React in them, so
 * the ordering is testable on its own.
 *
 * It also owns the one thing the chat screen could not: a question that has
 * just been ANSWERED. `chat.requests` is `openRequests`, so the moment a
 * question resolves it vanishes from under the sheet. The host holds the item
 * it is showing by id instead, which is what makes the sheet's own "Answered
 * elsewhere" / "Timed out" branch reachable at all.
 */
import type { ApprovalItem, ClarifyItem } from '@hermie/transcript'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { AgentsSheet, type AgentsSheetProps } from '../../chat-ui'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet, type ChatOptionsSheetProps } from '../../ui/sheets'
import { SHEET_ANIMATION_MS } from '../../ui/BottomSheet'
import { initialSheetHostState, isSheetVisible, sheetHostReducer, targetSheet, type ManualSheet } from './sheet-host'

export type RequestItem = ApprovalItem | ClarifyItem

export interface ChatSheetHostProps {
  /** The sheet the reader opened themselves. */
  manual: ManualSheet
  /** The reader dismissed the agents or options sheet. */
  onCloseManual: () => void

  /** The oldest question still waiting and not put aside, from `chat.requests`. */
  request?: RequestItem
  /**
   * The current version of a question by id.
   *
   * The host holds an answered question by id, and `chat.requests` no longer
   * lists it, so the item has to come from the full transcript instead.
   */
  findRequest: (id: string) => RequestItem | undefined
  botHandle: string
  /** Called once per question, the first time it reaches the screen. */
  onShowRequest?: (item: RequestItem) => void
  onRespondApproval: (item: ApprovalItem, choice: string) => void
  onSubmitClarify: (item: ClarifyItem, answers: Record<string, string>) => void
  onLockClarify: (item: ClarifyItem, qid: string, answer: string) => void
  /** Take the question off the screen. An OPEN one stays open in the transcript. */
  onCloseRequest: (item: RequestItem) => void

  agents: Omit<AgentsSheetProps, 'visible' | 'onClose' | 'onClosed'>
  options: Omit<ChatOptionsSheetProps, 'visible' | 'onClose' | 'onClosed'>

  /** How long a question answered here stays up before closing itself. */
  answeredDismissMs?: number
  /** Forwarded to the approval sheet; tests pass 0. */
  tapGuardMs?: number
}

/** Long enough to read "Answered: Allow once", short enough not to be in the way. */
const ANSWERED_DISMISS_MS = 2_000

/**
 * A slide-out that never reports finishing would strand the next sheet.
 *
 * `Animated` on the JS driver stops ticking while the app is in the background,
 * so the completion callback genuinely can be late by minutes. This is the
 * ceiling after which the host swaps anyway.
 */
const SETTLE_FALLBACK_MS = SHEET_ANIMATION_MS * 4

export function ChatSheetHost({
  manual,
  onCloseManual,
  request,
  findRequest,
  botHandle,
  onShowRequest,
  onRespondApproval,
  onSubmitClarify,
  onLockClarify,
  onCloseRequest,
  agents,
  options,
  answeredDismissMs = ANSWERED_DISMISS_MS,
  tapGuardMs
}: ChatSheetHostProps) {
  const [held, setHeld] = useState<string | null>(() => request?.id ?? null)
  const [state, dispatch] = useReducer(sheetHostReducer, initialSheetHostState)

  // Questions answered from THIS sheet. Those are the ones that may close
  // themselves; one answered somewhere else, or withdrawn, waits for the
  // reader, because they never saw what happened to it.
  const answeredHere = useRef<string | null>(null)

  // Which question is on screen, derived rather than stored: a held question
  // stays while it is open, and keeps its place afterwards so its outcome can
  // be read — but a NEW question waiting on the agent takes over at once.
  const heldItem = held ? findRequest(held) : undefined
  const keepHeld = Boolean(heldItem) && (heldItem?.state === 'open' || !request)
  const shownId = keepHeld ? held : (request?.id ?? null)
  const shown = shownId ? findRequest(shownId) : undefined

  // The outgoing sheet still has to render while it slides out, after the item
  // it was showing has gone.
  const lastShown = useRef<RequestItem | undefined>(undefined)

  if (shown) {
    lastShown.current = shown
  }

  useEffect(() => {
    if (shownId !== held) {
      setHeld(shownId)
    }
  }, [held, shownId])

  const announced = useRef<string | null>(null)

  useEffect(() => {
    if (!shown || announced.current === shown.id) {
      return
    }

    announced.current = shown.id
    onShowRequest?.(shown)
  }, [onShowRequest, shown])

  // ── the swap ────────────────────────────────────────────────────────────
  const target = targetSheet(manual, Boolean(shownId))

  useEffect(() => {
    dispatch({ type: 'target', target })
  }, [target])

  const settling = state.presented !== state.target

  useEffect(() => {
    if (!settling) {
      return
    }

    const timer = setTimeout(() => dispatch({ type: 'settled' }), SETTLE_FALLBACK_MS)

    return () => clearTimeout(timer)
  }, [settling, state.presented, state.target])

  const visible = isSheetVisible(state)

  // ── an answered question closes itself ──────────────────────────────────
  const resolvedHere = Boolean(shown && shown.state === 'answered' && answeredHere.current === shown.id)

  useEffect(() => {
    if (!resolvedHere) {
      return
    }

    if (answeredDismissMs <= 0) {
      setHeld(null)

      return
    }

    const timer = setTimeout(() => setHeld(null), answeredDismissMs)

    return () => clearTimeout(timer)
  }, [answeredDismissMs, resolvedHere])

  const closeRequest = useMemo(
    () => (item: RequestItem) => {
      setHeld(null)
      onCloseRequest(item)
    },
    [onCloseRequest]
  )

  const settled = useMemo(() => () => dispatch({ type: 'settled' }), [])

  if (state.presented === 'request') {
    const item = shown ?? lastShown.current

    if (!item) {
      return null
    }

    return item.kind === 'approval' ? (
      <ApprovalSheet
        botHandle={botHandle}
        item={item}
        // Keyed by the question, so a second one gets a fresh tap guard and a
        // fresh stepper rather than inheriting the answers of the first.
        key={item.id}
        onClose={() => closeRequest(item)}
        onClosed={settled}
        onRespond={choice => {
          answeredHere.current = item.id
          onRespondApproval(item, choice)
        }}
        visible={visible}
        {...(tapGuardMs === undefined ? {} : { tapGuardMs })}
      />
    ) : (
      <ClarifySheet
        item={item}
        key={item.id}
        onClose={() => closeRequest(item)}
        onClosed={settled}
        onLock={(qid, answer) => onLockClarify(item, qid, answer)}
        onSkip={() => closeRequest(item)}
        onSubmit={answers => {
          answeredHere.current = item.id
          onSubmitClarify(item, answers)
        }}
        visible={visible}
      />
    )
  }

  if (state.presented === 'agents') {
    return <AgentsSheet {...agents} onClose={onCloseManual} onClosed={settled} visible={visible} />
  }

  if (state.presented === 'options') {
    return <ChatOptionsSheet {...options} onClose={onCloseManual} onClosed={settled} visible={visible} />
  }

  return null
}
