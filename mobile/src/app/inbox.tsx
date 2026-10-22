import { router } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { type PixelIconName } from "@/components/pixel-icon";
import { Empty, IconTile } from "@/components/ui";
import { getNotifications, markNotificationsRead, type AppNotification } from "@/lib/api";
import { useBadges } from "@/lib/badges";
import { formatDateTime } from "@/lib/format";
import { useMaskText } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";
import { useRefreshOnActive } from "@/lib/useRefreshOnActive";

const ICON: Record<AppNotification["kind"], PixelIconName> = { transaction: "coins", review: "warning-diamond", digest: "chart-line", budget: "wallet", insight: "sparkles" };

export default function InboxScreen() {
  const t = useTheme();
  const { session } = useSession();
  const badges = useBadges();
  const mask = useMaskText();
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Opening the inbox marks everything read; unread ones stay highlighted until the next visit.
  const load = useCallback(async () => {
    if (!session) return;
    const r = await getNotifications(session).catch(() => null);
    if (!r) return;
    setItems(r.notifications);
    if (r.unread) {
      await markNotificationsRead(session).catch(() => {});
      badges.refresh();
    }
  }, [session, badges.refresh]);
  useRefreshOnActive(useCallback(() => void load(), [load]));

  return (
    <FlatList
      data={items ?? []}
      keyExtractor={(n) => n.id}
      contentContainerStyle={{ paddingVertical: 8, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={t.muted}
        />
      }
      ListEmptyComponent={items ? <Empty title="No notifications yet" body="Payment alerts, review questions and your daily summary show up here." /> : undefined}
      ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: 60 }} />}
      renderItem={({ item }) => (
        <Pressable
          disabled={!item.transaction_id}
          onPress={() => item.transaction_id && router.push(`/transaction/${item.transaction_id}`)}
          style={({ pressed }) => [styles.item, { backgroundColor: pressed ? t.border : item.read_at ? "transparent" : t.card }]}
        >
          <IconTile name={ICON[item.kind]} hot={!item.read_at && (item.kind === "review" || item.kind === "budget")} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: item.read_at ? "500" : "700" }}>{mask(item.title)}</Text>
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 19, marginTop: 2 }}>{mask(item.body)}</Text>
            <Text style={{ color: t.muted, fontSize: 12, marginTop: 4 }}>{formatDateTime(item.created_at)}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
});
