import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PixelIcon } from "@/components/pixel-icon";
import { Text } from "@/components/text";
import { ledgerChanged } from "./events";
import { haptic } from "./haptics";
import { FONT, MOTION, RADIUS, tabBarTop, useTheme } from "./theme";

interface ToastOptions {
  message: string;
  /** Shows an Undo button; runs when it's tapped. */
  undo?: () => unknown;
  /** How long it stays, in ms. Long enough to read and change your mind. */
  duration?: number;
}

const Ctx = createContext<(t: ToastOptions) => void>(() => {});

/** Brief confirmations at the bottom of the screen, most with an Undo. One at a time; a new one replaces the last. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<(ToastOptions & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const show = useCallback((o: ToastOptions) => {
    if (timer.current) clearTimeout(timer.current);
    const id = ++seq.current;
    setToast({ ...o, id });
    timer.current = setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), o.duration ?? (o.undo ? 8000 : 3200));
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && (
        <Animated.View
          key={toast.id}
          entering={FadeInDown.duration(MOTION.base).easing(MOTION.ease)}
          exiting={FadeOutDown.duration(MOTION.fast).easing(MOTION.ease)}
          style={[styles.wrap, { bottom: tabBarTop(insets.bottom) + 12 }]}
          pointerEvents="box-none"
        >
          <View style={[styles.toast, { backgroundColor: t.ink }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
            <Text style={[styles.message, { color: t.onInk }]} numberOfLines={2}>
              {toast.message}
            </Text>
            {toast.undo && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Undo"
                hitSlop={10}
                onPress={() => {
                  haptic.tap();
                  const undo = toast.undo!;
                  setToast(null);
                  // Screens showing the changed data fetch it again once the undo lands.
                  void Promise.resolve(undo()).finally(ledgerChanged);
                }}
                style={({ pressed }) => [styles.undo, { backgroundColor: t.accent, opacity: pressed ? 0.8 : 1 }]}
              >
                <PixelIcon name="undo" size={16} color={t.onAccent} />
                <Text style={[styles.undoText, { color: t.onAccent }]}>UNDO</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      )}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  toast: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: RADIUS.pill, paddingLeft: 20, paddingRight: 6, paddingVertical: 6, minHeight: 52, maxWidth: 520, width: "100%" },
  message: { flex: 1, fontSize: 14, fontFamily: FONT.medium, paddingVertical: 8 },
  undo: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: RADIUS.pill, paddingHorizontal: 14, height: 40 },
  undoText: { fontFamily: FONT.pixel, fontSize: 11, letterSpacing: 1.2 },
});
