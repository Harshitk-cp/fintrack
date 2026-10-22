import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { Barcode, CyberButton, CyberField, MetaRule, Reveal, Wordmark } from "@/components/cyber";
import { PixelIcon } from "@/components/pixel-icon";
import { Card } from "@/components/ui";
import { Text } from "@/components/text";
import { ApiError, login, normalizeServerUrl, register } from "@/lib/api";
import { useSession } from "@/lib/session";
import { FONT, useTheme } from "@/lib/theme";

// The server is fixed: the local backend in development (simulator / emulator), the VPS in release builds.
const DEV_SERVER = Platform.OS === "android" ? "http://10.0.2.2:8080" : "http://localhost:8080";
const SERVER = __DEV__ ? DEV_SERVER : (process.env.EXPO_PUBLIC_SERVER_URL ?? "https://35-170-7-31.sslip.io");

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Wrong phone number or PIN.",
  invalid_phone: "That doesn't look like a phone number. Use 10 digits, or include the country code.",
  phone_taken: "This number already has an account. Sign in instead.",
  weak_pin: "That PIN is too easy to guess. Avoid repeated digits (1111), runs (1234) and years.",
  locked: "Too many wrong PINs. Try again later.",
  network_error: "Can't reach the server. Check your connection.",
};

const PLATFORM = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other";
const DEVICE_NAME = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "Phone";

export default function SignInScreen() {
  const t = useTheme();
  const { signIn } = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creating = mode === "register";
  const valid = phone.replace(/\D/g, "").length >= 10 && /^\d{4}$/.test(pin) && (!creating || name.trim().length > 0);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = normalizeServerUrl(SERVER);
      const device = { platform: PLATFORM, device_name: DEVICE_NAME } as const;
      const res = creating
        ? await register(url, { phone, pin, name: name.trim(), ...device })
        : await login(url, { phone, pin, ...device });
      await signIn({ serverUrl: url, token: res.token, userName: res.user.name, phone: res.user.phone });
    } catch (e) {
      const key = e instanceof ApiError ? e.code : "unknown";
      setError(MESSAGES[key] ?? `Something went wrong (${key}).`);
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Reveal index={0}>
            <Card style={styles.hero}>
              <Wordmark size={30} />
              <View style={[styles.heroRow, { borderBottomColor: t.border }]}>
                <Text style={[styles.heroLabel, { color: t.muted }]}>PERSONAL</Text>
                <Text style={[styles.heroLabel, { color: t.muted }]}>LEDGER</Text>
              </View>
              <MetaRule left="IN" right="OUT" />
              <View style={styles.heroFoot}>
                <PixelIcon name="target" size={40} color={t.accent} />
                <Barcode width={170} height={36} seed={2026} />
              </View>
            </Card>
          </Reveal>

          <Animated.View layout={LinearTransition.springify().damping(18)} style={{ marginTop: 26 }}>
            {creating && (
              <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(150)}>
                <CyberField label="Your name" value={name} onChangeText={setName} placeholder="Kage" autoCorrect={false} />
              </Animated.View>
            )}
            <Reveal index={1}>
              <CyberField
                label="Phone number"
                value={phone}
                onChangeText={setPhone}
                placeholder="98765 43210"
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                autoComplete="tel"
              />
            </Reveal>
            <Reveal index={2}>
              <CyberField
                label={creating ? "Choose a 4-digit PIN" : "PIN"}
                value={pin}
                onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 4))}
                placeholder="• • • •"
                keyboardType="number-pad"
                secureTextEntry
                maxLength={4}
                // Not "password": iOS would offer a strong generated password, which can't be a 4-digit PIN.
                textContentType="none"
                autoComplete="off"
                onSubmitEditing={submit}
              />
            </Reveal>

            {error && (
              <Animated.View entering={FadeIn.duration(180)} style={[styles.error, { backgroundColor: t.accent }]}>
                <PixelIcon name="warning-diamond" size={18} color={t.onAccent} />
                <Text style={{ color: t.onAccent, fontSize: 14, lineHeight: 19, fontWeight: "600", flex: 1 }}>{error}</Text>
              </Animated.View>
            )}

            <Reveal index={3}>
              <CyberButton title={creating ? "Create account" : "Sign in"} kind="solid" onPress={submit} busy={busy} disabled={!valid} style={{ marginTop: 6 }} />
            </Reveal>
          </Animated.View>

          <Reveal index={4} style={styles.links}>
            <Text style={{ color: t.muted, fontSize: 14 }}>{creating ? "Already have an account?" : "New here?"}</Text>
            <CyberButton
              title={creating ? "Sign in" : "Create account"}
              kind="primary"
              onPress={() => {
                setMode(creating ? "login" : "register");
                setError(null);
              }}
            />
            {!creating && <Text style={{ color: t.muted, fontSize: 13, textAlign: "center" }}>Forgot your PIN? Ask the server admin to reset it.</Text>}
          </Reveal>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  hero: { padding: 22, gap: 18 },
  heroRow: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1.5, paddingBottom: 10 },
  heroLabel: { fontFamily: FONT.displayMedium, fontSize: 15, letterSpacing: 0.5 },
  heroFoot: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  error: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, padding: 12, marginBottom: 14 },
  links: { alignItems: "stretch", marginTop: 26, gap: 12 },
});
