import { ChakraPetch_400Regular, ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold } from "@expo-google-fonts/chakra-petch";
import { Silkscreen_400Regular, Silkscreen_700Bold } from "@expo-google-fonts/silkscreen";
import { Unbounded_600SemiBold, Unbounded_800ExtraBold } from "@expo-google-fonts/unbounded";
import { useFonts } from "expo-font";
import { DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { CyberBackground } from "@/components/cyber";
import { BadgesProvider } from "@/lib/badges";
import { LockGate } from "@/lib/lock";
import { SessionProvider, useSession } from "@/lib/session";
import { PALETTE, useStackOptions, useTheme } from "@/lib/theme";

// Navigation chrome in the app palette; a transparent background lets CyberBackground show through every screen.
function useNavTheme() {
  const t = useTheme();
  return { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: t.accent, background: "transparent", card: t.bg, text: t.text, border: t.border, notification: t.accent } };
}

function RootStack() {
  const { session, loading } = useSession();
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
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ title: "Sign in", headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function Layout() {
  const [fontsLoaded] = useFonts({
    Silkscreen_400Regular, Silkscreen_700Bold,
    ChakraPetch_400Regular, ChakraPetch_500Medium, ChakraPetch_600SemiBold, ChakraPetch_700Bold,
    Unbounded_600SemiBold, Unbounded_800ExtraBold,
  });
  const navTheme = useNavTheme();
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: PALETTE.amande }} />;

  return (
    <View style={{ flex: 1, backgroundColor: PALETTE.amande }}>
      <CyberBackground />
      <ThemeProvider value={navTheme}>
        <SessionProvider>
          <BadgesProvider>
            <StatusBar style="dark" />
            <LockGate>
              <RootStack />
            </LockGate>
          </BadgesProvider>
        </SessionProvider>
      </ThemeProvider>
    </View>
  );
}
