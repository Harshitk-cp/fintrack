import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import { useEffect, type ComponentRef, type Ref } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PixelIcon, type PixelIconName } from "@/components/pixel-icon";
import { Text } from "@/components/text";
import { Badge } from "@/components/ui";
import { useBadges } from "@/lib/badges";
import { FONT, MOTION, RADIUS, TAB_BAR_HEIGHT, tabBarBottom, useTheme } from "@/lib/theme";

/** A floating Oxford pill with pixel icons; an Orange disc fades in behind the active tab. */
export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { review, mailPending } = useBadges();
  return (
    <Tabs>
      <TabSlot />
      <TabList style={[styles.bar, { bottom: tabBarBottom(insets.bottom), height: TAB_BAR_HEIGHT, backgroundColor: t.ink }]}>
        <TabTrigger name="(home)" href="/" asChild>
          <TabButton icon="home" label="Home" />
        </TabTrigger>
        <TabTrigger name="review" href="/review" asChild>
          <TabButton icon="warning-diamond" label="Review" badge={review} />
        </TabTrigger>
        <TabTrigger name="ask" href="/ask" asChild>
          <TabButton icon="sparkles" label="Ask" />
        </TabTrigger>
        <TabTrigger name="settings" href="/settings" asChild>
          <TabButton icon="sliders" label="Settings" dot={mailPending} />
        </TabTrigger>
      </TabList>
    </Tabs>
  );
}

type TabButtonProps = TabTriggerSlotProps & { icon: PixelIconName; label: string; badge?: number; /** A setup task is pending in this tab. */ dot?: boolean };

function TabButton({ icon, label, badge, dot, isFocused, ref, ...props }: TabButtonProps) {
  const t = useTheme();
  const on = useSharedValue(isFocused ? 1 : 0);
  useEffect(() => {
    on.set(withTiming(isFocused ? 1 : 0, { duration: MOTION.base, easing: MOTION.ease }));
  }, [isFocused, on]);
  const disc = useAnimatedStyle(() => ({ opacity: on.get(), transform: [{ scale: interpolate(on.get(), [0, 1], [0.8, 1]) }] }));

  return (
    // expo-router types this ref for a different View flavour than RN 0.88's Pressable; it is the same element.
    <Pressable ref={ref as unknown as Ref<ComponentRef<typeof Pressable>>} {...props} style={styles.tab} accessibilityRole="tab" accessibilityLabel={badge ? `${label}, ${badge} to review` : dot ? `${label}, setup pending` : label} accessibilityState={{ selected: !!isFocused }}>
      <View style={styles.iconWrap}>
        <Animated.View style={[styles.disc, { backgroundColor: t.accent }, disc]} />
        <PixelIcon name={icon} size={22} color={isFocused ? t.onAccent : t.onInk} />
        {!!badge && <Badge count={badge} style={styles.badge} />}
        {!badge && dot && <View style={[styles.dot, { backgroundColor: t.accent, borderColor: t.ink }]} accessibilityLabel="Setup pending" />}
      </View>
      <Text style={[styles.label, { color: isFocused ? t.onInk : t.inkMuted }]}>{label.toUpperCase()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 20, right: 20, flexDirection: "row", borderRadius: RADIUS.pill, paddingHorizontal: 8, alignItems: "center" },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  iconWrap: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  disc: { ...StyleSheet.absoluteFill, borderRadius: 22 },
  label: { fontFamily: FONT.pixel, fontSize: 8, letterSpacing: 1 },
  badge: { position: "absolute", top: 0, right: -2 },
  dot: { position: "absolute", top: 4, right: 4, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
});
