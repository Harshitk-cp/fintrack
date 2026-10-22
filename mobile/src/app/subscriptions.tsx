import { router } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { PixelLabel, PressScale, Reveal, ThinkingDots } from "@/components/cyber";
import { Text } from "@/components/text";
import { Card, Chip, Empty, IconTile } from "@/components/ui";
import { getSubscriptions, setSubscriptionHidden, type Subscription, type Subscriptions } from "@/lib/api";
import { category } from "@/lib/categories";
import { TZ } from "@/lib/format";
import { useMoney } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { FONT, RADIUS, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TZ });

/** Recurring charges found in your payments: what they cost a month and a year, and which ones went up. */
export default function SubscriptionsScreen() {
  const t = useTheme();
  const money = useMoney();
  const toast = useToast();
  const { session } = useSession();
  const [data, setData] = useState<Subscriptions | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (session) await getSubscriptions(session).then(setData, () => {});
  }, [session]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  async function hide(s: Subscription) {
    if (!session || !data) return;
    setData({ ...data, subscriptions: data.subscriptions.filter((x) => x.key !== s.key) }); // optimistic
    setOpen(null);
    try {
      await setSubscriptionHidden(session, s.key, true);
      toast({
        message: `${s.name} hidden from subscriptions`,
        undo: async () => {
          await setSubscriptionHidden(session, s.key, false).catch(() => {});
          await load();
        },
      });
      await load();
    } catch {
      toast({ message: "Couldn't hide it. Check your connection." });
      await load();
    }
  }

  if (!data) return <View style={styles.center}><ThinkingDots color={t.muted} /></View>;
  const active = data.subscriptions.filter((s) => s.active);
  const stopped = data.subscriptions.filter((s) => !s.active);
  const raised = active.filter((s) => s.previous_minor !== null && s.amount_minor > s.previous_minor);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />
      }
    >
      <Reveal index={0}>
        <Card tone="ink" style={styles.hero}>
          <Text style={[styles.tag, { color: t.inkMuted }]}>{`${active.length} ACTIVE · PER MONTH`}</Text>
          <Text style={[styles.total, { color: t.onInk }]} adjustsFontSizeToFit numberOfLines={1}>{money(data.monthly_total_minor)}</Text>
          <Text style={{ color: t.inkMuted, fontSize: 14 }}>{`${money(data.yearly_total_minor)} a year`}</Text>
        </Card>
      </Reveal>

      {raised.length > 0 && (
        <Reveal index={1}>
          <Card tone="vista" style={{ gap: 10 }}>
            <Text style={[styles.tag, { color: t.text }]}>PRICE WENT UP</Text>
            {raised.map((s) => (
              <Text key={s.key} style={{ color: t.text, fontSize: 15 }}>
                <Text style={{ fontWeight: "700" }}>{s.name}</Text>
                {`  ${money(s.previous_minor!)} → ${money(s.amount_minor)}`}
              </Text>
            ))}
          </Card>
        </Reveal>
      )}

      {active.length === 0 && stopped.length === 0 && (
        <Empty icon="repeat" title="None found yet" body="Payments that repeat every month or year show up here once they've charged you a couple of times." />
      )}

      {active.length > 0 && (
        <Reveal index={2}>
          <PixelLabel style={{ marginTop: 6 }}>Active</PixelLabel>
          <View style={{ gap: 10 }}>
            {active.map((s) => (
              <Row key={s.key} s={s} open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} onHide={() => hide(s)} />
            ))}
          </View>
        </Reveal>
      )}

      {stopped.length > 0 && (
        <Reveal index={3}>
          <PixelLabel style={{ marginTop: 14 }} right="no recent charge">Looks stopped</PixelLabel>
          <View style={{ gap: 10 }}>
            {stopped.map((s) => (
              <Row key={s.key} s={s} open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} onHide={() => hide(s)} />
            ))}
          </View>
        </Reveal>
      )}

      <Text style={[styles.note, { color: t.muted }]}>
        Worked out from your payments: the same payee, about the same amount, every month or year.
        {data.hidden ? ` ${data.hidden} hidden by you.` : ""}
      </Text>
    </ScrollView>
  );
}

function Row({ s, open, onToggle, onHide }: { s: Subscription; open: boolean; onToggle: () => void; onHide: () => void }) {
  const t = useTheme();
  const money = useMoney();
  const up = s.previous_minor !== null && s.amount_minor > s.previous_minor;
  const per = s.cadence === "monthly" ? "/mo" : "/yr";
  return (
    <PressScale onPress={onToggle} accessibilityLabel={`${s.name}, ${money(s.amount_minor)} ${s.cadence}`}>
      <Card style={[styles.row, !s.active && { opacity: 0.7 }]}>
        <View style={styles.rowTop}>
          <IconTile name={category(s.category)?.icon ?? "repeat"} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>{s.name}</Text>
            <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
              {s.active ? `${s.cadence === "monthly" ? "Monthly" : "Yearly"} · next around ${day(s.next_at)}` : `Last charged ${day(s.last_at)}`}
              {s.bank ? ` · ${s.bank}` : ""}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end", gap: 4 }}>
            <Text style={[styles.amount, { color: t.text }]}>
              {money(s.amount_minor)}
              <Text style={{ color: t.muted, fontSize: 12, fontWeight: "400" }}>{per}</Text>
            </Text>
            {up && (
              <View style={[styles.up, { backgroundColor: t.accent }]}>
                <Text style={[styles.upText, { color: t.onAccent }]}>{`UP ${money(s.amount_minor - s.previous_minor!)}`}</Text>
              </View>
            )}
          </View>
        </View>
        {open && (
          <View style={[styles.actions, { borderTopColor: t.border }]}>
            <Text style={{ color: t.muted, fontSize: 13, flexBasis: "100%" }}>
              {`${s.charges} charges found${s.cadence === "yearly" ? ` · about ${money(s.monthly_minor)} a month` : ""}`}
            </Text>
            <Chip label="Last payment" icon="external-link" onPress={() => router.push(`/transaction/${s.transaction_ids[0]}`)} />
            <Chip label="Not a subscription" icon="close" onPress={onHide} />
          </View>
        )}
      </Card>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: 16, paddingBottom: 48, gap: 12 },
  hero: { gap: 6, paddingVertical: 22 },
  tag: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 1.6 },
  total: { fontFamily: FONT.display, fontSize: 36 },
  row: { gap: 12, paddingVertical: 14 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  amount: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  up: { borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 3 },
  upText: { fontFamily: FONT.pixel, fontSize: 8, letterSpacing: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  note: { fontSize: 13, lineHeight: 18, marginTop: 8, marginHorizontal: 6 },
});
