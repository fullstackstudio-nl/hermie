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
 *
 * ## What makes it feel like the platform's own, rather than a row that moves
 *
 * Three things, and none of them is the translation:
 *
 *  - **The lift is animated, not applied.** `lift` springs 0 → 1 on the grant and
 *    back on release, and the scale and the shadow are interpolated off it. A row
 *    that snaps to 1.02 has not been picked up, it has changed size.
 *  - **The other rows move aside** (`offsetFor`), which is what a native list does
 *    instead of drawing a line: the gap under the finger IS the answer to "where
 *    would this land". `rowShift` decides, and only the rows between the lifted
 *    row's own place and that gap ever move.
 *  - **The drop settles.** The lifted row springs from wherever the finger left it
 *    to the middle of the gap it is over, and the commit happens when that
 *    animation finishes — so the arrangement changes under a row that is already
 *    where the new arrangement puts it, and nothing jumps.
 *
 * All three collapse to zero under Reduce Motion, through the same code path: the
 * springs become `Animated.timing` at duration 0, so every completion callback —
 * including the one that commits the drop — still runs exactly where it did.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, type PanResponderInstance } from 'react-native'

import { haptic } from '../../platform/haptics'
import { spring as springToken } from '../../ui/motion'
import { dropEntryIndex, dropSlot, rowShift, type DragAnchor, type RowBox } from './drag-order'

/** Beyond this, a press has become a drag. Below it, a finger is merely resting. */
const MOVE_SLOP = 6

/** How close to an edge starts the list scrolling under the dragged row. */
const EDGE_BAND = 72

/** Points per tick, sixty times a second. Slow enough to aim, fast enough to arrive. */
const EDGE_STEP = 6

const EDGE_INTERVAL_MS = 16

/** How much bigger a lifted row is. Enough to read as "off the page", not enough to crop. */
export const LIFT_SCALE = 1.03

/**
 * One animation, or none.
 *
 * Reduce Motion gets a zero-length `timing` rather than a `setValue`, for the
 * reason `motion.ts` gives about `durationFor`: a skipped animation is a skipped
 * completion callback, and one of the callbacks here is what commits the drop.
 */
function settle(value: Animated.Value, toValue: number, reduceMotion: boolean): Animated.CompositeAnimation {
  return reduceMotion
    ? Animated.timing(value, { duration: 0, toValue, useNativeDriver: true })
    : Animated.spring(value, { ...springToken.settle, toValue, useNativeDriver: true })
}

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
  /** Every duration collapses to zero. Read from the theme by the caller. */
  reduceMotion: boolean
}

export interface RowDrag {
  /** The row being dragged, or null. */
  draggingName: string | null
  /** Translation for the lifted row. Stable, and driven natively. */
  translateY: Animated.Value
  /**
   * 0 resting, 1 fully lifted. The scale and the shadow read off this, so a row
   * that is being put down is drawn mid-way rather than either/or.
   */
  lift: Animated.Value
  /** How far this row has moved aside, by anchor key. Zero for a row that has not. */
  offsetFor: (key: string) => Animated.Value
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

export function useRowDrag({
  anchors,
  armEnabled,
  entryCount,
  onAutoScroll,
  onCommit,
  reduceMotion
}: RowDragOptions): RowDrag {
  const [draggingName, setDraggingName] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)

  const translateY = useRef(new Animated.Value(0)).current
  const lift = useRef(new Animated.Value(0)).current
  const offsets = useRef<Record<string, Animated.Value>>({})
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
  /** The lifted row's own anchor index, captured at the grant. */
  const origin = useRef(0)
  const listHeight = useRef(0)
  const listOffset = useRef(0)
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const latest = useRef({ anchors, entryCount, onAutoScroll, onCommit, reduceMotion })

  latest.current = { anchors, entryCount, onAutoScroll, onCommit, reduceMotion }

  /**
   * One value per anchor, created on demand and kept for the life of the screen.
   *
   * Kept rather than cleaned up: a chat list is tens of rows, an `Animated.Value`
   * is two numbers, and a map that is pruned while a drag is in flight is a map
   * that can drop the value a running animation is writing to.
   */
  const offsetFor = useCallback((key: string): Animated.Value => {
    const existing = offsets.current[key]

    if (existing) {
      return existing
    }

    const value = new Animated.Value(0)

    offsets.current[key] = value

    return value
  }, [])

  /**
   * Move every row that has to be out of the way, and put back every row that
   * does not.
   *
   * A row's height is its OWN, not an assumed constant: a divider is shorter than
   * a chat row and a compact row is shorter than a regular one, so shifting by a
   * fixed number would leave a gap the wrong size under the finger. The height
   * that opens or closes is the LIFTED row's, because that is what is going into
   * or out of the gap.
   */
  const shiftRows = useCallback(
    (from: number, slot: number | null) => {
      const { anchors: list, reduceMotion: reduce } = latest.current
      const height = boxes.current[list[from]?.key ?? '']?.height ?? 0

      list.forEach((anchor, index) => {
        const shift = slot === null ? 0 : rowShift(index, from, slot)

        settle(offsetFor(anchor.key), shift * height, reduce).start()
      })
    },
    [offsetFor]
  )

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

  /**
   * Let go.
   *
   * The row does not disappear from under the finger and reappear in its new
   * place: it SPRINGS to the resting offset the gap has already opened for it,
   * and the arrangement changes on that animation's completion. By then the row
   * is drawn exactly where the new arrangement puts it, so the re-render that
   * follows moves nothing — which is the difference between a drop and a jump.
   *
   * `resting` is how far the lifted row has to travel from its ORIGINAL place to
   * the gap, which is one row height per row it passed. It is computed from the
   * same `rowShift` the other rows used, so the two cannot disagree about where
   * the gap is.
   */
  const finish = useCallback(
    (commit: boolean) => {
      const name = active.current
      const target = slot.current
      const from = origin.current
      const { anchors: list, entryCount: count, onCommit: commitTo, reduceMotion: reduce } = latest.current

      stopEdgeScroll()
      active.current = null
      armed.current = null
      slot.current = null
      origin.current = 0

      const done = () => {
        translateY.setValue(0)
        for (const value of Object.values(offsets.current)) {
          value.setValue(0)
        }
        setDraggingName(null)
        setDropKey(null)

        if (commit && name && target !== null) {
          commitTo(name, dropEntryIndex(list, target, count))
        }
      }

      if (!commit || !name || target === null) {
        Animated.parallel([settle(translateY, 0, reduce), settle(lift, 0, reduce)]).start(done)
        shiftRows(from, null)

        return
      }

      const height = boxes.current[list[from]?.key ?? '']?.height ?? 0
      const passed = list.reduce((total, _anchor, index) => total - rowShift(index, from, target), 0)

      Animated.parallel([settle(translateY, passed * height, reduce), settle(lift, 0, reduce)]).start(done)
    },
    [lift, shiftRows, stopEdgeScroll, translateY]
  )

  const begin = useCallback(
    (botName: string, pageY: number) => {
      active.current = botName
      origin.current = Math.max(
        0,
        latest.current.anchors.findIndex(anchor => anchor.key === `bot:${botName}`)
      )
      startY.current = pageY
      translateY.setValue(0)
      setDraggingName(botName)
      settle(lift, 1, latest.current.reduceMotion).start()
    },
    [lift, translateY]
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
        const first = slot.current === null

        slot.current = next
        setDropKey(latest.current.anchors[next]?.key ?? null)
        shiftRows(origin.current, next)

        // The list has changed shape under the finger, which is what says the drop
        // would land here. Not on the FIRST slot of a gesture: that one is the row's
        // own place, nothing moves for it, and the lift's tap has just fired.
        if (!first) {
          haptic('choice')
        }
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
    [shiftRows, stopEdgeScroll, translateY]
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
      lift,
      measure,
      offsetFor,
      onListLayout: (height: number) => {
        listHeight.current = height
      },
      onListScroll: (offset: number) => {
        listOffset.current = offset
      },
      rowHandlers,
      translateY
    }),
    [arm, disarm, draggingName, dropKey, handleHandlers, lift, measure, offsetFor, rowHandlers, translateY]
  )
}
