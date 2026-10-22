import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/text";
import SmsCollector, { type CollectorStatus } from "../../../../modules/sms-collector";
import { Chip, inputStyle, Row as UiRow, Section as UiSection } from "@/components/ui";
import { ApiError, changePin, formatInr, getSettings, logout, parseRupees, sendTestPush, updateSettings, type Settings } from "@/lib/api";
import { useSession } from "@/lib/session";
import { TAB_BAR_SPACE, useTheme, type Theme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

export default function SettingsScreen() {
  const t = useTheme();
  const { session, signOut } = useSession();

  async function signOutHere() {
    // Revoke this phone's token on the server too; sign out locally even if that fails.
    if (session) await logout(session).catch(() => {});
    await signOut();
  }

  return (
    <ScrollView contentContainerStyle={styles.body} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <AlertSettings />

      <Section title="Account" t={t}>
        <Row label="Signed in as" value={session?.userName ?? ""} t={t} />
        {session?.phone ? <Row label="Phone" value={session.phone} t={t} /> : null}
        <ChangePin t={t} />
      </Section>

      {Platform.OS === "android" ? <AndroidCollector t={t} /> : <IosShortcutHelp t={t} />}

      <Pressable onPress={signOutHere} style={({ pressed }) => [styles.unpair, { borderColor: t.border, opacity: pressed ? 0.6 : 1 }]}>
        <Text style={{ color: t.dangerText, fontSize: 16, fontWeight: "600" }}>Sign out of this phone</Text>
      </Pressable>
    </ScrollView>
  );
}

function ChangePin({ t }: { t: Theme }) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

  if (!open) {
    return (
      <Text style={{ color: t.link, fontSize: 15, fontWeight: "600" }} onPress={() => { setOpen(true); setStatus(null); }}>
        {status ?? "Change PIN"}
      </Text>
    );
  }

  async function save() {
    if (!session) return;
    setBusy(true);
    try {
      await changePin(session, current, next);
      setOpen(false);
      setStatus("PIN changed ✓");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setStatus(code === "wrong_pin" ? "Current PIN is wrong." : code === "weak_pin" ? "Too easy to guess. Avoid 1111, 1234 and years." : code === "locked" ? "Too many wrong PINs. Try again later." : "Couldn't change the PIN.");
    } finally {
      setCurrent("");
      setNext("");
      setBusy(false);
    }
  }

  const pinInput = { keyboardType: "number-pad" as const, secureTextEntry: true, maxLength: 4, placeholderTextColor: t.muted };
  return (
    <View style={{ gap: 10 }}>
      <TextInput style={inputStyle(t)} value={current} onChangeText={(v) => setCurrent(digits(v))} placeholder="Current PIN" {...pinInput} />
      <TextInput style={inputStyle(t)} value={next} onChangeText={(v) => setNext(digits(v))} placeholder="New 4-digit PIN" {...pinInput} />
      {status && <Text style={{ color: t.dangerText, fontSize: 14 }}>{status}</Text>}
      <View style={styles.inline}>
        <Text style={{ color: t.muted, fontSize: 15 }} onPress={() => setOpen(false)}>Cancel</Text>
        <Pressable
          onPress={save}
          disabled={busy || current.length !== 4 || next.length !== 4}
          style={({ pressed }) => [styles.primary, { backgroundColor: t.accent, paddingHorizontal: 20, marginTop: 0, opacity: busy || current.length !== 4 || next.length !== 4 ? 0.5 : pressed ? 0.8 : 1 }]}
        >
          <Text style={styles.primaryText}>Save PIN</Text>
        </Pressable>
      </View>
    </View>
  );
}

function AlertSettings() {
  const t = useTheme();
  const { session } = useSession();
  const [s, setS] = useState<Settings | null>(null);
  const [threshold, setThreshold] = useState("");
  const [budget, setBudget] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const apply = (x: Settings) => {
    setS(x);
    setThreshold(String(x.alert_min_minor / 100));
    setBudget(x.monthly_budget_minor ? String(x.monthly_budget_minor / 100) : "");
  };
  useEffect(() => {
    if (session) getSettings(session).then(apply).catch(() => setStatus("Couldn't load settings."));
  }, [session]);

  async function save(patch: Parameters<typeof updateSettings>[1], message?: string) {
    if (!session) return;
    try {
      apply(await updateSettings(session, patch));
      if (message) setStatus(message);
    } catch {
      setStatus("Couldn't save. Check your connection.");
    }
  }

  if (!s) return status ? <Text style={{ color: t.dangerText, marginBottom: 16 }}>{status}</Text> : null;

  const host = s.push.server?.replace(/^https?:\/\//, "") ?? "";
  const hour = (h: number) => new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString("en-IN", { hour: "numeric", timeZone: "UTC" });
  return (
    <>
      <UiSection
        title="Alerts"
        footer="Alerts and questions always appear in the in-app inbox. Payments you can't explain go to the Review tab."
      >
        <View style={styles.inline}>
          <Text style={[styles.inlineLabel, { color: t.text }]}>Alert me for payments from ₹</Text>
          <TextInput
            style={[inputStyle(t), styles.small]}
            value={threshold}
            onChangeText={setThreshold}
            keyboardType="number-pad"
            onEndEditing={() => {
              const minor = threshold.trim() === "0" ? 0 : parseRupees(threshold);
              if (minor === null) return setThreshold(String(s.alert_min_minor / 100));
              if (minor !== s.alert_min_minor) save({ alert_min_minor: minor }, minor ? `Alerts for payments of ${formatInr(minor)} or more.` : "Alerts for every payment.");
            }}
          />
        </View>
        <View style={styles.inline}>
          <Text style={[styles.inlineLabel, { color: t.text }]}>Daily summary at</Text>
          <View style={styles.stepper}>
            <Chip label="−" onPress={() => save({ digest_hour: (s.digest_hour + 23) % 24 })} />
            <Text style={{ color: t.text, fontSize: 16, minWidth: 56, textAlign: "center" }}>{hour(s.digest_hour)}</Text>
            <Chip label="+" onPress={() => save({ digest_hour: (s.digest_hour + 1) % 24 })} />
          </View>
        </View>
        <View style={styles.inline}>
          <Text style={[styles.inlineLabel, { color: t.text }]}>Monthly budget ₹</Text>
          <TextInput
            style={[inputStyle(t), styles.small]}
            value={budget}
            onChangeText={setBudget}
            placeholder="None"
            placeholderTextColor={t.muted}
            keyboardType="number-pad"
            onEndEditing={() => {
              const minor = budget.trim() ? parseRupees(budget) : null;
              if (budget.trim() && minor === null) return setBudget(s.monthly_budget_minor ? String(s.monthly_budget_minor / 100) : "");
              if (minor !== s.monthly_budget_minor) save({ monthly_budget_minor: minor }, minor ? "Budget saved. You'll be warned at 80% and 100%." : "Budget removed.");
            }}
          />
        </View>
      </UiSection>

      <UiSection
        title="Push notifications"
        footer={
          s.push.available
            ? "Push uses the free ntfy app, so it works without an Apple developer account. The topic name is a secret: anyone who knows it can read your alerts."
            : "Push isn't configured on this server."
        }
      >
        {!s.push.enabled ? (
          <Text
            style={{ color: s.push.available ? t.link : t.muted, fontSize: 16, fontWeight: "600" }}
            onPress={() => s.push.available && save({ push_enabled: true }, "Push turned on. Now subscribe in ntfy (steps above).")}
          >
            Turn on push notifications
          </Text>
        ) : (
          <>
            <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>
              1. Install <Text style={{ fontWeight: "600" }}>ntfy</Text> from the {Platform.OS === "ios" ? "App Store" : "Play Store"}.{"\n"}
              2. In ntfy tap <Text style={{ fontWeight: "600" }}>+</Text>, paste the topic below
              {host !== "ntfy.sh" ? `, turn on "Use another server" and enter ${s.push.server}` : ""}, then Subscribe.{"\n"}
              3. Allow notifications, then send a test.
            </Text>
            <UiRow label="Topic" value={s.push.topic ?? ""} />
            <View style={styles.chipsRow}>
              <Chip label="Copy topic" onPress={() => Clipboard.setStringAsync(s.push.topic ?? "").then(() => setStatus("Topic copied."))} />
              <Chip label="Open ntfy" onPress={() => Linking.openURL(`ntfy://${host}/${s.push.topic}`).catch(() => setStatus("Install ntfy first."))} />
              <Chip label="Send test" onPress={() => session && sendTestPush(session).then(() => setStatus("Test sent. It should arrive within a few seconds."), () => setStatus("Couldn't send the test."))} />
            </View>
            <Text style={{ color: t.dangerText, fontSize: 15 }} onPress={() => save({ push_enabled: false }, "Push turned off.")}>
              Turn off push
            </Text>
          </>
        )}
      </UiSection>
      {status && <Text style={{ color: t.muted, fontSize: 14, marginTop: -12, marginBottom: 20, marginHorizontal: 4 }}>{status}</Text>}
    </>
  );
}

function AndroidCollector({ t }: { t: Theme }) {
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const refresh = useCallback(() => {
    SmsCollector?.getStatus().then(setStatus);
  }, []);
  useRefreshOnActive(refresh, 5000);

  async function grant() {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS, {
      title: "Read bank SMS",
      message: "Fintrack forwards bank transaction SMS to your server. Personal messages and OTPs never leave the phone.",
      buttonPositive: "Allow",
    });
    refresh();
  }

  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Never");

  return (
    <Section title="SMS collector" t={t}>
      {!status ? (
        <Text style={{ color: t.muted }}>Loading…</Text>
      ) : (
        <>
          <Row label="SMS permission" value={status.hasPermission ? "Granted" : "Not granted"} t={t} warn={!status.hasPermission} />
          <Row label="Forwarding" value={status.enabled ? "On" : "Off"} t={t} warn={!status.enabled} />
          <Row label="Forwarded" value={String(status.forwardedCount)} t={t} />
          <Row label="Waiting to upload" value={String(status.pending)} t={t} />
          <Row label="Last forwarded" value={when(status.lastForwardedAt)} t={t} />
          {status.lastError && <Row label="Last error" value={status.lastError} t={t} warn />}
          {!status.hasPermission && (
            <Pressable onPress={grant} style={({ pressed }) => [styles.primary, { backgroundColor: t.accent, opacity: pressed ? 0.8 : 1 }]}>
              <Text style={styles.primaryText}>Allow SMS access</Text>
            </Pressable>
          )}
        </>
      )}
    </Section>
  );
}

function IosShortcutHelp({ t }: { t: Theme }) {
  const { session } = useSession();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };
  // Verified on iOS 26 in the Shortcuts editor; the request half was run against the API.
  const steps = [
    "Open Shortcuts → Automation → New Automation → Message.",
    "Leave Sender as Any Sender. Set Message Contains to Rs. Choose Run Immediately, then Next → Create New Shortcut.",
    "Add an If action. Tap Shortcut Input, choose Content, set the condition to “does not contain” and type OTP. Delete the Otherwise row.",
    "Add Get Contents of URL and drag it between If and End If. Tap its URL (pre-filled with Shortcut Input) → Clear Variable, then paste the URL below.",
    "Tap › on that action. Method: POST. Headers → Add new header: key Authorization, value = paste the header below.",
    "Request Body: JSON → Add new field → Text: key body, value = Shortcut Input → Content. Optional: another field sender = Shortcut Input → Sender.",
    "Tap ✓ to save. The first time a bank SMS arrives, iOS asks to allow sending to your server: tap Always Allow.",
  ];
  return (
    <Section title="iPhone SMS forwarding" t={t}>
      <Text style={[styles.help, { color: t.muted }]}>
        iOS doesn’t let apps read SMS, so a Shortcuts automation forwards bank messages. Set it up once:
      </Text>
      {steps.map((s, i) => (
        <Text key={i} style={[styles.step, { color: t.text }]}>
          {i + 1}. {s}
        </Text>
      ))}
      <CopyButton label="URL" copied={copied} onPress={() => copy("URL", `${session?.serverUrl}/v1/sms`)} t={t} />
      <CopyButton label="Authorization header" copied={copied} onPress={() => copy("Authorization header", `Bearer ${session?.token}`)} t={t} />
    </Section>
  );
}

function CopyButton({ label, copied, onPress, t }: { label: string; copied: string | null; onPress: () => void; t: Theme }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.copy, { borderColor: t.border, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ color: t.link, fontWeight: "600" }}>{copied === label ? "Copied ✓" : `Copy ${label}`}</Text>
    </Pressable>
  );
}

// `t` is accepted for the existing call sites; the shared section reads the theme itself.
function Section({ title, children }: { title: string; t: Theme; children: React.ReactNode }) {
  return <UiSection title={title}>{children}</UiSection>;
}

function Row({ label, value, t, warn }: { label: string; value: string; t: Theme; warn?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={{ color: t.muted, fontSize: 15 }}>{label}</Text>
      <Text style={{ color: warn ? t.dangerText : t.text, fontSize: 15, flexShrink: 1, textAlign: "right" }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: TAB_BAR_SPACE + 16 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, marginLeft: 4 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  help: { fontSize: 14, lineHeight: 20 },
  step: { fontSize: 14, lineHeight: 20 },
  copy: { borderWidth: 1, borderRadius: 14, paddingVertical: 11, alignItems: "center" },
  primary: { borderRadius: 14, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  primaryText: { color: "#0B0829", fontSize: 16, fontWeight: "600" },
  unpair: { borderWidth: 1, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  inline: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  inlineLabel: { fontSize: 15, flex: 1 },
  small: { minWidth: 96, paddingVertical: 8, textAlign: "right" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
