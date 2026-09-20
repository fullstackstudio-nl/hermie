import * as Haptics from 'expo-haptics'

import type { HapticMoment } from './platform-contracts'

export type { HapticMoment } from './platform-contracts'

/**
 * Fire one, and never fail because of it.
 *
 * The call is fire-and-forget on purpose: the Taptic engine is unavailable on
 * a simulator, switched off in system settings, and absent on some Android
 * builds, and none of those is a reason for a message not to send.
 */
export function haptic(moment: HapticMoment): void {
  try {
    if (moment === 'send') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)

      return
    }

    if (moment === 'choice') {
      void Haptics.selectionAsync().catch(() => undefined)

      return
    }

    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
  } catch {
    // A module that is present but has no native side throws synchronously.
  }
}
