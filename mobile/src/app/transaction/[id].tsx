import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, View } from "react-native";
import { CyberButton } from "@/components/cyber";
import { PixelIcon } from "@/components/pixel-icon";
import { Text, TextInput } from "@/components/text";
import { Button, CategoryPicker, Chip, HeaderButton, inputStyle, Row, Section } from "@/components/ui";
import {
  addRefund, addTransaction, ApiError, deleteRefund, deleteTransaction, getTransaction, parseRupees, updateTransaction, type TransactionDetail, type TransactionPatch,
} from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { formatDateTime, payeeName, REVIEW_PROMPT } from "@/lib/format";
import { useOnLedgerChange } from "@/lib/events";
import { haptic } from "@/lib/haptics";
import { useMoney } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";

// How a transaction counts toward totals. Maps onto event_type + excluded.
type Counting = "spend" | "income" | "refund" | "transfer" | "excluded";

function countingOf(t: TransactionDetail): Counting {
  if (t.excluded) return "excluded";
  if (t.event_type === "transfer" || t.event_type === "card_payment") return "transfer";
  if (t.direction === "credit") return t.event_type === "refund" ? "refund" : "income";
  return "spend";
}

function countingPatch(c: Counting, t: TransactionDetail): Pick<TransactionPatch, "event_type" | "excluded"> {
  switch (c) {
    case "excluded": return { excluded: true };
    case "transfer": return { excluded: false, event_type: t.event_type === "card_payment" ? "card_payment" : "transfer" };
    case "refund": return { excluded: false, event_type: "refund" };
    case "income": return { excluded: false, event_type: "income" };
    case "spend": return { excluded: false, event_type: t.event_type === "cash_withdrawal" || t.event_type === "fee" ? t.event_type : "purchase" };
  }
}

export default function TransactionScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useSession();
  const badges = useBadges();
  const money = useMoney();
  const toast = useToast();
  const [txn, setTxn] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable fields.
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [counting, setCounting] = useState<Counting>("spend");
  const [amount, setAmount] = useState("");
  const [remember, setRemember] = useState(true);

  const load = useCallback(async () => {
    if (!session || !id) return;
    try {
      const { transaction: x } = await getTransaction(session, id);
      setTxn(x);
      setLabel(x.label ?? "");
      setCategory(x.category);
      setNote(x.note ?? "");
      setCounting(countingOf(x));
      setAmount(String(x.amount_minor / 100));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "This transaction no longer exists." : "Couldn't load it.");
    }
  }, [session, id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches on mount; state is only set once the request resolves
  useEffect(() => void load(), [load]);
  useOnLedgerChange(() => {
    if (session && id) getTransaction(session, id).then((r) => setTxn(r.transaction), () => {});
  });
  // Coming back from the refund screen: show the new refund (without resetting edits on first focus).
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current && session && id) getTransaction(session, id).then((r) => setTxn(r.transaction), () => {});
      focused.current = true;
    }, [session, id]),
  );

  const manual = txn?.source === "manual";
  const hasPayee = !!(txn?.counterparty || txn?.counterparty_vpa);

  async function save() {
    if (!session || !txn) return;
    const patch: TransactionPatch = {
      label: label.trim() || null,
      category,
      note: note.trim() || null,
      ...countingPatch(counting, txn),
      remember: hasPayee && !manual && remember,
    };
    if (manual) {
      const minor = parseRupees(amount);
      if (!minor) return setError("Enter a valid amount.");
      patch.amount_minor = minor;
    }
    setSaving(true);
    try {
      const r = await updateTransaction(session, txn.id, patch);
      haptic.success();
      badges.refresh();
      if (r.applied_to) {
        // Copied to other payments too, so undoing only this one would be misleading.
        toast({ message: `Saved. Also applied to ${r.applied_to} other payment${r.applied_to === 1 ? "" : "s"} to this payee.` });
      } else {
        const before: TransactionPatch = {
          label: txn.label, category: txn.category, note: txn.note, event_type: txn.event_type, excluded: txn.excluded,
          ...(manual ? { amount_minor: txn.amount_minor } : {}),
          ...(txn.reviewed_at ? {} : { reviewed: false }),
          ...(patch.remember ? { forget: true } : {}),
        };
        toast({
          message: "Saved",
          undo: async () => {
            await updateTransaction(session, txn.id, before).catch(() => toast({ message: "Couldn't undo. Check your connection." }));
            badges.refresh();
          },
        });
      }
      router.back();
    } catch {
      haptic.error();
      setError("Couldn't save. Check your connection.");
    } finally {
      setSaving(false);
    }
  }

  // Deleting is immediate; Undo adds the entry back.
  async function remove() {
    if (!session || !txn) return;
    try {
      await deleteTransaction(session, txn.id);
    } catch {
      haptic.error();
      return setError("Couldn't delete. Check your connection.");
    }
    haptic.warning();
    toast({
      message: `${payeeName(txn)} deleted`,
      undo: () =>
        addTransaction(session, {
          amount_minor: txn.amount_minor, direction: txn.direction, counterparty: txn.label ?? txn.counterparty ?? "Cash", category: txn.category,
          occurred_at: txn.occurred_at, paid_with: txn.institution_name, note: txn.note,
        }).catch(() => toast({ message: "Couldn't restore it. Check your connection." })),
    });
    router.back();
  }

  async function removeRefund(r: TransactionDetail["refunds"][number]) {
    if (!session || !txn) return;
    const reload = async () => setTxn((await getTransaction(session, txn.id)).transaction);
    try {
      await deleteRefund(session, r.id);
      await reload();
      toast({
        message: `${money(r.amount_minor)} refund removed`,
        undo: () => addRefund(session, txn.id, { amount_minor: r.amount_minor, refund_transaction_id: r.refund_txn_id }).then(reload, () => toast({ message: "Couldn't restore it." })),
      });
    } catch {
      toast({ message: "Couldn't remove the refund. Check your connection." });
    }
  }

  if (!txn) {
    return <View style={styles.center}>{error ? <Text style={{ color: t.dangerText }}>{error}</Text> : <ActivityIndicator color={t.muted} />}</View>;
  }

  const credit = txn.direction === "credit";
  const needsReview = !!txn.review_reason && !txn.reviewed_at;
  const options: [Counting, string][] = credit
    ? [["income", "Income"], ["refund", "Refund"], ["transfer", "Own transfer"], ["excluded", "Don't count"]]
    : [["spend", "Spending"], ["transfer", txn.event_type === "card_payment" ? "Card bill" : "Own transfer"], ["excluded", "Don't count"]];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <Stack.Screen options={{ headerRight: () => <HeaderButton label={saving ? "Saving…" : "Save"} icon="check" onPress={save} /> }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text style={[styles.amount, { color: credit ? t.credit : t.text }]}>
            {credit ? "+" : ""}
            {money(txn.amount_minor)}
          </Text>
          {!!txn.refunded_minor && (
            <Text style={{ color: t.muted, fontSize: 14, marginTop: 4 }}>
              {`${money(txn.refunded_minor)} refunded · cost you ${money(txn.amount_minor - txn.refunded_minor)}`}
            </Text>
          )}
          <Text style={[styles.payee, { color: t.text }]} selectable>
            {payeeName(txn)}
          </Text>
          <Text style={{ color: t.muted, fontSize: 14, marginTop: 4 }}>{formatDateTime(txn.occurred_at)}</Text>
          {needsReview && (
            <Text style={{ color: t.dangerText, fontSize: 14, marginTop: 10, fontWeight: "600" }}>{REVIEW_PROMPT[txn.review_reason!]}</Text>
          )}
        </View>

        {error && <Text style={{ color: t.dangerText, marginBottom: 12 }}>{error}</Text>}

        <Section title="Name">
          <TextInput
            style={inputStyle(t)}
            value={label}
            onChangeText={setLabel}
            placeholder={txn.counterparty ?? txn.counterparty_vpa ?? "Who or what was it?"}
            placeholderTextColor={t.muted}
            autoCorrect={false}
          />
        </Section>

        <Section title="Category">
          <CategoryPicker value={category} onChange={(c) => setCategory(c === category ? null : c)} />
        </Section>

        <Section title="Counts as" footer="Own transfers, card bill payments and 'Don't count' are left out of your spending totals.">
          <View style={styles.chips}>
            {options.map(([k, name]) => (
              <Chip key={k} label={name} selected={counting === k} onPress={() => setCounting(k)} />
            ))}
          </View>
        </Section>

        <Section
          title="Refund"
          footer={
            credit
              ? "Link a refund to the purchase it paid back: that purchase then costs less, and this money isn't counted as income."
              : "Got money back for this? Mark the exact amount. Your spending drops by that much."
          }
        >
          {txn.refunds.map((r) =>
            credit ? (
              <Row key={r.id} label="Refund for" value={`${r.purchase_name ?? "Purchase"} · ${money(r.amount_minor)}`} />
            ) : (
              <View key={r.id} style={styles.refund}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{`${money(r.amount_minor)} back`}</Text>
                  <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
                    {r.refund_txn_id ? `${r.credit_name ?? "Credit"} · ${r.credit_at ? formatDateTime(r.credit_at) : ""}` : `Marked ${formatDateTime(r.created_at)}`}
                  </Text>
                </View>
                <Text style={{ color: t.dangerText, fontSize: 14, fontWeight: "600", textDecorationLine: "underline" }} onPress={() => removeRefund(r)}>
                  Remove
                </Text>
              </View>
            ),
          )}
          {credit && txn.refunds[0] ? (
            <Chip label="Open the purchase" icon="external-link" onPress={() => router.push(`/transaction/${txn.refunds[0]!.purchase_id}`)} />
          ) : credit ? (
            <CyberButton title="This is a refund for…" icon={<PixelIcon name="undo" size={18} color={t.text} />} onPress={() => router.push({ pathname: "/refund", params: { credit: txn.id } })} />
          ) : (txn.refunded_minor ?? 0) < txn.amount_minor ? (
            <CyberButton title={txn.refunds.length ? "Add another refund" : "Mark a refund"} icon={<PixelIcon name="undo" size={18} color={t.text} />} onPress={() => router.push({ pathname: "/refund", params: { purchase: txn.id } })} />
          ) : (
            <Text style={{ color: t.muted, fontSize: 14 }}>Fully refunded.</Text>
          )}
        </Section>

        {manual && (
          <Section title="Amount (₹)">
            <TextInput style={inputStyle(t)} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          </Section>
        )}

        <Section title="Note">
          <TextInput
            style={[inputStyle(t), { minHeight: 70, textAlignVertical: "top" }]}
            value={note}
            onChangeText={setNote}
            placeholder="Anything to remember about this"
            placeholderTextColor={t.muted}
            multiline
          />
        </Section>

        {hasPayee && !manual && (
          <Section footer="Future payments to this payee get the same name, category and type automatically.">
            <View style={styles.switchRow}>
              <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>Remember for this payee</Text>
              <Switch value={remember} onValueChange={(v) => { haptic.select(); setRemember(v); }} trackColor={{ true: t.accent }} />
            </View>
          </Section>
        )}

        <Section title="Details">
          <Row label="Bank" value={txn.institution_name ?? "Unknown"} />
          {txn.counterparty_vpa && <Row label="UPI ID" value={txn.counterparty_vpa} />}
          {txn.counterparty && (txn.label || txn.ai_name) && <Row label="From the bank" value={txn.counterparty} />}
          {txn.reference && <Row label="Reference" value={txn.reference} />}
          <Row
            label="Source"
            value={manual ? "Added by you" : `${describeSources(txn.evidence)}${txn.evidence.some((e) => e.parser?.startsWith("llm/")) ? " · read by AI" : ""}`}
          />
          {[...new Set(txn.evidence.map((e) => e.sender).filter((x): x is string => !!x))].map((sender) => (
            <Row key={sender} label="Sender" value={sender} />
          ))}
        </Section>

        <Button title="Save" onPress={save} busy={saving} />
        {manual && <Button title="Delete entry" kind="danger" onPress={remove} style={{ marginTop: 12 }} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  body: { padding: 16, paddingBottom: 48 },
  hero: { alignItems: "center", paddingVertical: 20 },
  amount: { fontSize: 40, fontWeight: "700", fontVariant: ["tabular-nums"] },
  payee: { fontSize: 18, fontWeight: "500", marginTop: 6, textAlign: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  refund: { flexDirection: "row", alignItems: "center", gap: 12 },
});

/** "SMS", "Email", "SMS + email" or "2 SMS + email": which messages back this transaction. */
function describeSources(evidence: { source_type: string }[]) {
  const sms = evidence.filter((e) => e.source_type === "sms").length;
  const email = evidence.filter((e) => e.source_type === "email").length;
  const parts = [sms ? `${sms > 1 ? `${sms} ` : ""}SMS` : null, email ? `${email > 1 ? `${email} emails` : "email"}` : null].filter(Boolean) as string[];
  const text = parts.join(" + ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
