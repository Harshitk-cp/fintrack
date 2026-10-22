import { router, Stack } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { CyberButton, Gauge, PressScale, Reveal, useCountUp, Wordmark } from "@/components/cyber";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MailNudge } from "@/components/mail-nudge";
import { PixelIcon } from "@/components/pixel-icon";
import { Card, Empty, HeaderButton, TxnRow } from "@/components/ui";
import { ApiError, getHealth, getSummary, getTransactions, type Health, type Summary, type Transaction } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { TZ } from "@/lib/format";
import { groupByDay } from "@/lib/group";
import { haptic } from "@/lib/haptics";
import { useOffline } from "@/lib/offline";
import { useMoney, usePrivacy } from "@/lib/privacy";
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
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const privacy = usePrivacy();
  const offline = useOffline();

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [s, list] = await Promise.all([getSummary(session), getTransactions(session, { limit: 200 })]);
      setSummary(s);
      setTxns(list.transactions);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return signOut(); // token revoked
      setError(e instanceof ApiError && e.code === "network_error" ? "Can't reach the server, and nothing is saved on this phone yet." : "Couldn't load transactions.");
    }
    getHealth(session).then(setHealth, () => {});
  }, [session, signOut]);

  useRefreshOnActive(useCallback(() => {
    void load();
    badges.refresh();
  }, [load, badges.refresh]));

  const onRefresh = async () => {
    haptic.tap();
    setRefreshing(true);
    await load();
    badges.refresh();
    setRefreshing(false);
  };

  // Home shows the last 10 days that have transactions (gaps don't count); Search covers everything.
  const sections = groupByDay(txns ?? []).slice(0, HOME_DAYS);
  const warning = health?.checks.find((c) => c.state === "warn");
  // A dismissed warning stays hidden until the situation changes (for SMS: new SMS arrive, then stop again).
  const warningKey = warning ? (warning.id === "sms" ? `sms:${health?.last_sms_at}` : `${warning.id}:${warning.title}`) : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(DISMISSED_KEY).then(setDismissed, () => {});
  }, []);
  const problem = warning && warningKey !== dismissed ? warning : null;
  const dismissProblem = () => {
    if (!warningKey) return;
    haptic.tap();
    setDismissed(warningKey);
    SecureStore.setItemAsync(DISMISSED_KEY, warningKey).catch(() => {});
  };
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
          (txns?.length ?? 0) > 0 ? (
            <CyberButton title="See all transactions" kind="primary" onPress={() => router.push("/transactions")} style={styles.seeAll} />
          ) : undefined
        }
        ListHeaderComponent={
          <View style={{ paddingTop: 6 }}>
            <View style={styles.header}>
              {/* Same width as the two buttons on the right, so the wordmark stays centred. */}
              <View style={[styles.headerRight, { width: 92 }]}>
                <HeaderButton label="Inbox" icon="bell" badge={badges.unread} onPress={() => router.push("/inbox")} />
              </View>
              <Wordmark size={20} />
              <View style={styles.headerRight}>
                <HeaderButton label={privacy.hidden ? "Show amounts" : "Hide amounts"} icon={privacy.hidden ? "eye-off" : "eye"} onPress={privacy.toggle} />
                <HeaderButton label="Add" icon="plus" onPress={() => router.push("/add")} />
              </View>
            </View>
            {/* Search has its own screen, with filters; this just opens it. */}
            <Pressable
              onPress={() => {
                haptic.tap();
                router.push("/search");
              }}
              accessibilityRole="search"
              accessibilityLabel="Search transactions"
              style={({ pressed }) => [styles.search, { borderColor: t.border, backgroundColor: pressed ? t.cardStrong : t.inputBg }]}
            >
              <PixelIcon name="search" size={18} color={t.muted} />
              <Text style={[styles.searchInput, { color: t.muted }]}>Search payee, note or bank</Text>
              <PixelIcon name="sliders" size={18} color={t.muted} />
            </Pressable>
            {error && <Text style={[styles.error, { color: t.dangerText }]}>{error}</Text>}
            {/* The meter always comes first; nudges and alerts sit under it. */}
            {summary && (
              <SummaryBento summary={summary} t={t}>
                {offline.offline && (
                  <View style={[styles.offline, { backgroundColor: t.vista }]}>
                    <PixelIcon name="wifi" size={14} color={t.text} />
                    <Text style={[styles.offlineText, { color: t.text }]}>
                      {`OFFLINE · SAVED ${offline.since ? new Date(offline.since).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: TZ }).toUpperCase() : ""}`}
                    </Text>
                  </View>
                )}
                {problem && !offline.offline && (
                  <PressScale onPress={() => router.navigate("/settings")} accessibilityLabel={`${problem.title}. Open health check`}>
                    <Card style={styles.health}>
                      <View style={[styles.healthDot, { backgroundColor: t.accent }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{problem.title}</Text>
                        <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }} numberOfLines={2}>{problem.detail}</Text>
                      </View>
                      <Pressable onPress={dismissProblem} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss" style={styles.healthClose}>
                        <PixelIcon name="close" size={18} color={t.muted} />
                      </Pressable>
                    </Card>
                  </PressScale>
                )}
                <MailNudge style={styles.nudge} />
              </SummaryBento>
            )}
          </View>
        }
        ListEmptyComponent={
          txns ? <Empty title="No transactions yet" body="They'll appear here as bank SMS arrive. Tap Add to enter cash spending." /> : undefined
        }
        renderSectionHeader={({ section }) => <Text style={[styles.day, { color: t.muted }]}>{section.title}</Text>}
        renderItem={({ item, index, section }) => <TxnRow txn={item} first={index === 0} last={index === section.data.length - 1} />}
      />
    </View>
  );
}

/** Home lists the last 10 days that have transactions; "See all" has the rest. */
const HOME_DAYS = 10;
const DISMISSED_KEY = "fintrack.healthDismissed";

/** Home keeps one number: how much of what came in has gone out. The breakdown lives on Insights. */
function SummaryBento({ summary, t, children }: { summary: Summary; t: Theme; children?: ReactNode }) {
  const money = useMoney();
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
                  {money(Math.round(total))}
                </Text>
              </Gauge>
            </View>
            <View style={styles.heroFoot}>
              <Text style={{ color: t.inkMuted, fontSize: 13 }}>
                {summary.saved_minor > 0 ? `${money(summary.saved_minor)} saved` : !summary.income_minor ? "Add your salary in Settings" : " "}
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
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  error: { marginHorizontal: 16, marginTop: 12, fontSize: 14, fontWeight: "600" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, height: 52 },
  headerRight: { flexDirection: "row", gap: 8 },
  offline: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "center", borderRadius: RADIUS.pill, paddingHorizontal: 12, paddingVertical: 6 },
  offlineText: { fontFamily: FONT.pixel, fontSize: 9, letterSpacing: 1.2 },
  health: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  healthClose: { padding: 4 },
  nudge: { marginHorizontal: 0, marginTop: 0 },
  healthDot: { width: 10, height: 10, borderRadius: 5 },
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
