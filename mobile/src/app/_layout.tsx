import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { BadgesProvider } from "@/lib/badges";
import { SessionProvider, useSession } from "@/lib/session";
import { useStackOptions } from "@/lib/theme";

function RootStack() {
  const { session, loading } = useSession();
  const stackOptions = useStackOptions();
  if (loading) return null;

  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="transaction/[id]" options={{ title: "Transaction" }} />
        <Stack.Screen name="add" options={{ title: "Add transaction", presentation: "modal" }} />
        <Stack.Screen name="inbox" options={{ title: "Notifications" }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="pair" options={{ title: "Pair this phone", headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function Layout() {
  return (
    <SessionProvider>
      <BadgesProvider>
        <StatusBar style="auto" />
        <RootStack />
      </BadgesProvider>
    </SessionProvider>
  );
}
