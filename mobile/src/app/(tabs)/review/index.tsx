import { router } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/text";
import { Chip, Empty, inputStyle } from "@/components/ui";
import { formatInr, getTransactions, updateTransaction, type Transaction, type TransactionPatch } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { CATEGORIES } from "@/lib/categories";
import { formatDateTime, payeeName, REVIEW_PROMPT } from "@/lib/format";
import { useSession } from "@/lib/session";
import { TAB_BAR_SPACE, useTheme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

// The categories most UPI payments to people and small shops fall into.
const QUICK = ["food", "groceries", "transport", "shopping", "bills", "family", "rent", "health", "entertainment", "other"];

export default function ReviewScreen() {
  const t = useTheme();
  const { session } = useSession();
  const badges = useBadges();
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    const r = await getTransactions(session, { review: true, limit: 200 }).catch(() => null);
    if (r) setItems(r.transactions);
  }, [session]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  async function answer(txn: Transaction, patch: TransactionPatch, what: string) {
    if (!session) return;
    setItems((cur) => cur?.filter((x) => x.id !== txn.id) ?? null); // optimistic
    try {
      const r = await updateTransaction(session, txn.id, patch);
      const others = r.applied_to;
      setToast(`${what}${others ? ` Also applied to ${others} other payment${others === 1 ? "" : "s"} to this payee.` : ""}`);
      setTimeout(() => setToast(null), 3500);
      if (others) await load();
    } catch {
      setToast("Couldn't save. Pull to refresh and try again.");
      await load();
    }
    badges.refresh();
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={items ?? []}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ padding: 16, paddingBottom: TAB_BAR_SPACE + 16, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={t.muted}
          />
        }
        ListHeaderComponent={
          items?.length ? (
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
              Your answer is remembered for the payee, so future payments to them are filled in automatically.
            </Text>
          ) : undefined
        }
        ListEmptyComponent={items ? <Empty title="All caught up ✓" body="Payments we can't work out on our own will show up here." /> : undefined}
        renderItem={({ item }) => <ReviewCard txn={item} onAnswer={answer} />}
      />
      {toast && (
        <View style={[styles.toast, { backgroundColor: t.text }]}>
          <Text style={{ color: t.bg, fontSize: 14 }}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

function ReviewCard({ txn, onAnswer }: { txn: Transaction; onAnswer: (t: Transaction, p: TransactionPatch, what: string) => void }) {
  const t = useTheme();
  const [name, setName] = useState("");
  const askName = txn.review_reason === "unknown_payee";
  const label = name.trim() || undefined;
  const credit = txn.direction === "credit";

  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
      <Pressable onPress={() => router.push(`/transaction/${txn.id}`)} style={styles.top}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: "600" }} numberOfLines={1}>
            {payeeName(txn)}
          </Text>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
            {[txn.institution_name, formatDateTime(txn.occurred_at)].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Text style={{ color: credit ? t.credit : t.text, fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {credit ? "+" : ""}
          {formatInr(txn.amount_minor)}
        </Text>
      </Pressable>

      <Text style={{ color: t.link, fontSize: 15, fontWeight: "600" }}>{REVIEW_PROMPT[txn.review_reason ?? ""] ?? "Anything to add?"}</Text>

      {askName && (
        <TextInput
          style={inputStyle(t)}
          value={name}
          onChangeText={setName}
          placeholder="Name (e.g. Chai stall, Rent, Mom)"
          placeholderTextColor={t.muted}
          returnKeyType="done"
          autoCorrect={false}
        />
      )}

      <View style={styles.chips}>
        {QUICK.map((id) => {
          const c = CATEGORIES.find((x) => x.id === id)!;
          return (
            <Chip
              key={id}
              icon={c.icon}
              label={c.name}
              onPress={() => onAnswer(txn, { category: id, label, remember: true }, `Saved as ${c.name}.`)}
            />
          );
        })}
        <Chip label="More…" onPress={() => router.push(`/transaction/${txn.id}`)} />
      </View>

      <View style={[styles.actions, { borderTopColor: t.border }]}>
        <Text
          style={[styles.action, { color: t.link }]}
          onPress={() => onAnswer(txn, { event_type: "transfer", label, remember: true }, "Marked as a transfer between your own accounts.")}
        >
          My own account
        </Text>
        <Text style={[styles.action, { color: t.muted }]} onPress={() => onAnswer(txn, { label }, "Okay, left as is.")}>
          Skip
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actions: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  action: { fontSize: 15, fontWeight: "600", paddingVertical: 2 },
  // Above the floating tab bar.
  toast: { position: "absolute", left: 16, right: 16, bottom: TAB_BAR_SPACE + 8, borderRadius: 14, padding: 14 },
});
