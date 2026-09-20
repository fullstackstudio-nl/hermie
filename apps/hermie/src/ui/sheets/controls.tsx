/**
 * The grouped-row controls a settings sheet needs: a switch, a segmented
 * control and a disclosure row.
 *
 * They are built from `Pressable` and `Animated` rather than from the platform
 * `Switch`/`SegmentedControl`, for the same reason the bottom sheet is: iOS and
 * Android do not share one set of those, and a control that looks different on
 * each would undo the point of having tokens.
 */
import { useEffect, useRef } from 'react'
import { Animated, Pressable, View } from 'react-native'

import { Text } from '../primitives'
import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'

/**
 * §3's `.sw`: a 51 × 31 track and a 27pt knob sitting 2pt inside it.
 *
 * `inset` is 1 rather than 2 because the hairline is a real 1pt BORDER here and
 * the mockup's is an inset box-shadow, which costs no layout. Border plus
 * padding is the 2pt the mockup insets by, which is what keeps the travel at 20.
 */
const SWITCH = { width: 51, track: 31, knob: 27, inset: 1, travel: 20 } as const

export interface SwitchRowProps {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  testID?: string
}

export function SwitchRow({ label, hint, value, onChange, disabled = false, testID }: SwitchRowProps) {
  const theme = useTheme()
  const knob = useRef(new Animated.Value(value ? 1 : 0)).current

  useEffect(() => {
    Animated.timing(knob, { duration: 140, toValue: value ? 1 : 0, useNativeDriver: false }).start()
  }, [knob, value])

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      testID={testID}
    >
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.md,
          minHeight: CONTROL_MIN_HEIGHT,
          opacity: disabled ? 0.4 : 1,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm
        }}
      >
        <View style={{ flex: 1 }}>
          <Text variant="body">{label}</Text>
          {hint ? (
            <Text color="textMuted" variant="meta">
              {hint}
            </Text>
          ) : null}
        </View>

        {/*
          Off is the SUNK tint with a hairline, not a grey fill (§3's `.sw`). A
          mid-grey track reads as a third state somewhere between on and
          disabled, and on a dark sheet it was the brightest thing in the row.
        */}
        <View
          style={{
            backgroundColor: value ? theme.colors.ok : theme.tintSunk,
            borderColor: value ? 'transparent' : theme.hairlineSoft,
            borderRadius: SWITCH.track / 2,
            borderWidth: 1,
            height: SWITCH.track,
            justifyContent: 'center',
            paddingHorizontal: SWITCH.inset,
            width: SWITCH.width
          }}
        >
          <Animated.View
            style={{
              backgroundColor: '#FFFFFF',
              borderRadius: SWITCH.knob / 2,
              height: SWITCH.knob,
              shadowColor: '#0A1E46',
              shadowOffset: { height: 2, width: 0 },
              shadowOpacity: 0.3,
              shadowRadius: 5,
              transform: [{ translateX: knob.interpolate({ inputRange: [0, 1], outputRange: [0, SWITCH.travel] }) }],
              width: SWITCH.knob
            }}
          />
        </View>
      </View>
    </Pressable>
  )
}

export interface SegmentedRowProps<T extends string> {
  label?: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  testID?: string
}

export function SegmentedRow<T extends string>({ label, options, value, onChange, testID }: SegmentedRowProps<T>) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm, paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm }}>
      {label ? (
        <Text color="textMuted" variant="meta">
          {label}
        </Text>
      ) : null}

      {/*
        §3's `.seg`: a sunk track with a hairline, and the SELECTED segment
        raised onto `e4` — the control rung — with its own hairline and a small
        shadow. The selected label is `text`, not the accent: an accent-coloured
        segment on a raised slab says "link" twice and left the unselected ones
        looking disabled by comparison.
      */}
      <View
        accessibilityRole="radiogroup"
        style={{
          backgroundColor: theme.tintSunk,
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.pill,
          borderWidth: 1,
          flexDirection: 'row',
          gap: 2,
          padding: 2
        }}
        testID={testID}
      >
        {options.map(option => {
          const selected = option.value === value

          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              key={option.value}
              onPress={() => onChange(option.value)}
              style={{ flex: 1 }}
              testID={testID ? `${testID}-${option.value}` : undefined}
            >
              <View
                style={{
                  alignItems: 'center',
                  backgroundColor: selected ? theme.elevation.e4 : 'transparent',
                  borderColor: selected ? theme.hairlineSoft : 'transparent',
                  borderRadius: theme.radii.pill,
                  borderWidth: 1,
                  justifyContent: 'center',
                  minHeight: 30,
                  ...(selected ? theme.shadows.card : {})
                }}
              >
                <Text
                  color={selected ? 'text' : 'textMuted'}
                  numberOfLines={1}
                  style={{ fontSize: 13, fontWeight: '600', lineHeight: 17 }}
                >
                  {option.label}
                </Text>
              </View>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

export interface DisclosureRowProps {
  label: string
  value?: string
  onPress: () => void
  testID?: string
}

export function DisclosureRow({ label, value, onPress, testID }: DisclosureRowProps) {
  const theme = useTheme()

  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID}>
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
            flexDirection: 'row',
            gap: theme.space.sm,
            minHeight: CONTROL_MIN_HEIGHT,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.sm
          }}
        >
          <Text style={{ flex: 1 }}>{label}</Text>
          {value ? (
            <Text color="textMuted" numberOfLines={1} style={{ maxWidth: '55%' }}>
              {value}
            </Text>
          ) : null}
          <Text color="textMuted" style={{ fontSize: 18 }}>
            {'›'}
          </Text>
        </View>
      )}
    </Pressable>
  )
}
