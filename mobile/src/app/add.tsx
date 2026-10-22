import { router } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/text";
import { Button, CategoryPicker, Chip, inputStyle, Section } from "@/components/ui";
import { addTransaction, getTransactions, parseRupees } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { TZ } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";

const DAYS = [
  { label: "Today", offset: 0 },
  { label: "Yesterday", offset: 1 },
  { label: "2 days ago", offset: 2 },
  { label: "3 days ago", offset: 3 },
];

export default function AddScreen() {
  const t = useTheme();
  const { session } = useSession();
  const badges = useBadges();
  const [direction, setDirection] = useState<"debit" | "credit">("debit");
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [paidWith, setPaidWith] = useState("Cash");
  const [banks, setBanks] = useState<string[]>([]);
  const [dayOffset, setDayOffset] = useState(0);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [openedAt] = useState(() => Date.now()); // fixed for this screen so the date label is stable
  const [error, setError] = useState<string | null>(null);

  // Offer the banks the user already has transactions with.
  useEffect(() => {
    if (!session) return;
    getTransactions(session, { limit: 200 })
      .then((r) => {
        const names = new Set(r.transactions.filter((x) => x.source === "sms").map((x) => x.institution_name).filter((n): n is string => !!n));
        setBanks([...names]);
      })
      .catch(() => {});
  }, [session]);

  const minor = parseRupees(amount);
  const valid = !!minor && payee.trim().length > 0;

  async function save() {
    if (!session || !minor) return;
    setSaving(true);
    setError(null);
    try {
      // Keep the current time of day, moved back by the chosen number of days.
      const when = new Date(Date.now() - dayOffset * 86_400_000);
      await addTransaction(session, {
        amount_minor: minor,
        direction,
        counterparty: payee.trim(),
        category: category ?? (direction === "credit" ? "income" : null),
        occurred_at: when.toISOString(),
        paid_with: paidWith,
        note: note.trim() || null,
      });
      badges.refresh();
      router.back();
    } catch {
      setError("Couldn't save. Check your connection.");
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.segment}>
          <Chip label="Expense" selected={direction === "debit"} onPress={() => setDirection("debit")} />
          <Chip label="Income" selected={direction === "credit"} onPress={() => setDirection("credit")} />
        </View>

        <View style={styles.amountRow}>
          <Text style={[styles.rupee, { color: t.muted }]}>₹</Text>
          <TextInput
            style={[styles.amount, { color: t.text }]}
            value={amount}
            onChangeText={setAmount}
            placeholder="0"
            placeholderTextColor={t.border}
            keyboardType="decimal-pad"
            autoFocus
            accessibilityLabel="Amount in rupees"
          />
        </View>

        <Section title={direction === "debit" ? "Paid to" : "Received from"}>
          <TextInput
            style={inputStyle(t)}
            value={payee}
            onChangeText={setPayee}
            placeholder={direction === "debit" ? "e.g. Auto, Vegetable vendor" : "e.g. Salary, Friend"}
            placeholderTextColor={t.muted}
            autoCorrect={false}
          />
        </Section>

        <Section title="Category">
          <CategoryPicker value={category} onChange={(c) => setCategory(c === category ? null : c)} />
        </Section>

        <Section title={direction === "debit" ? "Paid with" : "Received in"}>
          <View style={styles.chips}>
            {["Cash", ...banks].map((b) => (
              <Chip key={b} label={b} selected={paidWith === b} onPress={() => setPaidWith(b)} />
            ))}
          </View>
        </Section>

        <Section title="When">
          <View style={styles.chips}>
            {DAYS.map((d) => (
              <Chip key={d.offset} label={d.label} selected={dayOffset === d.offset} onPress={() => setDayOffset(d.offset)} />
            ))}
          </View>
          <Text style={{ color: t.muted, fontSize: 13 }}>
            {new Date(openedAt - dayOffset * 86_400_000).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })}
          </Text>
        </Section>

        <Section title="Note">
          <TextInput style={inputStyle(t)} value={note} onChangeText={setNote} placeholder="Optional" placeholderTextColor={t.muted} />
        </Section>

        {error && <Text style={{ color: t.dangerText, marginBottom: 12 }}>{error}</Text>}
        <Button title={direction === "debit" ? "Add expense" : "Add income"} onPress={save} busy={saving} disabled={!valid} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 48 },
  segment: { flexDirection: "row", gap: 8, justifyContent: "center" },
  amountRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginVertical: 24 },
  rupee: { fontSize: 36, fontWeight: "600", marginRight: 4 },
  amount: { fontSize: 48, fontWeight: "700", minWidth: 80, textAlign: "center", fontVariant: ["tabular-nums"] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
