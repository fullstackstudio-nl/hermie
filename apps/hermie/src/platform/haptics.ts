import * as Haptics from 'expo-haptics'

/**
 * The three moments a chat is allowed to buzz.
 *
 * Deliberately a closed set rather than a pass-through of the Expo API. Haptics
 * read as punctuation: one on committing a message, one on committing an answer
 * to a question the agent asked, one when a reply lands. Anything more and the
 * phone is vibrating at the user for things they did not do.
 */
export type HapticMoment = 'send' | 'choice' | 'complete'

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
