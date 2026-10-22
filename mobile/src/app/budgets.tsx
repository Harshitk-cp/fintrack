import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { CyberButton, Meter, PixelLabel, PressScale, ThinkingDots } from "@/components/cyber";
import { Text, TextInput } from "@/components/text";
import { Card, IconTile, inputStyle } from "@/components/ui";
import { deleteBudget, getBudgets, getSummary, parseRupees, setBudget, type Budgets } from "@/lib/api";
import { CATEGORIES } from "@/lib/categories";
import { haptic } from "@/lib/haptics";
import { useMoney } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

// Income and investments aren't spending, so they can't have a spending limit.
const SPEND = CATEGORIES.filter((c) => c.id !== "income" && c.id !== "investments");

/** A monthly limit per category, with a calm note at 80% and at 100%. */
export default function BudgetsScreen() {
  const t = useTheme();
  const money = useMoney();
  const toast = useToast();
  const { session } = useSession();
  const [data, setData] = useState<Budgets | null>(null);
  const [spent, setSpent] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    const [b, s] = await Promise.all([getBudgets(session).catch(() => null), getSummary(session).catch(() => null)]);
    if (b) setData(b);
    if (s) setSpent(Object.fromEntries(s.by_category.map((c) => [c.category ?? "none", c.spent_minor])));
  }, [session]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  if (!data) return <View style={styles.center}><ThinkingDots color={t.muted} /></View>;
  const budgetOf = (id: string) => data.budgets.find((b) => b.category === id);
  // Categories with a budget first, then the ones you spend most on.
  const order = [...SPEND].sort((a, b) => Number(!!budgetOf(b.id)) - Number(!!budgetOf(a.id)) || (spent[b.id] ?? 0) - (spent[a.id] ?? 0));

  async function save(id: string) {
    const minor = parseRupees(draft);
    if (!session || !minor) return;
    setBusy(true);
    try {
      setData(await setBudget(session, id, minor));
      haptic.success();
      setEditing(null);
    } catch {
      haptic.error();
      toast({ message: "Couldn't save the budget. Check your connection." });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const was = budgetOf(id);
    if (!session || !was) return;
    try {
      setData(await deleteBudget(session, id));
      setEditing(null);
      toast({
        message: `${CATEGORIES.find((c) => c.id === id)?.name} budget removed`,
        undo: async () => {
          const back = await setBudget(session, id, was.amount_minor).catch(() => null);
          if (back) setData(back);
        },
      });
    } catch {
      toast({ message: "Couldn't remove it. Check your connection." });
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.intro, { color: t.muted }]}>
          {"Set a monthly limit for any category. You'll get a calm note when one reaches 80%, and again if it reaches its limit. Nothing more."}
        </Text>
        <PixelLabel>This month</PixelLabel>
        <View style={{ gap: 10 }}>
          {order.map((c) => {
            const b = budgetOf(c.id);
            const used = b ? b.spent_minor : (spent[c.id] ?? 0);
            const share = b ? b.spent_minor / b.amount_minor : 0;
            const isEditing = editing === c.id;
            return (
              <PressScale
                key={c.id}
                onPress={() => {
                  setEditing(isEditing ? null : c.id);
                  setDraft(b ? String(b.amount_minor / 100) : "");
                }}
                accessibilityLabel={`${c.name}${b ? `, ${money(used)} of ${money(b.amount_minor)}` : ", no budget"}`}
              >
                <Card style={styles.card}>
                  <View style={styles.top}>
                    <IconTile name={c.icon} hot={share >= 1} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{c.name}</Text>
                      <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
                        {b ? `${money(used)} of ${money(b.amount_minor)} · ${Math.round(share * 100)}%` : used ? `${money(used)} spent · no budget` : "No budget"}
                      </Text>
                    </View>
                    <Text style={{ color: t.text, fontSize: 14, fontWeight: "600", textDecorationLine: "underline" }}>{b ? "Edit" : "Set"}</Text>
                  </View>
                  {b && <Meter value={share} height={6} color={share >= 0.8 ? t.accent : t.text} />}
                  {isEditing && (
                    <View style={[styles.edit, { borderTopColor: t.border }]}>
                      <TextInput
                        style={[inputStyle(t), { flex: 1 }]}
                        value={draft}
                        onChangeText={setDraft}
                        placeholder="Monthly limit ₹"
                        placeholderTextColor={t.muted}
                        keyboardType="number-pad"
                        autoFocus
                        returnKeyType="done"
                        onSubmitEditing={() => save(c.id)}
                        accessibilityLabel={`${c.name} monthly budget in rupees`}
                      />
                      <CyberButton title="Save" kind="solid" busy={busy} disabled={!parseRupees(draft)} onPress={() => save(c.id)} style={{ width: 130 }} />
                      {b && (
                        <Text style={[styles.remove, { color: t.dangerText }]} onPress={() => remove(c.id)}>
                          Remove budget
                        </Text>
                      )}
                    </View>
                  )}
                </Card>
              </PressScale>
            );
          })}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: 16, paddingBottom: 48 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 18, marginHorizontal: 4 },
  card: { gap: 12, paddingVertical: 14 },
  top: { flexDirection: "row", alignItems: "center", gap: 12 },
  edit: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  remove: { flexBasis: "100%", fontSize: 14, fontWeight: "600", textDecorationLine: "underline", marginTop: 4 },
});
