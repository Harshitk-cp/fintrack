import { router, Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/text";
import { CyberButton, Gauge, PressScale, Reveal, useCountUp, Wordmark } from "@/components/cyber";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MailNudge } from "@/components/mail-nudge";
import { PixelIcon } from "@/components/pixel-icon";
import { Card, Empty, HeaderButton, TxnRow } from "@/components/ui";
import { ApiError, formatInr, getSummary, getTransactions, type Summary, type Transaction } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { TZ } from "@/lib/format";
import { groupByDay } from "@/lib/group";
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
      const [s, list] = await Promise.all([getSummary(session), getTransactions(session, { q: query.trim() || undefined, limit: 200 })]);
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
  // Home shows the last 10 days that have transactions (gaps don't count); search covers everything.
  const days = groupByDay(txns ?? []);
  const sections = searching ? days : days.slice(0, HOME_DAYS);
  return (
    // The list starts below the status bar, so nothing scrolls under the clock and the
    // pull-to-refresh spinner isn't hidden behind the notch.
    <View style={{ flex: 1, paddingTop: insets.top }}>
      {/* Own header: the system one draws iOS glass circles behind its buttons, which clash with the theme. */}
      <Stack.Screen options={{ headerShown: false }} />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.card} />
        }
        contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }}
        stickySectionHeadersEnabled={false}
        ListFooterComponent={
          !searching && (txns?.length ?? 0) > 0 ? (
            <CyberButton title="See all transactions" kind="primary" onPress={() => router.push("/transactions")} style={styles.seeAll} />
          ) : undefined
        }
        ListHeaderComponent={
          <View style={{ paddingTop: 6 }}>
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
            {!searching && <MailNudge />}
            {error && <Text style={[styles.error, { color: t.dangerText }]}>{error}</Text>}
            {summary && !searching && <SummaryBento summary={summary} t={t} />}
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
    </View>
  );
}

/** Home lists the last 10 days that have transactions; "See all" has the rest. */
const HOME_DAYS = 10;

/** Home keeps one number: how much of what came in has gone out. The breakdown lives on Insights. */
function SummaryBento({ summary, t }: { summary: Summary; t: Theme }) {
  const monthName = new Date(`${summary.month}-01T12:00:00Z`).toLocaleString("en-IN", { month: "long", timeZone: TZ });
  const total = useCountUp(summary.net_spent_minor);
  const earned = summary.income_minor ?? (summary.received_minor || null);
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const share = earned ? summary.net_spent_minor / earned : null;
  const tag = share !== null ? `${Math.round(share * 100)}% used` : `Day ${today.getDate()}/${daysInMonth}`;
  const behind = share !== null && share > today.getDate() / daysInMonth + 0.1; // spending ahead of the month

  return (
    <View style={styles.bento}>
      <Reveal index={0}>
        <PressScale onPress={() => router.push("/insights")} accessibilityLabel="Open insights">
          <Card tone="ink" style={styles.hero}>
            <View style={styles.heroTop}>
              <Text style={[styles.tag, { color: t.inkMuted }]}>{`SPENT · ${monthName.toUpperCase()}`}</Text>
              <View style={[styles.pill, { backgroundColor: behind ? t.accent : t.onInk }]}>
                <Text style={[styles.pillText, { color: t.ink }]}>{tag.toUpperCase()}</Text>
              </View>
            </View>
            <View style={{ alignItems: "center" }}>
              <Gauge value={share ?? today.getDate() / daysInMonth} size={230}>
                <Text style={[styles.heroTotal, { color: t.onInk }]} adjustsFontSizeToFit numberOfLines={1}>
                  {formatInr(Math.round(total))}
                </Text>
                <Text style={{ color: t.inkMuted, fontSize: 13, marginTop: 2, textAlign: "center" }}>
                  {summary.income_minor ? `of ${formatInr(summary.income_minor)} salary` : earned ? `of ${formatInr(earned)} received` : `${summary.transaction_count} payments`}
                </Text>
              </Gauge>
            </View>
            <View style={styles.heroFoot}>
              <Text style={{ color: t.inkMuted, fontSize: 13 }}>
                {summary.saved_minor > 0 ? `${formatInr(summary.saved_minor)} saved` : !summary.income_minor ? "Add your salary in Settings" : " "}
              </Text>
              <Text style={[styles.tag, { color: t.onInk }]}>INSIGHTS →</Text>
            </View>
          </Card>
        </PressScale>
      </Reveal>

      {summary.review_count > 0 && (
        <Reveal index={1}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  error: { marginHorizontal: 16, marginTop: 12, fontSize: 14, fontWeight: "600" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, height: 52 },
  search: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 6, paddingHorizontal: 16, height: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.pill },
  searchInput: { flex: 1, fontSize: 16 },
  bento: { padding: 16, gap: 12 },
  hero: { padding: 20, gap: 4 },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: -6 },
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
  seeAll: { marginHorizontal: 16, marginTop: 20 },
  day: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 2, marginTop: 18, marginBottom: 10, marginHorizontal: 22, textTransform: "uppercase" },
});
