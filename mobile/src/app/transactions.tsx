import { useCallback, useRef, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { ThinkingDots } from "@/components/cyber";
import { Text } from "@/components/text";
import { Empty, TxnRow } from "@/components/ui";
import { getTransactions, type Transaction } from "@/lib/api";
import { groupByDay } from "@/lib/group";
import { useSession } from "@/lib/session";
import { FONT, useTheme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

const PAGE = 50;

/** Every transaction, newest first, by day. Loads 50 at a time as you scroll. */
export default function AllTransactionsScreen() {
  const t = useTheme();
  const { session } = useSession();
  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  const firstPage = useCallback(async () => {
    if (!session) return;
    const r = await getTransactions(session, { limit: PAGE }).catch(() => null);
    if (!r) return;
    setTxns(r.transactions);
    setMore(r.transactions.length === PAGE);
  }, [session]);
  useRefreshOnActive(useCallback(() => void firstPage(), [firstPage]));

  async function nextPage() {
    if (!session || !txns?.length || !more || busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    // The API pages by time: everything older than the oldest one shown.
    const r = await getTransactions(session, { limit: PAGE, before: txns.at(-1)!.occurred_at }).catch(() => null);
    if (r) {
      const seen = new Set(txns.map((x) => x.id));
      setTxns([...txns, ...r.transactions.filter((x) => !seen.has(x.id))]);
      setMore(r.transactions.length === PAGE);
    }
    setLoadingMore(false);
    busy.current = false;
  }

  return (
    <SectionList
      sections={groupByDay(txns ?? [])}
      keyExtractor={(x) => x.id}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 40 }}
      stickySectionHeadersEnabled={false}
      onEndReached={() => void nextPage()}
      onEndReachedThreshold={0.6}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await firstPage();
            setRefreshing(false);
          }}
          tintColor={t.accent}
          colors={[t.accent]}
          progressBackgroundColor={t.card}
        />
      }
      ListEmptyComponent={txns ? <Empty title="No transactions yet" /> : <View style={styles.loading}><ThinkingDots color={t.muted} /></View>}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.loading}>
            <ThinkingDots color={t.muted} />
          </View>
        ) : txns?.length && !more ? (
          <Text style={[styles.end, { color: t.muted }]}>THAT’S EVERYTHING</Text>
        ) : undefined
      }
      renderSectionHeader={({ section }) => <Text style={[styles.day, { color: t.muted }]}>{section.title}</Text>}
      renderItem={({ item, index, section }) => <TxnRow txn={item} first={index === 0} last={index === section.data.length - 1} />}
    />
  );
}

const styles = StyleSheet.create({
  day: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 2, marginTop: 18, marginBottom: 10, marginHorizontal: 22 },
  loading: { alignItems: "center", paddingVertical: 24 },
  end: { fontFamily: FONT.pixel, fontSize: 9, letterSpacing: 2, textAlign: "center", paddingVertical: 24 },
});
