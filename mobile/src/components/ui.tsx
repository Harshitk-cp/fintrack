import { router } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { formatInr, type Transaction } from "@/lib/api";
import { CATEGORIES, category } from "@/lib/categories";
import { formatTime, kindLabel, payeeName } from "@/lib/format";
import { useTheme, type Theme } from "@/lib/theme";

export function Section({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  const t = useTheme();
  return (
    <View style={styles.section}>
      {title && <Text style={[styles.sectionTitle, { color: t.muted }]}>{title}</Text>}
      <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>{children}</View>
      {footer && <Text style={[styles.footer, { color: t.muted }]}>{footer}</Text>}
    </View>
  );
}

export function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const t = useTheme();
  return (
    <View style={styles.row}>
      <Text style={{ color: t.muted, fontSize: 15 }}>{label}</Text>
      <Text style={{ color: warn ? t.danger : t.text, fontSize: 15, flexShrink: 1, textAlign: "right" }} numberOfLines={2} selectable>
        {value}
      </Text>
    </View>
  );
}

export function Chip({ label, selected, onPress, disabled }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: selected ? t.accent : t.border, backgroundColor: selected ? t.accent : t.card, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={{ color: selected ? "#fff" : t.text, fontSize: 14, fontWeight: selected ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

export function CategoryPicker({ value, onChange, disabled }: { value: string | null; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <View style={styles.chips}>
      {CATEGORIES.map((c) => (
        <Chip key={c.id} label={`${c.emoji} ${c.name}`} selected={value === c.id} onPress={() => onChange(c.id)} disabled={disabled} />
      ))}
    </View>
  );
}

export function Button({
  title, onPress, kind = "primary", busy, disabled, style,
}: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; busy?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: t.accent } : { borderWidth: 1, borderColor: t.border, backgroundColor: t.card },
        { opacity: disabled ? 0.5 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? "#fff" : t.muted} />
      ) : (
        <Text style={{ color: primary ? "#fff" : kind === "danger" ? t.danger : t.accent, fontSize: 16, fontWeight: "600" }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function HeaderButton({ label, onPress, badge }: { label: string; onPress: () => void; badge?: number }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={badge ? `${label}, ${badge} new` : label} style={styles.headerButton}>
      <Text style={{ color: t.accent, fontSize: 16, fontWeight: "600" }}>{label}</Text>
      {!!badge && (
        <View style={[styles.badge, { backgroundColor: t.danger }]}>
          <Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** One transaction in a grouped list. Tapping opens its detail screen. */
export function TxnRow({ txn, first, last }: { txn: Transaction; first: boolean; last: boolean }) {
  const t = useTheme();
  const credit = txn.direction === "credit";
  const needsReview = !!txn.review_reason && !txn.reviewed_at;
  const cat = category(txn.category);
  const meta = [txn.institution_name ?? "Unknown bank", cat?.name ?? kindLabel(txn), formatTime(txn.occurred_at)].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => router.push(`/transaction/${txn.id}`)}
      style={({ pressed }) => [
        styles.txn,
        { backgroundColor: pressed ? t.border : t.card, borderColor: t.border },
        first && styles.txnFirst,
        last && styles.txnLast,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <Text style={styles.txnIcon}>{cat?.emoji ?? (needsReview ? "❓" : credit ? "💰" : "💳")}</Text>
      <View style={styles.txnMain}>
        <Text style={[styles.payee, { color: txn.excluded ? t.muted : t.text }]} numberOfLines={1}>
          {payeeName(txn)}
        </Text>
        <Text style={[styles.meta, { color: needsReview ? t.danger : t.muted }]} numberOfLines={1}>
          {needsReview ? `Needs review · ${meta}` : meta}
        </Text>
      </View>
      <Text
        style={[
          styles.amount,
          { color: txn.excluded ? t.muted : credit ? t.credit : t.text },
          txn.excluded && { textDecorationLine: "line-through" },
        ]}
      >
        {credit ? "+" : ""}
        {formatInr(txn.amount_minor)}
      </Text>
    </Pressable>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  const t = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: "600", textAlign: "center" }}>{title}</Text>
      {body && <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, textAlign: "center", marginTop: 6 }}>{body}</Text>}
    </View>
  );
}

export const inputStyle = (t: Theme) => [styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }];

export const styles = StyleSheet.create({
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, marginLeft: 4 },
  footer: { fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 },
  button: { borderRadius: 10, paddingVertical: 14, alignItems: "center", justifyContent: "center", minHeight: 48 },
  headerButton: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, marginLeft: 4, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  txn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, marginHorizontal: 16, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  txnFirst: { borderTopLeftRadius: 12, borderTopRightRadius: 12, borderTopWidth: StyleSheet.hairlineWidth },
  txnLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  txnIcon: { fontSize: 22, width: 34 },
  txnMain: { flex: 1, marginRight: 12 },
  payee: { fontSize: 16, fontWeight: "500" },
  meta: { fontSize: 13, marginTop: 3 },
  amount: { fontSize: 16, fontWeight: "600", fontVariant: ["tabular-nums"] },
  empty: { paddingHorizontal: 32, paddingVertical: 48 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
});
