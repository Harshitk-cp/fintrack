import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, normalizeServerUrl, pair } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";

// Simulator/emulator defaults for local development; real phones use the VPS URL.
const DEV_SERVER = Platform.OS === "android" ? "http://10.0.2.2:8080" : "http://localhost:8080";

const MESSAGES: Record<string, string> = {
  invalid_or_expired_code: "That code is wrong, expired, or already used. Generate a new one.",
  network_error: "Can't reach the server. Check the URL and your connection.",
  https_required: "The server URL must start with https://.",
};

export default function PairScreen() {
  const t = useTheme();
  const { signIn } = useSession();
  const [serverUrl, setServerUrl] = useState(__DEV__ ? DEV_SERVER : (process.env.EXPO_PUBLIC_SERVER_URL ?? "https://"));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const url = normalizeServerUrl(serverUrl);
      const res = await pair(url, code);
      await signIn({ serverUrl: url, token: res.token, userName: res.user.name });
    } catch (e) {
      const key = e instanceof ApiError ? e.code : "unknown";
      setError(MESSAGES[key] ?? `Pairing failed (${key}).`);
    } finally {
      setBusy(false);
    }
  }

  const input = [styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }];
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: t.bg }]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.body}>
        <Text style={[styles.title, { color: t.text }]}>Fintrack</Text>
        <Text style={[styles.subtitle, { color: t.muted }]}>
          Ask the server admin for a pairing code. It works once and expires after 15 minutes.
        </Text>

        <Text style={[styles.label, { color: t.muted }]}>Server</Text>
        <TextInput
          style={input}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Server URL"
        />

        <Text style={[styles.label, { color: t.muted }]}>Pairing code</Text>
        <TextInput
          style={[input, styles.code]}
          value={code}
          onChangeText={setCode}
          placeholder="XXXX-XXXX"
          placeholderTextColor={t.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={9}
          accessibilityLabel="Pairing code"
          onSubmitEditing={submit}
        />

        {error && <Text style={[styles.error, { color: t.danger }]}>{error}</Text>}

        <Pressable
          onPress={submit}
          disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 8}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t.accent, opacity: busy || code.replace(/[^a-z0-9]/gi, "").length < 8 ? 0.5 : pressed ? 0.8 : 1 },
          ]}
          accessibilityRole="button"
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Pair phone</Text>}
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 32, fontWeight: "700", marginBottom: 8 },
  subtitle: { fontSize: 15, lineHeight: 21, marginBottom: 32 },
  label: { fontSize: 13, fontWeight: "600", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 20 },
  code: { fontSize: 22, letterSpacing: 4, fontVariant: ["tabular-nums"] },
  error: { fontSize: 14, marginBottom: 16 },
  button: { borderRadius: 10, paddingVertical: 15, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
