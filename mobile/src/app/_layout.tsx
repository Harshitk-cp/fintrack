import { ChakraPetch_400Regular, ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold } from "@expo-google-fonts/chakra-petch";
import { Silkscreen_400Regular, Silkscreen_700Bold } from "@expo-google-fonts/silkscreen";
import { Unbounded_600SemiBold, Unbounded_800ExtraBold } from "@expo-google-fonts/unbounded";
import { useFonts } from "expo-font";
import { DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { CyberBackground } from "@/components/cyber";
import { Splash } from "@/components/splash";
import { BadgesProvider } from "@/lib/badges";
import { LockGate } from "@/lib/lock";
import { usePush } from "@/lib/push";
import { SessionProvider, useSession } from "@/lib/session";
import { useStackOptions, useTheme } from "@/lib/theme";

// Navigation chrome in the app palette; a transparent background lets CyberBackground show through every screen.
function useNavTheme() {
  const t = useTheme();
  return { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: t.accent, background: "transparent", card: t.bg, text: t.text, border: t.border, notification: t.accent } };
}

function RootStack() {
  const { session, loading } = useSession();
  usePush(session); // Android: register for notifications; both: open the screen a tapped notification is about
  const stackOptions = useStackOptions();
  const theme = useTheme();
  if (loading) return null;

  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="transaction/[id]" options={{ title: "Transaction" }} />
        <Stack.Screen name="add" options={{ title: "Add", presentation: "modal", contentStyle: { backgroundColor: theme.bg } }} />
        <Stack.Screen name="inbox" options={{ title: "Inbox" }} />
        <Stack.Screen name="transactions" options={{ title: "All transactions" }} />
        <Stack.Screen name="insights" options={{ title: "Insights" }} />
        <Stack.Screen name="sip" options={{ title: "SIP", presentation: "modal", contentStyle: { backgroundColor: theme.bg } }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ title: "Sign in", headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

// Keep the native launch screen (plain page colour) up until the animated splash has drawn.
SplashScreen.preventAutoHideAsync().catch(() => {});

const SPLASH_MIN_MS = 2600;

export default function Layout() {
  const [fontsLoaded] = useFonts({
    Silkscreen_400Regular, Silkscreen_700Bold,
    ChakraPetch_400Regular, ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold,
    Unbounded_600SemiBold, Unbounded_800ExtraBold,
  });
  const navTheme = useNavTheme();
  const t = useTheme();
  // show: tree only. leaving: the app is mounted underneath and the splash fades out. done: splash gone.
  const [splash, setSplash] = useState<"show" | "leaving" | "done">("show");
  const [minElapsed, setMinElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(timer);
  }, []);
  const ready = fontsLoaded && minElapsed;
  if (ready && splash === "show") setSplash("leaving");
  const gone = useCallback(() => setSplash("done"), []);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <CyberBackground />
      {splash !== "show" && (
        <ThemeProvider value={navTheme}>
          <SessionProvider>
            <BadgesProvider>
              <LockGate>
                <RootStack />
              </LockGate>
            </BadgesProvider>
          </SessionProvider>
        </ThemeProvider>
      )}
      <StatusBar style="dark" />
      {splash !== "done" && <Splash leaving={splash === "leaving"} ready={fontsLoaded} onGone={gone} onShown={() => SplashScreen.hide()} />}
    </View>
  );
}
