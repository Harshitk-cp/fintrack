import { router } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { CyberButton, Meter, MiniBars, PixelLabel, PressScale, Reveal } from "@/components/cyber";
import { PixelIcon } from "@/components/pixel-icon";
import { Text } from "@/components/text";
import { Card, Chip } from "@/components/ui";
import {
  getBudgets, getSips, getSubscriptions, getSummary, getTransactions, setSipPaid, type Budgets, type SipState, type Subscriptions, type Summary, type Transaction,
} from "@/lib/api";
import { category, categoryLabel } from "@/lib/categories";
import { TZ } from "@/lib/format";
import { useMoney } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { alpha, FONT, PALETTE, RADIUS, useTheme, type Theme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

/** The month in detail: what came in, where it went (needs, wants, savings, categories) and SIPs. */
export default function InsightsScreen() {
  const t = useTheme();
  const formatInr = useMoney();
  const { session } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sips, setSips] = useState<SipState | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budgets | null>(null);
  const [subs, setSubs] = useState<Subscriptions | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    const [s, p, l, b, u] = await Promise.all([
      getSummary(session).catch(() => null), getSips(session).catch(() => null), getTransactions(session, { limit: 200 }).catch(() => null),
      getBudgets(session).catch(() => null), getSubscriptions(session).catch(() => null),
    ]);
    if (s) setSummary(s);
    if (p) setSips(p);
    if (l) setTxns(l.transactions);
    if (b) setBudgets(b);
    if (u) setSubs(u);
  }, [session]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  if (!summary) return <View style={{ flex: 1 }} />;
  const earned = summary.income_minor ?? summary.received_minor;
  const spent = summary.net_spent_minor;
  const saved = summary.saved_minor;
  const left = earned - spent - saved;
  const monthName = new Date(`${summary.month}-01T12:00:00Z`).toLocaleString("en-IN", { month: "long", timeZone: TZ });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}
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
          progressBackgroundColor={t.card}
        />
      }
    >
      <Reveal index={0} style={styles.grid}>
        <Tile label={summary.income_minor ? "Salary" : "Received"} value={earned} tone="vista" t={t} />
        <Tile label="Spent" value={spent} tone="ink" t={t} />
        <Tile label="Saved" value={saved} tone="accent" t={t} />
        <Tile label={left >= 0 ? "Left" : "Over"} value={Math.abs(left)} tone="paper" t={t} />
      </Reveal>
      {!summary.income_minor && (
        <Text style={[styles.hint, { color: t.muted }]} onPress={() => router.navigate("/settings")}>
          Add your monthly salary in Settings to measure the month against it.
        </Text>
      )}

      <Reveal index={1}>
        <Card style={{ gap: 14 }}>
          <PixelLabel right={monthName.slice(0, 3)} style={{ marginBottom: 0 }}>Where it went</PixelLabel>
          <SplitBar buckets={summary.buckets} t={t} />
          <View style={{ gap: 10 }}>
            <Legend color={t.ink} label="Needs" hint="rent, bills, groceries, travel to work, health" value={summary.buckets.needs} earned={earned} t={t} />
            <Legend color={t.accent} label="Wants" hint="eating out, shopping, trips, fun" value={summary.buckets.wants} earned={earned} t={t} />
            <Legend color={t.vista} label="Savings" hint="SIPs and investments" value={summary.buckets.savings} earned={earned} t={t} />
            {summary.buckets.unsorted > 0 && (
              <Legend color={alpha(PALETTE.oxford, 0.25)} label="Not sorted yet" hint="answer these in Review" value={summary.buckets.unsorted} earned={earned} t={t} />
            )}
          </View>
        </Card>
      </Reveal>

      <Reveal index={2}>
        <SipCard state={sips} onChange={setSips} t={t} />
      </Reveal>

      {subs && subs.subscriptions.some((s) => s.active) && (
        <Reveal index={3}>
          <PressScale onPress={() => router.push("/subscriptions")} accessibilityLabel="Open subscriptions">
            <Card style={styles.subs}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={[styles.tag, { color: t.muted }]}>SUBSCRIPTIONS</Text>
                <Text style={[styles.smallValue, { color: t.text }]} adjustsFontSizeToFit numberOfLines={1}>
                  {formatInr(subs.monthly_total_minor)}
                  <Text style={{ fontSize: 13, color: t.muted }}> /mo</Text>
                </Text>
                <Text style={{ color: t.muted, fontSize: 13 }}>
                  {(() => {
                    const n = subs.subscriptions.filter((s) => s.active).length;
                    const up = subs.subscriptions.filter((s) => s.active && s.previous_minor !== null && s.amount_minor > s.previous_minor).length;
                    return `${n} active${up ? ` · ${up} went up` : ""}`;
                  })()}
                </Text>
              </View>
              <PixelIcon name="chevron-right" size={20} color={t.muted} />
            </Card>
          </PressScale>
        </Reveal>
      )}

      <Reveal index={4}>
        <Card style={{ gap: 14 }}>
          <PixelLabel right={budgets?.budgets.length ? "spent / budget" : undefined} style={{ marginBottom: 0 }}>By category</PixelLabel>
          {summary.by_category.length === 0 && <Text style={{ color: t.muted, fontSize: 14 }}>No spending yet this month.</Text>}
          {summary.by_category.map((c, i) => {
            const cat = category(c.category);
            const max = Math.max(1, ...summary.by_category.map((x) => x.spent_minor));
            const limit = budgets?.budgets.find((b) => b.category === c.category)?.amount_minor;
            const share = limit ? c.spent_minor / limit : null;
            return (
              <View key={c.category ?? "none"} style={{ gap: 6 }}>
                <View style={styles.row}>
                  <View style={styles.rowName}>
                    <PixelIcon name={cat?.icon ?? "warning-diamond"} size={16} color={t.text} />
                    <Text style={{ color: t.text, fontSize: 14 }}>{categoryLabel(c.category)}</Text>
                  </View>
                  <Text style={[styles.amount, { color: t.text }]}>
                    {formatInr(c.spent_minor)}
                    {limit ? <Text style={{ color: t.muted, fontWeight: "400" }}>{` / ${formatInr(limit)}`}</Text> : null}
                  </Text>
                </View>
                {/* With a budget the bar fills towards the limit; without one it compares categories. */}
                <Meter
                  value={share ?? c.spent_minor / max}
                  height={6}
                  delay={150 + i * 60}
                  color={share !== null ? (share >= 0.8 ? t.accent : t.text) : i === 0 || !cat ? t.accent : t.text}
                />
              </View>
            );
          })}
          <Text style={[styles.link, { color: t.link }]} onPress={() => router.push("/budgets")}>
            {budgets?.budgets.length ? "Edit category budgets" : "Set category budgets"}
          </Text>
        </Card>
      </Reveal>

      <Reveal index={5} style={styles.pair}>
        <Card style={styles.small}>
          <Text style={[styles.tag, { color: t.muted }]}>LAST 7 DAYS</Text>
          <WeekBars txns={txns} />
        </Card>
        <Card tone="vista" style={styles.small}>
          <Text style={[styles.tag, { color: t.text }]}>RECEIVED</Text>
          <Text style={[styles.smallValue, { color: t.text }]} adjustsFontSizeToFit numberOfLines={1}>{formatInr(summary.received_minor)}</Text>
          {summary.refunds_minor > 0 && <Text style={{ color: t.text, fontSize: 12 }}>+ {formatInr(summary.refunds_minor)} refunds</Text>}
        </Card>
      </Reveal>

      {summary.by_bank.length > 1 && (
        <Reveal index={6}>
          <Card style={{ gap: 8 }}>
            <PixelLabel style={{ marginBottom: 2 }}>By bank</PixelLabel>
            {summary.by_bank.map((b) => (
              <View key={b.institution_name} style={styles.row}>
                <Text style={{ color: t.muted, fontSize: 14 }}>{b.institution_name}</Text>
                <Text style={[styles.amount, { color: t.muted }]}>{formatInr(b.spent_minor)}</Text>
              </View>
            ))}
          </Card>
        </Reveal>
      )}
    </ScrollView>
  );
}

function Tile({ label, value, tone, t }: { label: string; value: number; tone: "ink" | "accent" | "vista" | "paper"; t: Theme }) {
  const formatInr = useMoney();
  const ink = tone === "ink";
  return (
    <Card tone={tone} style={styles.tile}>
      <Text style={[styles.tag, { color: ink ? t.inkMuted : t.text }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.tileValue, { color: ink ? t.onInk : t.text }]} adjustsFontSizeToFit numberOfLines={1}>
        {formatInr(value)}
      </Text>
    </Card>
  );
}

function SplitBar({ buckets, t }: { buckets: Summary["buckets"]; t: Theme }) {
  const parts = [
    { v: buckets.needs, c: t.ink },
    { v: buckets.wants, c: t.accent },
    { v: buckets.savings, c: t.vista },
    { v: buckets.unsorted, c: alpha(PALETTE.oxford, 0.25) },
  ].filter((p) => p.v > 0);
  if (!parts.length) return <View style={[styles.split, { backgroundColor: alpha(PALETTE.oxford, 0.08) }]} />;
  return (
    <View style={styles.split}>
      {parts.map((p, i) => (
        <View key={i} style={{ flex: p.v, backgroundColor: p.c }} />
      ))}
    </View>
  );
}

function Legend({ color, label, hint, value, earned, t }: { color: string; label: string; hint: string; value: number; earned: number; t: Theme }) {
  const formatInr = useMoney();
  return (
    <View style={styles.row}>
      <View style={[styles.rowName, { flex: 1 }]}>
        <View style={[styles.swatch, { backgroundColor: color }]} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{label}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>{hint}</Text>
        </View>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[styles.amount, { color: t.text }]}>{formatInr(value)}</Text>
        {earned > 0 && <Text style={{ color: t.muted, fontSize: 12 }}>{Math.round((value / earned) * 100)}% of earned</Text>}
      </View>
    </View>
  );
}

function SipCard({ state, onChange, t }: { state: SipState | null; onChange: (s: SipState) => void; t: Theme }) {
  const { session } = useSession();
  const formatInr = useMoney();
  const active = state?.sips.filter((s) => s.active) ?? [];
  const paidTotal = active.reduce((sum, s) => sum + (s.paid?.amount_minor ?? 0), 0);
  const planned = active.reduce((sum, s) => sum + s.amount_minor, 0);
  return (
    <Card style={{ gap: 12 }}>
      <PixelLabel right={active.length ? `${formatInr(paidTotal)} / ${formatInr(planned)}` : undefined} style={{ marginBottom: 0 }}>
        SIPs this month
      </PixelLabel>
      {active.length === 0 && (
        <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
          Add your SIPs to count them as savings. SIP alerts from your bank or fund are picked up too.
        </Text>
      )}
      {active.map((s) => (
        <View key={s.id} style={styles.sipRow}>
          <PressScale onPress={() => router.push({ pathname: "/sip", params: { id: s.id } })} style={{ flex: 1 }} accessibilityLabel={`Edit ${s.name}`}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>{s.name}</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>
              {formatInr(s.amount_minor)}
              {s.day_of_month ? ` · around the ${ordinal(s.day_of_month)}` : ""}
              {s.paid?.transaction_id ? " · matched to a bank debit" : ""}
            </Text>
          </PressScale>
          <Chip
            label={s.paid ? "Paid ✓" : "Mark paid"}
            selected={!!s.paid}
            onPress={async () => {
              if (!session || !state) return;
              const next = await setSipPaid(session, s.id, state.month, !s.paid).catch(() => null);
              if (next) onChange(next);
            }}
          />
        </View>
      ))}
      {!!state?.suggestions.length && (
        <Text style={{ color: t.link, fontSize: 14, fontWeight: "600", textDecorationLine: "underline" }} onPress={() => router.navigate("/review")}>
          {state.suggestions.length === 1 ? "1 SIP alert needs" : `${state.suggestions.length} SIP alerts need`} your input
        </Text>
      )}
      <CyberButton title="Add SIP" kind="primary" icon={<PixelIcon name="plus" size={18} color={t.text} />} onPress={() => router.push("/sip")} />
    </Card>
  );
}

function WeekBars({ txns }: { txns: Transaction[] }) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const dayFmt = new Intl.DateTimeFormat("en-IN", { weekday: "narrow", timeZone: TZ });
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000));
  const index = new Map(days.map((d, i) => [key.format(d), i]));
  const values = days.map(() => 0);
  for (const x of txns) {
    const i = index.get(key.format(new Date(x.occurred_at)));
    const spend = x.direction === "debit" && !x.excluded && x.category !== "investments" && !["card_payment", "transfer", "cash_withdrawal"].includes(x.event_type);
    if (i !== undefined && spend) values[i]! += x.amount_minor;
  }
  return <MiniBars values={values} labels={days.map((d) => dayFmt.format(d))} height={34} />;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 48, gap: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: { width: "47%", flexGrow: 1, minHeight: 96, justifyContent: "space-between", gap: 8 },
  tileValue: { fontFamily: FONT.display, fontSize: 20 },
  tag: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 1.6 },
  hint: { fontSize: 13, marginHorizontal: 6, textDecorationLine: "underline" },
  split: { height: 14, borderRadius: RADIUS.pill, overflow: "hidden", flexDirection: "row" },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  rowName: { flexDirection: "row", alignItems: "center", gap: 10 },
  amount: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sipRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  pair: { flexDirection: "row", gap: 12 },
  small: { flex: 1, minHeight: 118, justifyContent: "space-between", gap: 8 },
  smallValue: { fontFamily: FONT.display, fontSize: 22 },
  subs: { flexDirection: "row", alignItems: "center", gap: 12 },
  link: { fontSize: 14, fontWeight: "600", textDecorationLine: "underline" },
});
