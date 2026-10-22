import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from "react-native";
import { CyberButton, CyberField } from "@/components/cyber";
import { Text } from "@/components/text";
import { addSip, ApiError, deleteSip, formatInr, getSips, parseRupees, updateSip } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";

/**
 * Add or edit a SIP. Opened from Insights (new or ?id= to edit) or from a SIP
 * alert in Review (?suggestion=&scheme=&amount=), which also marks that month paid.
 */
export default function SipScreen() {
  const t = useTheme();
  const { session } = useSession();
  const badges = useBadges();
  const p = useLocalSearchParams<{ id?: string; suggestion?: string; scheme?: string; amount?: string }>();
  const [name, setName] = useState(p.scheme ?? "");
  const [amount, setAmount] = useState(p.amount ? String(Number(p.amount) / 100) : "");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!p.id || !session) return;
    getSips(session)
      .then((s) => {
        const sip = s.sips.find((x) => x.id === p.id);
        if (!sip) return;
        setName(sip.name);
        setAmount(String(sip.amount_minor / 100));
        setDay(sip.day_of_month ? String(sip.day_of_month) : "");
      })
      .catch(() => {});
  }, [p.id, session]);

  const minor = parseRupees(amount);
  const dayNum = day.trim() ? Number(day) : null;
  const dayOk = dayNum === null || (Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 31);
  const valid = name.trim().length > 0 && !!minor && dayOk;

  async function save() {
    if (!session || !minor) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), amount_minor: minor, day_of_month: dayNum };
      if (p.id) await updateSip(session, p.id, body);
      else await addSip(session, { ...body, ...(p.suggestion ? { from_suggestion: p.suggestion } : {}) });
      badges.refresh();
      router.back();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "sip_exists" ? "You already have a SIP with this name." : "Couldn't save. Try again.");
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: p.id ? "Edit SIP" : "Add SIP" }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {p.suggestion && (
          <Text style={[styles.note, { color: t.muted }]}>
            From a SIP alert{p.amount ? ` for ${formatInr(Number(p.amount))}` : ""}. Saving adds it and marks that month as paid.
          </Text>
        )}
        <CyberField label="Fund or scheme" value={name} onChangeText={setName} placeholder="e.g. Parag Parikh Flexi Cap" autoCorrect={false} />
        <CyberField label="Monthly amount ₹" value={amount} onChangeText={setAmount} placeholder="5,000" keyboardType="decimal-pad" />
        <CyberField label="Usual debit day (optional)" value={day} onChangeText={(v) => setDay(v.replace(/\D/g, "").slice(0, 2))} placeholder="5" keyboardType="number-pad" />
        {!dayOk && <Text style={[styles.note, { color: t.dangerText }]}>Use a day between 1 and 31.</Text>}
        {error && <Text style={[styles.note, { color: t.dangerText }]}>{error}</Text>}
        <CyberButton title={p.id ? "Save" : "Add SIP"} kind="solid" busy={busy} disabled={!valid} onPress={save} style={{ marginTop: 8 }} />
        {p.id && (
          <Text
            style={[styles.remove, { color: t.dangerText }]}
            onPress={async () => {
              if (!session) return;
              await deleteSip(session, p.id!).catch(() => {});
              router.back();
            }}
          >
            Delete this SIP
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20, paddingBottom: 48 },
  note: { fontSize: 14, lineHeight: 20, marginBottom: 14 },
  remove: { fontSize: 15, textAlign: "center", marginTop: 20, textDecorationLine: "underline" },
});
