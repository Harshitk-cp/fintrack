import { NativeTabs } from "expo-router/native-tabs";
import { useBadges } from "@/lib/badges";
import { useTheme } from "@/lib/theme";

export default function TabsLayout() {
  const t = useTheme();
  const { review } = useBadges();
  return (
    <NativeTabs tintColor={t.accent}>
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="review">
        <NativeTabs.Trigger.Icon sf={{ default: "questionmark.circle", selected: "questionmark.circle.fill" }} md="help" />
        <NativeTabs.Trigger.Label>Review</NativeTabs.Trigger.Label>
        {review > 0 && <NativeTabs.Trigger.Badge>{String(review)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ask">
        <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
        <NativeTabs.Trigger.Label>Ask</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
