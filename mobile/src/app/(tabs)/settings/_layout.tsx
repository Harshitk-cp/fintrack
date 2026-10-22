import { Stack } from "expo-router";
import { useStackOptions } from "@/lib/theme";

export default function Layout() {
  return (
    <Stack screenOptions={useStackOptions()}>
      <Stack.Screen name="index" options={{ title: "Settings" }} />
    </Stack>
  );
}
