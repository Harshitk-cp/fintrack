import { router, Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/text";
import { Gauge, Meter, MiniBars, PixelLabel, PressScale, Reveal, useCountUp, Wordmark } from "@/components/cyber";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PixelIcon } from "@/components/pixel-icon";
import { Card, Empty, HeaderButton, TxnRow } from "@/components/ui";
import { ApiError, formatInr, getSummary, getTransactions, type Summary, type Transaction } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { category, categoryLabel } from "@/lib/categories";
import { TZ } from "@/lib/format";
import { useSession } from "@/lib/session";
import { FONT, RADIUS, TAB_BAR_SPACE, useTheme, type Theme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

export default function HomeScreen() {
  const t = useTheme();
  const { session, signOut } = useSession();
  const badges = useBadges();
  const insets = useSafeAreaInsets();
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
      {/* Own header: the system one draws iOS glass circles behind its buttons, which clash with the theme. */}
      <Stack.Screen options={{ headerShown: false }} />
      <SectionList
        sections={groupByDay(txns ?? [])}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} />}
        contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={{ paddingTop: insets.top + 6 }}>
            <View style={styles.header}>
              <HeaderButton label="Inbox" icon="bell" badge={badges.unread} onPress={() => router.push("/inbox")} />
              <Wordmark size={20} />
              <HeaderButton label="Add" icon="plus" onPress={() => router.push("/add")} />
            </View>
            <View style={[styles.search, { borderColor: t.border, backgroundColor: t.inputBg }]}>
              <PixelIcon name="search" size={18} color={t.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search payee, note or bank"
                placeholderTextColor={t.muted}
                returnKeyType="search"
                autoCorrect={false}
                clearButtonMode="while-editing"
                style={[styles.searchInput, { color: t.text }]}
                accessibilityLabel="Search transactions"
              />
            </View>
            {error && <Text style={[styles.error, { color: t.dangerText }]}>{error}</Text>}
            {summary && !searching && <SummaryBento summary={summary} txns={txns ?? []} t={t} />}
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

const isSpendTxn = (x: Transaction) =>
  x.direction === "debit" && !x.excluded && !["card_payment", "transfer", "cash_withdrawal"].includes(x.event_type);

/** Spending per day for the last 7 days (oldest first), from the loaded transactions. */
function lastSevenDays(txns: Transaction[]) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const day = new Intl.DateTimeFormat("en-IN", { weekday: "narrow", timeZone: TZ });
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => new Date(now - (6 - i) * 86_400_000));
  const index = new Map(days.map((d, i) => [key.format(d), i]));
  const values = days.map(() => 0);
  for (const x of txns) {
    const i = index.get(key.format(new Date(x.occurred_at)));
    if (i !== undefined && isSpendTxn(x)) values[i]! += x.amount_minor;
  }
  return { values, labels: days.map((d) => day.format(d)) };
}

function SummaryBento({ summary, txns, t }: { summary: Summary; txns: Transaction[]; t: Theme }) {
  const monthName = new Date(`${summary.month}-01T12:00:00Z`).toLocaleString("en-IN", { month: "long", timeZone: TZ });
  const budget = summary.budget_minor;
  const total = useCountUp(summary.net_spent_minor);
  // The dial shows budget used; without a budget it shows how far through the month we are.
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dial = budget ? summary.net_spent_minor / budget : today.getDate() / daysInMonth;
  const dialTag = budget ? `${Math.round((summary.net_spent_minor / budget) * 100)}% of budget` : `Day ${today.getDate()}/${daysInMonth}`;
  const week = lastSevenDays(txns);
  const maxCat = Math.max(1, ...summary.by_category.map((c) => c.spent_minor));

  return (
    <View style={styles.bento}>
      <Reveal index={0}>
        <Card tone="ink" style={styles.hero}>
          <View style={styles.heroTop}>
            <Text style={[styles.tag, { color: t.inkMuted }]}>{`SPENT · ${monthName.toUpperCase()}`}</Text>
            <View style={[styles.pill, { backgroundColor: budget && dial > 1 ? t.accent : t.onInk }]}>
              <Text style={[styles.pillText, { color: t.ink }]}>{dialTag.toUpperCase()}</Text>
            </View>
          </View>
          <View style={{ alignItems: "center" }}>
            <Gauge value={dial} size={230}>
              <Text style={[styles.heroTotal, { color: t.onInk }]} adjustsFontSizeToFit numberOfLines={1}>
                {formatInr(Math.round(total))}
              </Text>
              <Text style={{ color: t.inkMuted, fontSize: 13, marginTop: 2 }}>
                {summary.transaction_count} payment{summary.transaction_count === 1 ? "" : "s"}
              </Text>
            </Gauge>
          </View>
          {budget !== null && (
            <Text style={{ color: t.inkMuted, fontSize: 13, textAlign: "center", marginTop: -8 }}>
              {summary.net_spent_minor > budget
                ? `${formatInr(summary.net_spent_minor - budget)} over your ${formatInr(budget)} budget`
                : `${formatInr(budget - summary.net_spent_minor)} left of ${formatInr(budget)}`}
            </Text>
          )}
        </Card>
      </Reveal>

      <View style={styles.pair}>
        <Reveal index={1} style={{ flex: 1 }}>
          <Card tone="vista" style={styles.small}>
            <Text style={[styles.tag, { color: t.text }]}>RECEIVED</Text>
            <Text style={[styles.smallValue, { color: t.text }]} adjustsFontSizeToFit numberOfLines={1}>{formatInr(summary.received_minor)}</Text>
            {summary.refunds_minor > 0 && <Text style={{ color: t.text, fontSize: 12 }}>+ {formatInr(summary.refunds_minor)} refunds</Text>}
          </Card>
        </Reveal>
        <Reveal index={2} style={{ flex: 1 }}>
          <Card style={styles.small}>
            <Text style={[styles.tag, { color: t.muted }]}>7 DAYS</Text>
            <MiniBars values={week.values} labels={week.labels} height={34} />
          </Card>
        </Reveal>
      </View>

      {summary.review_count > 0 && (
        <Reveal index={3}>
          <PressScale onPress={() => router.navigate("/review")} accessibilityLabel="Open review">
            <Card tone="accent" style={styles.review}>
              <Text style={[styles.reviewCount, { color: t.onAccent }]}>{summary.review_count}</Text>
              <Text style={[styles.reviewText, { color: t.onAccent }]}>
                {`PAYMENT${summary.review_count === 1 ? "" : "S"} NEED${summary.review_count === 1 ? "S" : ""}\nYOUR INPUT`}
              </Text>
              <View style={[styles.reviewDisc, { backgroundColor: t.ink }]}>
                <PixelIcon name="arrow-right" size={20} color={t.onInk} />
              </View>
            </Card>
          </PressScale>
        </Reveal>
      )}

      {summary.by_category.length > 0 && (
        <Reveal index={4}>
          <Card style={{ gap: 14 }}>
            <PixelLabel right={monthName.slice(0, 3)} style={{ marginBottom: 0 }}>Where it went</PixelLabel>
            {summary.by_category.slice(0, 6).map((c, i) => {
              const cat = category(c.category);
              return (
                <View key={c.category ?? "none"} style={{ gap: 6 }}>
                  <View style={styles.catRow}>
                    <View style={styles.catName}>
                      <PixelIcon name={cat?.icon ?? "warning-diamond"} size={16} color={t.text} />
                      <Text style={{ color: t.text, fontSize: 14 }}>{categoryLabel(c.category)}</Text>
                    </View>
                    <Text style={[styles.catAmount, { color: t.text }]}>{formatInr(c.spent_minor)}</Text>
                  </View>
                  <Meter value={c.spent_minor / maxCat} height={6} delay={200 + i * 80} color={i === 0 || !cat ? t.accent : t.text} />
                </View>
              );
            })}
            {summary.by_bank.length > 1 && (
              <View style={[styles.banks, { borderTopColor: t.border }]}>
                {summary.by_bank.map((bank) => (
                  <View key={bank.institution_name} style={styles.catRow}>
                    <Text style={{ color: t.muted, fontSize: 13 }}>{bank.institution_name}</Text>
                    <Text style={[styles.catAmount, { color: t.muted, fontSize: 13 }]}>{formatInr(bank.spent_minor)}</Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </Reveal>
      )}
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
  error: { marginHorizontal: 16, marginTop: 12, fontSize: 14, fontWeight: "600" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, height: 52 },
  search: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 6, paddingHorizontal: 16, height: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.pill },
  searchInput: { flex: 1, fontSize: 16 },
  bento: { padding: 16, gap: 12 },
  hero: { padding: 20, gap: 4 },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroTotal: { fontFamily: FONT.display, fontSize: 34, maxWidth: 170, textAlign: "center" },
  tag: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 1.6 },
  pill: { borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontFamily: FONT.pixel, fontSize: 9, letterSpacing: 1 },
  pair: { flexDirection: "row", gap: 12 },
  small: { flex: 1, minHeight: 118, justifyContent: "space-between", gap: 8 },
  smallValue: { fontFamily: FONT.display, fontSize: 22 },
  review: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 },
  reviewCount: { fontFamily: FONT.display, fontSize: 40, lineHeight: 46 },
  reviewText: { flex: 1, fontFamily: FONT.pixel, fontSize: 11, letterSpacing: 1.4, lineHeight: 16 },
  reviewDisc: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  catRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  catName: { flexDirection: "row", alignItems: "center", gap: 8 },
  catAmount: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  banks: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 6 },
  day: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 2, marginTop: 18, marginBottom: 10, marginHorizontal: 22, textTransform: "uppercase" },
});
