import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import Animated, { SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { alpha, MOTION, PALETTE, RADIUS, useTheme } from "@/lib/theme";

/** A bottom sheet in the app's paper colour. Tapping outside closes it. */
export function Sheet({ visible, onClose, children, height }: { visible: boolean; onClose: () => void; children: ReactNode; height?: number | `${number}%` }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.fill}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: alpha(PALETTE.oxford, 0.45) }]} onPress={onClose} accessibilityLabel="Close" />
        <Animated.View
          entering={SlideInDown.duration(MOTION.base).easing(MOTION.ease)}
          style={[styles.panel, { backgroundColor: t.bg, paddingBottom: Math.max(insets.bottom, 16), height }]}
        >
          <View style={[styles.handle, { backgroundColor: alpha(PALETTE.oxford, 0.2) }]} />
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "flex-end" },
  panel: { borderTopLeftRadius: RADIUS.card + 4, borderTopRightRadius: RADIUS.card + 4, paddingTop: 10, maxHeight: "92%" },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 6 },
});
