import { router, Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { Empty, HeaderButton, TxnRow } from "@/components/ui";
import { ApiError, formatInr, getSummary, getTransactions, type Summary, type Transaction } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { categoryLabel } from "@/lib/categories";
import { TZ } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useTheme, type Theme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

export default function HomeScreen() {
  const t = useTheme();
  const { session, signOut } = useSession();
  const badges = useBadges();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [s, list] = await Promise.all([getSummary(session), getTransactions(session, { q: query.trim() || undefined })]);
      setSummary(s);
      setTxns(list.transactions);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return signOut(); // token revoked
      setError(e instanceof ApiError && e.code === "network_error" ? "Can't reach the server." : "Couldn't load transactions.");
    }
  }, [session, signOut, query]);

  useRefreshOnActive(useCallback(() => {
    void load();
    badges.refresh();
  }, [load, badges.refresh]));

  // Debounced search.
  useEffect(() => {
    const id = setTimeout(() => void load(), 250);
    return () => clearTimeout(id);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    badges.refresh();
    setRefreshing(false);
  };

  const searching = query.trim().length > 0;
  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => <HeaderButton label="Inbox" badge={badges.unread} onPress={() => router.push("/inbox")} />,
          headerRight: () => <HeaderButton label="Add" onPress={() => router.push("/add")} />,
          headerSearchBarOptions: {
            placeholder: "Search payee, note or bank",
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            onCancelButtonPress: () => setQuery(""),
            hideWhenScrolling: true,
          },
        }}
      />
      <SectionList
        contentInsetAdjustmentBehavior="automatic"
        sections={groupByDay(txns ?? [])}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} />}
        contentContainerStyle={{ paddingBottom: 40 }}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View>
            {error && <Text style={[styles.error, { color: t.danger }]}>{error}</Text>}
            {summary && !searching && <SummaryCard summary={summary} t={t} />}
          </View>
        }
        ListEmptyComponent={
          txns ? (
            searching ? (
              <Empty title="No matches" />
            ) : (
              <Empty title="No transactions yet" body="They'll appear here as bank SMS arrive. Tap Add to enter cash spending." />
            )
          ) : undefined
        }
        renderSectionHeader={({ section }) => <Text style={[styles.day, { color: t.muted }]}>{section.title}</Text>}
        renderItem={({ item, index, section }) => <TxnRow txn={item} first={index === 0} last={index === section.data.length - 1} />}
      />
    </>
  );
}

function SummaryCard({ summary, t }: { summary: Summary; t: Theme }) {
  const monthName = new Date(`${summary.month}-01T12:00:00Z`).toLocaleString("en-IN", { month: "long", timeZone: TZ });
  const budget = summary.budget_minor;
  const pct = budget ? Math.min(summary.net_spent_minor / budget, 1) : 0;
  const over = budget !== null && summary.net_spent_minor > budget;
  const maxCat = Math.max(1, ...summary.by_category.map((c) => c.spent_minor));
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
      <Text style={[styles.cardLabel, { color: t.muted }]}>Spent in {monthName}</Text>
      <Text style={[styles.cardTotal, { color: t.text }]}>{formatInr(summary.net_spent_minor)}</Text>

      {budget !== null && (
        <View style={{ marginTop: 10 }}>
          <View style={[styles.track, { backgroundColor: t.border }]}>
            <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: over ? t.danger : pct > 0.8 ? "#D08A1E" : t.accent }]} />
          </View>
          <Text style={[styles.budgetText, { color: over ? t.danger : t.muted }]}>
            {over
              ? `${formatInr(summary.net_spent_minor - budget)} over your ${formatInr(budget)} budget`
              : `${formatInr(budget - summary.net_spent_minor)} left of ${formatInr(budget)}`}
          </Text>
        </View>
      )}

      <View style={styles.cardRow}>
        <Stat label="Received" value={formatInr(summary.received_minor)} t={t} color={t.credit} />
        {summary.refunds_minor > 0 && <Stat label="Refunds" value={formatInr(summary.refunds_minor)} t={t} />}
        <Stat label="Transactions" value={String(summary.transaction_count)} t={t} />
      </View>

      {summary.review_count > 0 && (
        <Text onPress={() => router.navigate("/review")} style={[styles.reviewLink, { color: t.danger }]}>
          {summary.review_count} transaction{summary.review_count === 1 ? "" : "s"} need{summary.review_count === 1 ? "s" : ""} your input →
        </Text>
      )}

      {summary.by_category.length > 0 && (
        <View style={[styles.breakdown, { borderTopColor: t.border }]}>
          {summary.by_category.slice(0, 6).map((c) => (
            <View key={c.category ?? "none"}>
              <View style={styles.bankRow}>
                <Text style={[styles.bankName, { color: t.text }]}>{categoryLabel(c.category)}</Text>
                <Text style={[styles.bankAmount, { color: t.text }]}>{formatInr(c.spent_minor)}</Text>
              </View>
              <View style={[styles.catTrack]}>
                <View style={[styles.catFill, { width: `${(c.spent_minor / maxCat) * 100}%`, backgroundColor: t.accent }]} />
              </View>
            </View>
          ))}
        </View>
      )}

      {summary.by_bank.length > 1 && (
        <View style={[styles.breakdown, { borderTopColor: t.border }]}>
          {summary.by_bank.map((b) => (
            <View key={b.institution_name} style={styles.bankRow}>
              <Text style={[styles.small, { color: t.muted }]}>{b.institution_name}</Text>
              <Text style={[styles.small, { color: t.muted }]}>{formatInr(b.spent_minor)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Stat({ label, value, t, color }: { label: string; value: string; t: Theme; color?: string }) {
  return (
    <View>
      <Text style={[styles.statLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: color ?? t.text }]}>{value}</Text>
    </View>
  );
}

function groupByDay(txns: Transaction[]) {
  const fmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const today = key.format(new Date());
  const yesterday = key.format(new Date(Date.now() - 86_400_000));
  const sections: { title: string; data: Transaction[] }[] = [];
  let current: string | null = null;
  for (const txn of txns) {
    const d = new Date(txn.occurred_at);
    const k = key.format(d);
    if (k !== current) {
      current = k;
      sections.push({ title: k === today ? "Today" : k === yesterday ? "Yesterday" : fmt.format(d), data: [] });
    }
    sections.at(-1)!.data.push(txn);
  }
  return sections;
}

const styles = StyleSheet.create({
  error: { marginHorizontal: 16, marginTop: 12, fontSize: 14 },
  card: { margin: 16, padding: 20, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  cardLabel: { fontSize: 14, fontWeight: "500" },
  cardTotal: { fontSize: 36, fontWeight: "700", marginTop: 4, fontVariant: ["tabular-nums"] },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  fill: { height: 8, borderRadius: 4 },
  budgetText: { fontSize: 13, marginTop: 6 },
  cardRow: { flexDirection: "row", marginTop: 16, gap: 24 },
  statLabel: { fontSize: 12, fontWeight: "500" },
  statValue: { fontSize: 16, fontWeight: "600", marginTop: 2, fontVariant: ["tabular-nums"] },
  reviewLink: { marginTop: 14, fontSize: 14, fontWeight: "600" },
  breakdown: { marginTop: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  bankRow: { flexDirection: "row", justifyContent: "space-between" },
  bankName: { fontSize: 14 },
  bankAmount: { fontSize: 14, fontVariant: ["tabular-nums"] },
  catTrack: { height: 4, marginTop: 4, borderRadius: 2, overflow: "hidden" },
  catFill: { height: 4, borderRadius: 2, opacity: 0.6 },
  small: { fontSize: 13, fontVariant: ["tabular-nums"] },
  day: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8, marginHorizontal: 20, textTransform: "uppercase", letterSpacing: 0.5 },
});
