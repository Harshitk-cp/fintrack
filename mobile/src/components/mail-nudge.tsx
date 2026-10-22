import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useBadges } from "@/lib/badges";
import { FONT, MOTION, RADIUS, useTheme } from "@/lib/theme";
import { CyberButton } from "./cyber";
import { PixelIcon } from "./pixel-icon";
import { Text } from "./text";
import { Card } from "./ui";

/**
 * Home banner asking to connect a mailbox. Dismissing it tells the server, which
 * brings it back after a day, then after a week, then never.
 */
export function MailNudge() {
  const t = useTheme();
  const { mailNudge, dismissMailNudge } = useBadges();
  if (!mailNudge) return null;
  return (
    <Animated.View entering={FadeIn.duration(MOTION.slow).easing(MOTION.ease)} exiting={FadeOut.duration(MOTION.base).easing(MOTION.ease)} style={styles.wrap}>
      <Card style={styles.card}>
        <View style={styles.top}>
          <View style={[styles.tile, { backgroundColor: t.accent }]}>
            <PixelIcon name="mail" size={22} color={t.onAccent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: t.text }]}>CONNECT BANK EMAILS</Text>
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 19, marginTop: 4 }}>
              Banks email most payments too. Connecting your inbox catches the ones whose SMS never arrived.
            </Text>
          </View>
          <Pressable onPress={dismissMailNudge} hitSlop={12} accessibilityRole="button" accessibilityLabel="Not now" style={styles.close}>
            <PixelIcon name="close" size={18} color={t.muted} />
          </Pressable>
        </View>
        <CyberButton title="Connect" kind="solid" onPress={() => router.navigate("/settings")} />
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginTop: 12 },
  card: { gap: 14 },
  top: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  tile: { width: 42, height: 42, borderRadius: RADIUS.tile, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: FONT.pixel, fontSize: 11, letterSpacing: 1.5, marginTop: 2 },
  close: { padding: 2 },
});
