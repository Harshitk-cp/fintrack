import * as Haptics from "expo-haptics";

// Small, consistent taps. Each is fire-and-forget: a device without a haptic
// engine (or with system haptics turned off) just does nothing.
const quiet = (p: Promise<void>) => void p.catch(() => {});

export const haptic = {
  /** A button or card pressed. */
  tap: () => quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A firmer press: toggles that change what's on screen, like hiding amounts. */
  press: () => quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Picking one option among several: chips, PIN keys, calendar days. */
  select: () => quiet(Haptics.selectionAsync()),
  success: () => quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
