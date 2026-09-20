/**
 * Hold a chat row, drag it, drop it somewhere else.
 *
 * ## Why PanResponder and not a gesture library
 *
 * ADR-0010 keeps gesture libraries out of the chat surface. The list is not the chat
 * surface, so that decision does not forbid one here — but it does not pay for one
 * either. `react-native-gesture-handler` plus `reanimated` is two native
 * dependencies, a Babel plugin and a worklet runtime for one gesture on one screen,
 * and PanResponder is in React Native already. `Animated` with `useNativeDriver`
 * moves the lifted row off the JavaScript thread, which is the only part of this
 * that has to be smooth.
 *
 * ## The gesture: long press, THEN move
 *
 * A plain drag must keep doing what it did — scroll on a phone, nothing on a Mac
 * (`useDirectTouchPanOnly`) — so the drag has to be claimed rather than assumed.
 * The row's own `onLongPress` arms it and the first MOVE past a slop claims the
 * responder from the `Pressable`, which cancels the press so the chat does not also
 * open.
 *
 * That ordering is also what makes it coexist with the native context menu, which
 * is the other thing a long press does. `UIContextMenuInteraction` cancels itself
 * when the touch moves, and it has a longer delay than this does, so holding still
 * gets the menu and holding then moving gets the drag — the same split as the Files
 * app. Nothing arbitrates that explicitly; the two gestures are simply distinct.
 *
 * On Android a long press still opens the fallback sheet, because that sheet is the
 * only menu there and it has Move up / Move down in it. So `armEnabled` is off
 * there, and the drag is reached through the edit-mode handle instead.
 *
 * ## What the caller has to provide
 *
 * The geometry. This hook knows how far the finger has moved; `drag-order.ts` knows
 * what that means, and it needs each row's measured box. `measure` collects those
 * from `onLayout` into a ref — a ref rather than state because a measurement is not
 * something the list should re-render for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, type PanResponderInstance } from 'react-native'

import { haptic } from '../../platform/haptics'
import { dropEntryIndex, dropSlot, type DragAnchor, type RowBox } from './drag-order'

/** Beyond this, a press has become a drag. Below it, a finger is merely resting. */
const MOVE_SLOP = 6

/** How close to an edge starts the list scrolling under the dragged row. */
const EDGE_BAND = 72

/** Points per tick, sixty times a second. Slow enough to aim, fast enough to arrive. */
const EDGE_STEP = 6

const EDGE_INTERVAL_MS = 16

export interface RowDragOptions {
  anchors: readonly DragAnchor[]
  /** How many positions the arrangement has, for a drop past the last row. */
  entryCount: number
  /** Commit: put `botName` immediately before entry `index`. */
  onCommit: (botName: string, index: number) => void
  /** Scroll the list by a delta while the finger sits near an edge. */
  onAutoScroll: (delta: number) => void
  /** Long-press arming; off where a long press already means something else. */
  armEnabled: boolean
}

export interface RowDrag {
  /** The row being dragged, or null. */
  draggingName: string | null
  /** Translation for the lifted row. Stable, and driven natively. */
  translateY: Animated.Value
  /** The anchor key a drop line should be drawn above, or null. */
  dropKey: string | null
  /** `onLayout` for a row wrapper; one stable function per key. */
  measure: (key: string) => (event: { nativeEvent: { layout: { y: number; height: number } } }) => void
  /** Arm the drag for this row. The row's `onLongPress`. */
  arm: (botName: string) => void
  /** Disarm without dragging. The row's `onPressOut`. */
  disarm: () => void
  /** Pan handlers for a row wrapper: claims the gesture once armed. */
  rowHandlers: (botName: string) => PanResponderInstance['panHandlers']
  /** Pan handlers for an edit-mode handle: claims immediately, no long press. */
  handleHandlers: (botName: string) => PanResponderInstance['panHandlers']
  /** Where the list is scrolled and how tall it is, for the edge bands. */
  onListLayout: (height: number) => void
  onListScroll: (offset: number) => void
}

export function useRowDrag({ anchors, armEnabled, entryCount, onAutoScroll, onCommit }: RowDragOptions): RowDrag {
  const [draggingName, setDraggingName] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)

  const translateY = useRef(new Animated.Value(0)).current
  const boxes = useRef<Record<string, RowBox>>({})
  const measurers = useRef<Record<string, (event: { nativeEvent: { layout: RowBox } }) => void>>({})
  const rowResponders = useRef<Record<string, PanResponderInstance>>({})
  const handleResponders = useRef<Record<string, PanResponderInstance>>({})

  // Everything the responders read has to be a ref: a PanResponder is built once
  // per row and would otherwise close over the first render's values for good.
  const armed = useRef<string | null>(null)
  const active = useRef<string | null>(null)
  const startY = useRef(0)
  const slot = useRef<number | null>(null)
  const listHeight = useRef(0)
  const listOffset = useRef(0)
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const latest = useRef({ anchors, entryCount, onAutoScroll, onCommit })

  latest.current = { anchors, entryCount, onAutoScroll, onCommit }

  const stopEdgeScroll = useCallback(() => {
    if (edgeTimer.current) {
      clearInterval(edgeTimer.current)
      edgeTimer.current = null
    }
  }, [])

  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  /**
   * Where the finger is, in the CONTENT's coordinates.
   *
   * `moveY` is on the screen and the boxes were measured in the content, so the
   * scroll offset is the difference. The list's own top is not subtracted: it
   * cancels out because both numbers are compared against each other and not
   * against the window.
   */
  const pointerContentY = (moveY: number, listTop: number): number => moveY - listTop + listOffset.current

  const finish = useCallback(
    (commit: boolean) => {
      const name = active.current
      const target = slot.current

      stopEdgeScroll()
      active.current = null
      armed.current = null
      slot.current = null
      translateY.setValue(0)
      setDraggingName(null)
      setDropKey(null)

      if (commit && name && target !== null) {
        latest.current.onCommit(name, dropEntryIndex(latest.current.anchors, target, latest.current.entryCount))
      }
    },
    [stopEdgeScroll, translateY]
  )

  const begin = useCallback(
    (botName: string, pageY: number) => {
      active.current = botName
      startY.current = pageY
      translateY.setValue(0)
      setDraggingName(botName)
    },
    [translateY]
  )

  /**
   * One move, and the two things it decides: where the row is drawn and where it
   * would land. The drop line is React state because it changes a few times per
   * drag; the translation is not, because it changes every frame.
   */
  const track = useCallback(
    (moveY: number, dy: number, listTop: number) => {
      translateY.setValue(dy)

      const next = dropSlot(latest.current.anchors, boxes.current, pointerContentY(moveY, listTop))

      if (next !== slot.current) {
        slot.current = next
        setDropKey(latest.current.anchors[next]?.key ?? null)
      }

      // The edge bands are measured against the list, not the window, so a sidebar
      // inset does not shift them.
      const withinTop = moveY - listTop < EDGE_BAND
      const withinBottom = listTop + listHeight.current - moveY < EDGE_BAND

      if (!withinTop && !withinBottom) {
        stopEdgeScroll()

        return
      }

      if (edgeTimer.current) {
        return
      }

      const step = withinTop ? -EDGE_STEP : EDGE_STEP

      edgeTimer.current = setInterval(() => latest.current.onAutoScroll(step), EDGE_INTERVAL_MS)
    },
    [stopEdgeScroll, translateY]
  )

  const buildResponder = useCallback(
    (botName: string, immediate: boolean): PanResponderInstance => {
      // The list's own top on screen, captured at grant: a drag cannot resize the
      // window, so reading it once per gesture is enough and it saves a measure
      // per frame.
      let listTop = 0

      return PanResponder.create({
        // A handle claims the touch outright; a row waits to be armed, so an
        // ordinary tap still reaches the `Pressable` underneath it.
        onStartShouldSetPanResponder: () => immediate,
        onStartShouldSetPanResponderCapture: () => immediate,
        onMoveShouldSetPanResponder: () => immediate || armed.current === botName,
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          armed.current === botName && Math.abs(gesture.dy) > MOVE_SLOP,

        onPanResponderGrant: (event, gesture) => {
          listTop = event.nativeEvent.pageY - event.nativeEvent.locationY - (boxes.current[`bot:${botName}`]?.y ?? 0)
          listTop += listOffset.current
          begin(botName, gesture.y0)
        },

        onPanResponderMove: (_event, gesture) => {
          if (active.current !== botName) {
            return
          }

          track(gesture.moveY, gesture.dy, listTop)
        },

        // While dragging, nothing else may take the gesture — least of all the
        // scroll view, which would leave a lifted row following nothing.
        onPanResponderTerminationRequest: () => active.current !== botName,
        onShouldBlockNativeResponder: () => active.current === botName,

        onPanResponderRelease: () => finish(true),
        onPanResponderTerminate: () => finish(false)
      })
    },
    [begin, finish, track]
  )

  const rowHandlers = useCallback(
    (botName: string) => {
      const existing = rowResponders.current[botName]

      if (existing) {
        return existing.panHandlers
      }

      const responder = buildResponder(botName, false)

      rowResponders.current[botName] = responder

      return responder.panHandlers
    },
    [buildResponder]
  )

  const handleHandlers = useCallback(
    (botName: string) => {
      const existing = handleResponders.current[botName]

      if (existing) {
        return existing.panHandlers
      }

      const responder = buildResponder(botName, true)

      handleResponders.current[botName] = responder

      return responder.panHandlers
    },
    [buildResponder]
  )

  const measure = useCallback((key: string) => {
    const existing = measurers.current[key]

    if (existing) {
      return existing
    }

    const handler = (event: { nativeEvent: { layout: RowBox } }): void => {
      boxes.current[key] = { height: event.nativeEvent.layout.height, y: event.nativeEvent.layout.y }
    }

    measurers.current[key] = handler

    return handler
  }, [])

  const arm = useCallback(
    (botName: string) => {
      if (!armEnabled) {
        return
      }

      armed.current = botName
      // The only haptic in the list, and it is the one the gesture needs: a lift
      // that says nothing is a lift nobody trusts they have started.
      haptic('choice')
    },
    [armEnabled]
  )

  const disarm = useCallback(() => {
    if (!active.current) {
      armed.current = null
    }
  }, [])

  return useMemo(
    () => ({
      arm,
      disarm,
      draggingName,
      dropKey,
      handleHandlers,
      measure,
      onListLayout: (height: number) => {
        listHeight.current = height
      },
      onListScroll: (offset: number) => {
        listOffset.current = offset
      },
      rowHandlers,
      translateY
    }),
    [arm, disarm, draggingName, dropKey, handleHandlers, measure, rowHandlers, translateY]
  )
}
