import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { Transaction } from "@/lib/api";
import { CATEGORIES, category } from "@/lib/categories";
import { formatTime, kindLabel, payeeName } from "@/lib/format";
import { useMoney } from "@/lib/privacy";
import { alpha, FONT, PALETTE, RADIUS, useTheme, type Theme } from "@/lib/theme";
import { CyberButton, PixelLabel, PressScale } from "./cyber";
import { PixelIcon, type PixelIconName } from "./pixel-icon";
import { Text } from "./text";

export function Section({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  const t = useTheme();
  return (
    <View style={styles.section}>
      {title && <PixelLabel>{title}</PixelLabel>}
      <Card>{children}</Card>
      {footer && <Text style={[styles.footer, { color: t.muted }]}>{footer}</Text>}
    </View>
  );
}

export type CardTone = "paper" | "ink" | "accent" | "vista";

/** A rounded bento card. `ink` is Oxford with Amande text, `accent` Orange, `vista` Vista Bleu. */
export function Card({ children, style, tone = "paper" }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: CardTone }) {
  const t = useTheme();
  const bg = tone === "ink" ? t.ink : tone === "accent" ? t.accent : tone === "vista" ? t.vista : t.card;
  return <View style={[styles.card, { backgroundColor: bg }, tone === "paper" && { borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }, style]}>{children}</View>;
}

export function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const t = useTheme();
  return (
    <View style={styles.row}>
      <Text style={{ color: t.muted, fontSize: 15 }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: 15, flexShrink: 1, textAlign: "right", fontWeight: warn ? "700" : "400" }} numberOfLines={2} selectable>
        {value}
      </Text>
    </View>
  );
}

/** Pill chip; selected is an Oxford pill with Amande text. */
export function Chip({ label, selected, onPress, disabled, icon }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean; icon?: PixelIconName }) {
  const t = useTheme();
  const color = selected ? t.onInk : t.text;
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      feel="select"
      scale={0.97}
      accessibilityLabel={label}
      style={[styles.chip, { borderColor: selected ? t.ink : t.border, backgroundColor: selected ? t.ink : t.card, opacity: disabled ? 0.5 : 1 }]}
    >
      {icon && <PixelIcon name={icon} size={16} color={selected ? t.accent : t.muted} />}
      <Text style={{ color, fontSize: 14, fontWeight: selected ? "600" : "400" }}>{label}</Text>
    </PressScale>
  );
}

export function CategoryPicker({ value, onChange, disabled }: { value: string | null; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <View style={styles.chips}>
      {CATEGORIES.map((c) => (
        <Chip key={c.id} icon={c.icon} label={c.name} selected={value === c.id} onPress={() => onChange(c.id)} disabled={disabled} />
      ))}
    </View>
  );
}

export function Button({
  title, onPress, kind = "primary", busy, disabled, style,
}: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; busy?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return <CyberButton title={title} onPress={onPress} kind={kind === "primary" ? "solid" : "primary"} busy={busy} disabled={disabled} style={style} />;
}

/** A round icon button for headers. */
export function HeaderButton({ label, icon, onPress, badge }: { label: string; icon: PixelIconName; onPress: () => void; badge?: number }) {
  const t = useTheme();
  return (
    <PressScale onPress={onPress} scale={0.95} accessibilityLabel={badge ? `${label}, ${badge} new` : label} style={[styles.headerButton, { borderColor: t.border, backgroundColor: t.card }]}>
      <PixelIcon name={icon} size={22} color={t.text} />
      {!!badge && <Badge count={badge} style={styles.headerBadge} />}
    </PressScale>
  );
}

export function Badge({ count, style }: { count: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: t.accent }, style]}>
      <Text style={[styles.badgeText, { color: t.onAccent }]}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

/** A rounded tile holding a pixel icon; Orange when it needs attention. */
export function IconTile({ name, hot, size = 40 }: { name: PixelIconName; hot?: boolean; size?: number }) {
  const t = useTheme();
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: hot ? t.accent : alpha(PALETTE.oxford, 0.06) }]}>
      <PixelIcon name={name} size={Math.round(size * 0.5)} color={t.text} />
    </View>
  );
}

/** One transaction in a grouped list. Tapping opens its detail screen. */
export function TxnRow({ txn, first, last }: { txn: Transaction; first: boolean; last: boolean }) {
  const t = useTheme();
  const money = useMoney();
  const refunded = txn.refunded_minor ?? 0;
  const credit = txn.direction === "credit";
  const needsReview = !!txn.review_reason && !txn.reviewed_at;
  const cat = category(txn.category);
  const meta = [txn.institution_name ?? "Unknown bank", refunded ? (refunded >= txn.amount_minor ? "Refunded" : "Part refunded") : (cat?.name ?? kindLabel(txn)), formatTime(txn.occurred_at)].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => router.push(`/transaction/${txn.id}`)}
      style={({ pressed }) => [
        styles.txn,
        { backgroundColor: pressed ? t.cardStrong : t.card, borderColor: t.border },
        first && styles.txnFirst,
        last && styles.txnLast,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <IconTile name={cat?.icon ?? (needsReview ? "warning-diamond" : credit ? "coins" : "credit-card")} hot={needsReview} />
      <View style={styles.txnMain}>
        <Text style={[styles.payee, { color: txn.excluded ? t.muted : t.text }]} numberOfLines={1}>
          {payeeName(txn)}
        </Text>
        <Text style={[styles.meta, { color: t.muted }]} numberOfLines={1}>
          {needsReview ? `Needs review · ${meta}` : meta}
        </Text>
      </View>
      <View style={[styles.amountWrap, credit && !txn.excluded && { backgroundColor: t.vista }]}>
        <Text style={[styles.amount, { color: txn.excluded ? t.muted : t.text }, txn.excluded && { textDecorationLine: "line-through" }]}>
          {credit ? "+" : ""}
          {money(txn.amount_minor)}
        </Text>
      </View>
    </Pressable>
  );
}

export function Empty({ title, body, icon = "check" }: { title: string; body?: string; icon?: PixelIconName }) {
  const t = useTheme();
  return (
    <View style={styles.empty}>
      <IconTile name={icon} size={56} />
      <Text style={{ color: t.text, fontFamily: FONT.pixel, fontSize: 14, letterSpacing: 1, textAlign: "center", marginTop: 16 }}>{title.toUpperCase()}</Text>
      {body && <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, textAlign: "center", marginTop: 8 }}>{body}</Text>}
    </View>
  );
}

export const inputStyle = (t: Theme) => [styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.inputBg }];

export const styles = StyleSheet.create({
  section: { marginBottom: 24 },
  footer: { fontSize: 13, lineHeight: 18, marginTop: 8, marginHorizontal: 6 },
  card: { borderRadius: RADIUS.card, padding: 18, gap: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 13, paddingVertical: 8 },
  headerButton: { width: 42, height: 42, borderRadius: 21, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  headerBadge: { position: "absolute", top: -4, right: -4 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { fontFamily: FONT.pixel, fontSize: 9 },
  tile: { borderRadius: RADIUS.tile, alignItems: "center", justifyContent: "center" },
  txn: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, marginHorizontal: 16, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  txnFirst: { borderTopLeftRadius: RADIUS.card, borderTopRightRadius: RADIUS.card, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16 },
  txnLast: { borderBottomLeftRadius: RADIUS.card, borderBottomRightRadius: RADIUS.card, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 16 },
  txnMain: { flex: 1 },
  payee: { fontSize: 16, fontWeight: "600" },
  meta: { fontSize: 13, marginTop: 3 },
  amountWrap: { borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 3 },
  amount: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  empty: { paddingHorizontal: 32, paddingVertical: 48, alignItems: "center" },
  input: { borderWidth: 1, borderRadius: RADIUS.field, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
});
