import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { Barcode, CyberBackground, PressScale, Reveal, Wordmark } from "@/components/cyber";
import { Card } from "@/components/ui";
import { PixelIcon } from "@/components/pixel-icon";
import { Text } from "@/components/text";
import { ApiError, verifyPin } from "./api";
import { useSession } from "./session";
import { alpha, FONT, MOTION, PALETTE, useTheme } from "./theme";

/**
 * Locks the app when it starts fresh (a cold launch after it was closed or
 * killed), not when it comes back from the background. Unlock with Face ID /
 * Touch ID / fingerprint, or the account PIN (checked by the server, which also
 * enforces the lockout). While the app is in the background or the app switcher,
 * a cover hides balances without locking.
 */
export function LockGate({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const [covered, setCovered] = useState(false);
  // The token the lock is guarding: the session found in storage at launch. A session
  // created by signing in just now has a different token, so it's never locked and the
  // lock can't flash (or start a fingerprint prompt) right after sign-in.
  const [lockedToken, setLockedToken] = useState<string | null | undefined>(undefined);
  if (!loading && lockedToken === undefined) setLockedToken(session?.token ?? null);
  const locked = !!session && session.token === lockedToken;

  useEffect(() => {
    // Background and "inactive" (iOS app switcher, Control Centre) only hide content; they don't lock.
    const sub = AppState.addEventListener("change", (state) => setCovered(state !== "active"));
    return () => sub.remove();
  }, []);

  const unlock = useCallback(() => setLockedToken(null), []);

  if (!session) return <>{children}</>;
  return (
    <View style={{ flex: 1 }}>
      {children}
      {locked ? <LockScreen onUnlock={unlock} /> : covered ? <Cover /> : null}
    </View>
  );
}

function Cover() {
  const t = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: t.bg }]}>
      <Wordmark size={26} />
    </View>
  );
}

type Biometric = { label: string } | null;

async function biometric(): Promise<Biometric> {
  if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) return null;
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  if (Platform.OS === "ios") return { label: face ? "Face ID" : "Touch ID" };
  return { label: face ? "Face unlock" : "Fingerprint" };
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "bio", "0", "del"];
const KEY = 72;

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const t = useTheme();
  const { session, signOut } = useSession();
  const [bio, setBio] = useState<Biometric>(null);
  const [pin, setPin] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prompting = useRef(false);
  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  const tryBiometric = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    try {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Fintrack",
        cancelLabel: "Use PIN",
        disableDeviceFallback: true, // the fallback is the Fintrack PIN, not the phone passcode
      });
      if (r.success) onUnlock();
    } finally {
      prompting.current = false;
    }
  }, [onUnlock]);

  // Offer biometrics once when the lock appears. The system prompt itself makes the app
  // briefly inactive, so this must not re-run on re-renders or it would prompt in a loop.
  const offered = useRef(false);
  useEffect(() => {
    let alive = true;
    biometric().then((b) => {
      if (!alive) return;
      setBio(b);
      if (b && !offered.current) {
        offered.current = true;
        void tryBiometric();
      }
    });
    return () => {
      alive = false;
    };
  }, [tryBiometric]);

  async function check(value: string) {
    if (!session) return;
    setChecking(true);
    setError(null);
    try {
      await verifyPin(session, value);
      onUnlock();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "unknown";
      // A 401 that isn't a wrong PIN means this phone's token was revoked.
      if (e instanceof ApiError && e.status === 401 && code !== "wrong_pin") return signOut();
      // A short, soft side-to-side: says "no" without jolting.
      const step = (x: number) => withTiming(x, { duration: 70, easing: MOTION.inOut });
      shake.set(withSequence(step(-7), step(6), step(-4), step(2), withTiming(0, { duration: 140, easing: MOTION.ease })));
      setError(
        code === "wrong_pin" ? "WRONG PIN" :
        code === "locked" ? "TOO MANY TRIES. TRY LATER" :
        code === "network_error" ? "CAN'T REACH THE SERVER" :
        "COULDN'T CHECK YOUR PIN",
      );
      setPin("");
    } finally {
      setChecking(false);
    }
  }

  function press(key: string) {
    if (checking) return;
    if (key === "bio") return void tryBiometric();
    if (key === "del") return setPin((p) => p.slice(0, -1));
    if (pin.length >= 4) return;
    const next = pin + key;
    setPin(next);
    if (next.length === 4) void check(next);
  }

  return (
    <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(260)} style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]}>
      <CyberBackground />
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.body}>
          <Reveal index={0} style={styles.center}>
            <Wordmark size={24} />
          </Reveal>

          <Reveal index={1}>
            <Card tone="ink" style={styles.panel}>
              <View style={styles.panelTop}>
                <Text style={[styles.hello, { color: t.inkMuted }]}>{session?.userName ? `HI ${session.userName.toUpperCase()}` : "LOCKED"}</Text>
                <Text style={[styles.hello, { color: t.inkMuted }]}>ENTER PIN</Text>
              </View>
              <Animated.View style={[styles.dots, shakeStyle]} accessibilityLabel={`${pin.length} of 4 digits entered`}>
                {[0, 1, 2, 3].map((i) => (
                  <Dot key={i} filled={i < pin.length} error={!!error && pin.length === 0} />
                ))}
              </Animated.View>
              <Text style={[styles.error, { color: error ? t.accent : "transparent" }]}>{error ?? "·"}</Text>
            </Card>
          </Reveal>

          <Reveal index={2} style={styles.pad}>
            {KEYS.map((k) =>
              k === "bio" && !bio ? (
                <View key={k} style={styles.keySlot} />
              ) : (
                <PressScale
                  key={k}
                  onPress={() => press(k)}
                  scale={0.94}
                  accessibilityLabel={k === "del" ? "Delete" : k === "bio" ? `Use ${bio?.label}` : k}
                  style={[
                    styles.keySlot,
                    styles.key,
                    k === "bio" ? { backgroundColor: t.accent } : k === "del" ? null : { backgroundColor: t.card, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth },
                  ]}
                >
                  {k === "bio" || k === "del" ? (
                    <PixelIcon name={k === "bio" ? "unlock" : "arrow-left"} size={26} color={t.text} />
                  ) : (
                    <Text style={[styles.digit, { color: t.text }]}>{k}</Text>
                  )}
                </PressScale>
              ),
            )}
          </Reveal>

          <View style={styles.footer}>
            <Barcode width={96} height={22} seed={404} />
            <Text style={[styles.forgot, { color: t.text }]} onPress={signOut}>
              Forgot PIN? Sign out
            </Text>
          </View>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

function Dot({ filled, error }: { filled: boolean; error: boolean }) {
  const s = useSharedValue(filled ? 1 : 0);
  useEffect(() => {
    s.set(withTiming(filled ? 1 : 0, { duration: MOTION.fast, easing: MOTION.ease }));
  }, [filled, s]);
  const fill = useAnimatedStyle(() => ({ opacity: s.get(), transform: [{ scale: 0.7 + s.get() * 0.3 }] }));
  return (
    <View style={[styles.dot, { borderColor: error ? PALETTE.orange : alpha(PALETTE.amande, 0.5) }]}>
      <Animated.View style={[styles.dotFill, { backgroundColor: PALETTE.orange }, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8, justifyContent: "space-between" },
  center: { alignItems: "center", justifyContent: "center" },
  panel: { paddingVertical: 22, gap: 18 },
  panelTop: { flexDirection: "row", justifyContent: "space-between" },
  hello: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 1.8 },
  dots: { flexDirection: "row", gap: 18, alignSelf: "center" },
  dot: { width: 22, height: 22, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  dotFill: { width: 12, height: 12 },
  error: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 1.5, textAlign: "center" },
  pad: { flexDirection: "row", flexWrap: "wrap", width: 3 * KEY + 2 * 24, columnGap: 24, rowGap: 14, alignSelf: "center" },
  keySlot: { width: KEY, height: KEY, alignItems: "center", justifyContent: "center" },
  key: { borderRadius: KEY / 2 },
  digit: { fontFamily: FONT.displayMedium, fontSize: 26 },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  forgot: { fontSize: 14, textDecorationLine: "underline" },
});
