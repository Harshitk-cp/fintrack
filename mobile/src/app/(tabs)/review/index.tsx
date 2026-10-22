import { router } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/text";
import { Chip, Empty, IconTile, inputStyle } from "@/components/ui";
import { dismissSipSuggestion, getSips, getTransactions, updateTransaction, type SipSuggestion, type Transaction, type TransactionPatch } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { CATEGORIES } from "@/lib/categories";
import { formatDateTime, payeeName, REVIEW_PROMPT } from "@/lib/format";
import { haptic } from "@/lib/haptics";
import { useMoney } from "@/lib/privacy";
import { useToast } from "@/lib/toast";
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
  const [sipAlerts, setSipAlerts] = useState<SipSuggestion[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!session) return;
    const [r, s] = await Promise.all([getTransactions(session, { review: true, limit: 200 }).catch(() => null), getSips(session).catch(() => null)]);
    if (r) setItems(r.transactions);
    if (s) setSipAlerts(s.suggestions);
  }, [session]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  async function answer(txn: Transaction, patch: TransactionPatch, what: string) {
    if (!session) return;
    setItems((cur) => cur?.filter((x) => x.id !== txn.id) ?? null); // optimistic
    try {
      const r = await updateTransaction(session, txn.id, patch);
      haptic.success();
      const others = r.applied_to;
      if (others) {
        // Already copied to other payments; undoing just this one would leave them changed, so no Undo here.
        toast({ message: `${what} Also applied to ${others} other payment${others === 1 ? "" : "s"} to this payee.` });
        await load();
      } else {
        toast({
          message: what,
          undo: async () => {
            await updateTransaction(session, txn.id, {
              label: txn.label, category: txn.category, event_type: txn.event_type, excluded: txn.excluded,
              reviewed: false, forget: !!patch.remember,
            }).catch(() => toast({ message: "Couldn't undo. Check your connection." }));
            await load();
            badges.refresh();
          },
        });
      }
    } catch {
      haptic.error();
      toast({ message: "Couldn't save. Pull to refresh and try again." });
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
            tintColor={t.accent}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 16 }}>
            {sipAlerts.map((g) => (
              <SipAlertCard
                key={g.id}
                alert={g}
                onDismiss={async () => {
                  setSipAlerts((cur) => cur.filter((x) => x.id !== g.id));
                  if (session) await dismissSipSuggestion(session, g.id).catch(() => {});
                  badges.refresh();
                }}
              />
            ))}
            {items?.length ? (
              <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
                Your answer is remembered for the payee, so future payments to them are filled in automatically.
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={items && !sipAlerts.length ? <Empty title="All caught up ✓" body="Payments we can't work out on our own will show up here." /> : undefined}
        renderItem={({ item }) => <ReviewCard txn={item} onAnswer={answer} />}
      />
    </View>
  );
}

/** An alert that mentioned a SIP the assistant couldn't pin down. */
function SipAlertCard({ alert, onDismiss }: { alert: SipSuggestion; onDismiss: () => void }) {
  const t = useTheme();
  const formatInr = useMoney();
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <IconTile name="trending-up" hot />
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>Looks like a SIP</Text>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
            {[alert.scheme, alert.amount_minor ? formatInr(alert.amount_minor) : null, formatDateTime(alert.seen_at)].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>Which fund is it, and how much each month?</Text>
      <View style={[styles.actions, { borderTopColor: t.border }]}>
        <Text
          style={[styles.action, { color: t.link }]}
          onPress={() =>
            router.push({ pathname: "/sip", params: { suggestion: alert.id, scheme: alert.scheme ?? "", ...(alert.amount_minor ? { amount: String(alert.amount_minor) } : {}) } })
          }
        >
          Add as SIP
        </Text>
        <Text style={[styles.action, { color: t.muted }]} onPress={onDismiss}>
          Not a SIP
        </Text>
      </View>
    </View>
  );
}

function ReviewCard({ txn, onAnswer }: { txn: Transaction; onAnswer: (t: Transaction, p: TransactionPatch, what: string) => void }) {
  const t = useTheme();
  const formatInr = useMoney();
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
});
