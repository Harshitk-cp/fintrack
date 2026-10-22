import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import { useEffect, type ComponentRef, type Ref } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PixelIcon, type PixelIconName } from "@/components/pixel-icon";
import { Text } from "@/components/text";
import { Badge } from "@/components/ui";
import { useBadges } from "@/lib/badges";
import { FONT, RADIUS, TAB_BAR_HEIGHT, tabBarBottom, useTheme } from "@/lib/theme";

/** A floating Oxford pill with pixel icons; an Orange disc springs onto the active tab. */
export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { review } = useBadges();
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
          <TabButton icon="sliders" label="Settings" />
        </TabTrigger>
      </TabList>
    </Tabs>
  );
}

type TabButtonProps = TabTriggerSlotProps & { icon: PixelIconName; label: string; badge?: number };

function TabButton({ icon, label, badge, isFocused, ref, ...props }: TabButtonProps) {
  const t = useTheme();
  const on = useSharedValue(isFocused ? 1 : 0);
  useEffect(() => {
    on.set(withSpring(isFocused ? 1 : 0, { damping: 14, stiffness: 220 }));
  }, [isFocused, on]);
  const disc = useAnimatedStyle(() => ({ opacity: on.get(), transform: [{ scale: interpolate(on.get(), [0, 1], [0.4, 1]) }] }));

  return (
    // expo-router types this ref for a different View flavour than RN 0.88's Pressable; it is the same element.
    <Pressable ref={ref as unknown as Ref<ComponentRef<typeof Pressable>>} {...props} style={styles.tab} accessibilityRole="tab" accessibilityLabel={badge ? `${label}, ${badge} to review` : label} accessibilityState={{ selected: !!isFocused }}>
      <View style={styles.iconWrap}>
        <Animated.View style={[styles.disc, { backgroundColor: t.accent }, disc]} />
        <PixelIcon name={icon} size={22} color={isFocused ? t.onAccent : t.onInk} />
        {!!badge && <Badge count={badge} style={styles.badge} />}
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
});
