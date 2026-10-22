import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import { CyberButton, CyberField, PixelLabel, ThinkingDots } from "@/components/cyber";
import { PixelIcon } from "@/components/pixel-icon";
import { Text, TextInput } from "@/components/text";
import { Card } from "@/components/ui";
import { addRefund, ApiError, deleteRefund, getTransaction, getTransactions, parseRupees, type Transaction, type TransactionDetail } from "@/lib/api";
import { formatDateTime, payeeName } from "@/lib/format";
import { haptic } from "@/lib/haptics";
import { useMoney } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { RADIUS, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";

const DAY = 86_400_000;
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);

/**
 * Marks money back for a purchase. Opened from a purchase (?purchase=), where
 * the refund's credit can be picked, or from a credit (?credit=), where you pick
 * the purchase it paid back. The amount is exactly what came back.
 */
export default function RefundScreen() {
  const t = useTheme();
  const money = useMoney();
  const toast = useToast();
  const { session } = useSession();
  const p = useLocalSearchParams<{ purchase?: string; credit?: string }>();
  const fromCredit = !!p.credit;
  const [anchor, setAnchor] = useState<TransactionDetail | null>(null);
  const [picked, setPicked] = useState<Transaction | null>(null);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Transaction[] | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false); // once the amount is typed, picking doesn't overwrite it

  useEffect(() => {
    const id = p.purchase ?? p.credit;
    if (session && id) getTransaction(session, id).then((r) => setAnchor(r.transaction), () => setError("Couldn't load the transaction."));
  }, [session, p.purchase, p.credit]);

  const purchase = fromCredit ? picked : anchor;
  const remaining = purchase ? purchase.amount_minor - (purchase.refunded_minor ?? 0) : 0;

  // Default amount: what's left to refund, capped by the credit when there is one.
  useEffect(() => {
    if (touched.current || !anchor) return;
    const credit = fromCredit ? anchor : picked;
    const cap = Math.min(...[remaining, credit?.amount_minor].filter((x): x is number => !!x));
    if (Number.isFinite(cap) && cap > 0) setAmount(String(cap / 100)); // eslint-disable-line react-hooks/set-state-in-effect -- derived default the user can still edit
  }, [anchor, picked, remaining, fromCredit]);

  // Purchases before a credit, or credits after a purchase, within about four months.
  const search = useCallback(async () => {
    if (!session || !anchor) return;
    const at = new Date(anchor.occurred_at);
    const window = fromCredit
      ? { direction: "debit" as const, from: ymd(new Date(at.getTime() - 120 * DAY)), to: ymd(at) }
      : { direction: "credit" as const, from: ymd(at), to: ymd(new Date(Math.min(Date.now(), at.getTime() + 120 * DAY))) };
    const r = await getTransactions(session, { ...window, q: q.trim() || undefined, limit: 60 }).catch(() => null);
    if (!r) return;
    // A credit can only pay back one purchase; purchases fully refunded have nothing left.
    setCandidates(r.transactions.filter((x) => (fromCredit ? x.amount_minor > (x.refunded_minor ?? 0) : !x.refund_for_id) && x.id !== anchor.id));
  }, [session, anchor, fromCredit, q]);
  useEffect(() => {
    const id = setTimeout(() => void search(), 250);
    return () => clearTimeout(id);
  }, [search]);

  const minor = parseRupees(amount);
  const credit = fromCredit ? anchor : picked;
  const tooMuch = !!minor && ((!!purchase && minor > remaining) || (!!credit && minor > credit.amount_minor));
  const ready = !!purchase && !!minor && !tooMuch;

  async function save() {
    if (!session || !purchase || !minor) return;
    setBusy(true);
    setError(null);
    try {
      const r = await addRefund(session, purchase.id, { amount_minor: minor, refund_transaction_id: credit?.id ?? null });
      haptic.success();
      toast({ message: `${money(minor)} refund marked on ${payeeName(purchase)}`, undo: () => deleteRefund(session, r.refund_id).catch(() => {}) });
      router.back();
    } catch (e) {
      haptic.error();
      const code = e instanceof ApiError ? e.code : "";
      setError(
        code === "more_than_purchase" ? "That's more than is left to refund on this purchase."
        : code === "more_than_credit" ? "That's more than the refund credit."
        : code === "credit_already_linked" ? "That credit is already linked to another purchase."
        : "Couldn't save. Check your connection.",
      );
      setBusy(false);
    }
  }

  if (!anchor) return <View style={styles.center}>{error ? <Text style={{ color: t.dangerText }}>{error}</Text> : <ThinkingDots color={t.muted} />}</View>;

  const header = (
    <View style={{ gap: 14 }}>
      <Stack.Screen options={{ title: fromCredit ? "Refund for…" : "Mark a refund" }} />
      <Card tone="ink" style={{ gap: 4 }}>
        <Text style={{ color: t.inkMuted, fontSize: 12 }}>{fromCredit ? "MONEY BACK" : "PURCHASE"}</Text>
        <Text style={{ color: t.onInk, fontSize: 22, fontWeight: "700" }}>{money(anchor.amount_minor)}</Text>
        <Text style={{ color: t.onInk, fontSize: 15 }} numberOfLines={1}>{payeeName(anchor)}</Text>
        <Text style={{ color: t.inkMuted, fontSize: 13 }}>
          {formatDateTime(anchor.occurred_at)}
          {!fromCredit && anchor.refunded_minor ? ` · ${money(anchor.refunded_minor)} already refunded` : ""}
        </Text>
      </Card>

      <CyberField label="Amount refunded ₹" value={amount} onChangeText={(v) => { touched.current = true; setAmount(v); }} keyboardType="decimal-pad" placeholder="0" />
      {tooMuch && <Text style={{ color: t.dangerText, fontSize: 13, marginTop: -6 }}>{`At most ${money(Math.min(remaining || Infinity, credit?.amount_minor ?? Infinity))}.`}</Text>}

      <PixelLabel right={fromCredit ? "required" : "optional"} style={{ marginTop: 6, marginBottom: 0 }}>
        {fromCredit ? "Which purchase?" : "The refund credit"}
      </PixelLabel>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18, marginTop: -6 }}>
        {fromCredit
          ? "Pick the purchase this money paid back. Its cost drops by the refund."
          : "If the refund showed up as its own credit, pick it so it isn't counted as money received."}
      </Text>
      <View style={[styles.search, { borderColor: t.border, backgroundColor: t.inputBg }]}>
        <PixelIcon name="search" size={16} color={t.muted} />
        <TextInput value={q} onChangeText={setQ} placeholder={fromCredit ? "Search purchases" : "Search credits"} placeholderTextColor={t.muted} autoCorrect={false} style={{ flex: 1, fontSize: 15, color: t.text }} />
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <FlatList
        data={candidates ?? []}
        keyExtractor={(x) => x.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.body}
        ListHeaderComponent={header}
        ListEmptyComponent={
          candidates ? (
            <Text style={{ color: t.muted, fontSize: 14, textAlign: "center", paddingVertical: 20 }}>
              {fromCredit ? "No purchases in the 4 months before this." : "No credits since this purchase."}
            </Text>
          ) : (
            <View style={{ alignItems: "center", padding: 20 }}><ThinkingDots color={t.muted} /></View>
          )
        }
        renderItem={({ item }) => {
          const on = picked?.id === item.id;
          return (
            <Pressable
              onPress={() => {
                haptic.select();
                setPicked(on ? null : item);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.option, { borderColor: on ? t.ink : t.border, backgroundColor: t.card }, on && { borderWidth: 2 }]}
            >
              <View style={[styles.radio, { borderColor: t.ink }]}>{on && <View style={[styles.radioDot, { backgroundColor: t.accent }]} />}</View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>{payeeName(item)}</Text>
                <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                  {[item.institution_name, formatDateTime(item.occurred_at), item.refunded_minor ? `${money(item.refunded_minor)} refunded` : null].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{money(item.amount_minor)}</Text>
            </Pressable>
          );
        }}
        ListFooterComponent={
          <View style={{ marginTop: 16, gap: 10 }}>
            {error && <Text style={{ color: t.dangerText, fontSize: 14 }}>{error}</Text>}
            <CyberButton title={fromCredit && !picked ? "Pick a purchase" : "Mark refund"} kind="solid" busy={busy} disabled={!ready} onPress={save} />
          </View>
        }
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  body: { padding: 16, paddingBottom: 48, gap: 8 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, height: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.pill, marginBottom: 4 },
  option: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: RADIUS.field, padding: 12 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
