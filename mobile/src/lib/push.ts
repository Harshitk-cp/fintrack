// Android system notifications through Firebase Cloud Messaging. (iPhones use
// ntfy: native iOS push needs a paid Apple developer account.)
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { registerFcmToken, type Session } from "./api";

// Same ids the server sends to (src/fcm.ts). Names are what Android shows in the app's notification settings.
const CHANNELS = [
  { id: "payments", name: "Payments", description: "A payment above your alert amount", importance: AndroidImportance.HIGH },
  { id: "review", name: "Needs your input", description: "Payments Fintrack couldn't work out", importance: AndroidImportance.HIGH },
  { id: "budget", name: "Budget", description: "Close to or over your monthly budget", importance: AndroidImportance.HIGH },
  { id: "summary", name: "Daily summary", description: "Today's spending, once a day", importance: AndroidImportance.DEFAULT },
] as const;

// Shown even while the app is open (FCM hands foreground messages to the app instead of the tray).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** on: registered; denied: the user blocked notifications; unregistered: allowed, but the server didn't take the token. */
export type AndroidPushState = "unsupported" | "denied" | "on" | "unregistered";

/**
 * Creates the channels, asks for permission (Android 13+ shows the prompt only
 * once a channel exists) and registers this phone's FCM token with the server.
 */
export async function enableAndroidPush(session: Session): Promise<AndroidPushState> {
  if (Platform.OS !== "android") return "unsupported";
  for (const c of CHANNELS) {
    await Notifications.setNotificationChannelAsync(c.id, {
      name: c.name, description: c.description, importance: c.importance, lightColor: "#FF8400", vibrationPattern: [0, 180, 120, 180],
    });
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return "denied";
  const { data } = await Notifications.getDevicePushTokenAsync();
  if (__DEV__) console.log(`[push] fcm token ${String(data).slice(0, 12)}…`);
  return registerFcmToken(session, String(data)).then(() => "on" as const, () => "unregistered" as const);
}

/** Registers on sign-in / launch, keeps the token current, and opens the screen a tapped notification is about. */
export function usePush(session: Session | null) {
  useEffect(() => {
    if (!session || Platform.OS !== "android") return;
    void enableAndroidPush(session).catch(() => {});
    // Firebase can rotate the token; send the new one.
    const sub = Notifications.addPushTokenListener((t) => void registerFcmToken(session, String(t.data)).catch(() => {}));
    return () => sub.remove();
  }, [session]);

  useEffect(() => {
    const open = (r: Notifications.NotificationResponse | null) => {
      const url = r?.notification.request.content.data?.url;
      if (typeof url !== "string" || !url.startsWith("fintrack://")) return;
      router.push(`/${url.slice("fintrack://".length)}` as never);
      Notifications.clearLastNotificationResponse();
    };
    // A tap that launched the app from scratch, then taps while it's running.
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, []);
}
