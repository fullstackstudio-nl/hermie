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
            <Text color="textMuted" variant="caption">
              {hint}
            </Text>
          ) : null}
        </View>

        <View
          style={{
            backgroundColor: value ? theme.colors.switchGreen : theme.colors.textMuted,
            borderRadius: 16,
            height: 31,
            justifyContent: 'center',
            padding: 3,
            width: 51
          }}
        >
          <Animated.View
            style={{
              backgroundColor: '#FFFFFF',
              borderRadius: 13,
              height: 25,
              transform: [{ translateX: knob.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }],
              width: 25
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
        <Text color="textMuted" variant="caption">
          {label}
        </Text>
      ) : null}

      <View
        accessibilityRole="radiogroup"
        style={{
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: 10,
          flexDirection: 'row',
          padding: 3
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
                  backgroundColor: selected ? theme.colors.surface : 'transparent',
                  borderRadius: 8,
                  paddingVertical: theme.space.sm
                }}
              >
                <Text color={selected ? 'accent' : 'text'} style={{ fontWeight: selected ? '700' : '400' }}>
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
            backgroundColor: pressed ? theme.colors.surfaceRaised : 'transparent',
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
