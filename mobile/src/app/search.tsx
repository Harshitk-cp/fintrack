import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, SectionList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CyberButton, PixelLabel, ThinkingDots } from "@/components/cyber";
import { DateRangeSheet, rangeLabel, todayLocal, type DateRange } from "@/components/date-range";
import { PixelIcon } from "@/components/pixel-icon";
import { Sheet } from "@/components/sheet";
import { Text, TextInput } from "@/components/text";
import { Card, Chip, Empty, HeaderButton, inputStyle, TxnRow } from "@/components/ui";
import { getBanks, getTransactions, parseRupees, type SearchTotals, type Transaction, type TxnFilters } from "@/lib/api";
import { CATEGORIES } from "@/lib/categories";
import { groupByDay } from "@/lib/group";
import { haptic } from "@/lib/haptics";
import { useMoney } from "@/lib/privacy";
import { useSession } from "@/lib/session";
import { FONT, RADIUS, useTheme } from "@/lib/theme";

const PAGE = 50;

/** Date shortcuts. Each works out its range from today, in India time. */
const PRESETS: { id: string; label: string; range: () => DateRange | null }[] = [
  { id: "any", label: "Any time", range: () => null },
  { id: "today", label: "Today", range: () => ({ from: todayLocal(), to: todayLocal() }) },
  { id: "7", label: "Last 7 days", range: () => lastDays(7) },
  { id: "30", label: "Last 30 days", range: () => lastDays(30) },
  { id: "90", label: "Last 90 days", range: () => lastDays(90) },
  { id: "month", label: "This month", range: () => ({ from: `${todayLocal().slice(0, 7)}-01`, to: todayLocal() }) },
  { id: "lastmonth", label: "Last month", range: lastMonth },
];

function lastDays(n: number): DateRange {
  const [y, m, d] = todayLocal().split("-").map(Number) as [number, number, number];
  const from = new Date(Date.UTC(y, m - 1, d - (n - 1))).toISOString().slice(0, 10);
  return { from, to: todayLocal() };
}

function lastMonth(): DateRange {
  const [y, m] = todayLocal().split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

const AMOUNTS: { label: string; min?: number; max?: number }[] = [
  { label: "Under ₹500", max: 50_000 },
  { label: "₹500 – ₹2,000", min: 50_000, max: 200_000 },
  { label: "₹2,000 – ₹10,000", min: 200_000, max: 1_000_000 },
  { label: "Over ₹10,000", min: 1_000_000 },
];

type Filters = Omit<TxnFilters, "q" | "from" | "to">;

/** Search everything, with filters for dates, type, amount, category and bank. Totals cover every match, not just the page. */
export default function SearchScreen() {
  const t = useTheme();
  const money = useMoney();
  const insets = useSafeAreaInsets();
  const { session } = useSession();
  const [q, setQ] = useState("");
  const [preset, setPreset] = useState("any");
  const [custom, setCustom] = useState<DateRange | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const [totals, setTotals] = useState<SearchTotals | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [sheet, setSheet] = useState(false);
  const seq = useRef(0);

  const range = preset === "custom" ? custom : (PRESETS.find((p) => p.id === preset)?.range() ?? null);
  const query: TxnFilters = { q: q.trim() || undefined, from: range?.from, to: range?.to, ...filters };
  const key = JSON.stringify(query);

  const search = useCallback(async () => {
    if (!session) return;
    const mine = ++seq.current; // ignore answers to older searches
    try {
      const r = await getTransactions(session, { ...(JSON.parse(key) as TxnFilters), limit: PAGE, totals: true });
      if (mine !== seq.current) return;
      setTxns(r.transactions);
      setTotals(r.totals ?? null);
      setMore(r.transactions.length === PAGE);
      setError(null);
    } catch {
      if (mine === seq.current) setError("Can't search right now. Check your connection.");
    }
  }, [session, key]);

  // Typing waits a moment; picking a filter searches straight away.
  const typed = useRef(q);
  useEffect(() => {
    const wait = typed.current !== q ? 250 : 0;
    typed.current = q;
    const id = setTimeout(() => void search(), wait);
    return () => clearTimeout(id);
  }, [search, q]);

  async function nextPage() {
    if (!session || !txns?.length || !more || loadingMore) return;
    setLoadingMore(true);
    const r = await getTransactions(session, { ...query, limit: PAGE, before: txns.at(-1)!.occurred_at }).catch(() => null);
    if (r) {
      const seen = new Set(txns.map((x) => x.id));
      setTxns([...txns, ...r.transactions.filter((x) => !seen.has(x.id))]);
      setMore(r.transactions.length === PAGE);
    }
    setLoadingMore(false);
  }

  const activeCount = (filters.direction ? 1 : 0) + (filters.min !== undefined || filters.max !== undefined ? 1 : 0) + (filters.categories?.length ?? 0) + (filters.banks?.length ?? 0);
  const amountLabel = filters.min !== undefined || filters.max !== undefined
    ? filters.min !== undefined && filters.max !== undefined ? `${money(filters.min)} – ${money(filters.max)}` : filters.min !== undefined ? `Over ${money(filters.min)}` : `Under ${money(filters.max!)}`
    : null;

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <View style={styles.bar}>
        <HeaderButton label="Back" icon="arrow-left" onPress={() => router.back()} />
        <View style={[styles.search, { borderColor: t.border, backgroundColor: t.inputBg }]}>
          <PixelIcon name="search" size={18} color={t.muted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Payee, note, bank or UPI ID"
            placeholderTextColor={t.muted}
            autoFocus
            returnKeyType="search"
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.input, { color: t.text }]}
            accessibilityLabel="Search transactions"
          />
        </View>
        <HeaderButton label="Filters" icon="sliders" badge={activeCount || undefined} onPress={() => setSheet(true)} />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
        {PRESETS.map((p) => (
          <Chip key={p.id} label={p.label} selected={preset === p.id} onPress={() => setPreset(p.id)} />
        ))}
        <Chip
          icon="calendar"
          label={preset === "custom" && custom ? rangeLabel(custom) : "Pick dates"}
          selected={preset === "custom"}
          onPress={() => setCalendar(true)}
        />
      </ScrollView>

      {activeCount > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.active} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
          {filters.direction && <Removable label={filters.direction === "debit" ? "Spent" : "Received"} onRemove={() => setFilters({ ...filters, direction: undefined })} />}
          {amountLabel && <Removable label={amountLabel} onRemove={() => setFilters({ ...filters, min: undefined, max: undefined })} />}
          {filters.categories?.map((c) => (
            <Removable key={c} label={c === "none" ? "Uncategorised" : (CATEGORIES.find((x) => x.id === c)?.name ?? c)} onRemove={() => setFilters({ ...filters, categories: filters.categories!.filter((x) => x !== c) })} />
          ))}
          {filters.banks?.map((b) => (
            <Removable key={b} label={b} onRemove={() => setFilters({ ...filters, banks: filters.banks!.filter((x) => x !== b) })} />
          ))}
          <Text style={[styles.clear, { color: t.text }]} onPress={() => { haptic.tap(); setFilters({}); }}>Clear all</Text>
        </ScrollView>
      )}

      <SectionList
        sections={groupByDay(txns ?? [])}
        keyExtractor={(x) => x.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        stickySectionHeadersEnabled={false}
        onEndReached={() => void nextPage()}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={
          <>
            {error && <Text style={{ color: t.dangerText, marginHorizontal: 20, marginTop: 12 }}>{error}</Text>}
            {totals && totals.count > 0 && (
              <Card tone="ink" style={styles.totals}>
                <Total label={totals.count === 1 ? "MATCH" : "MATCHES"} value={String(totals.count)} />
                <Total label="SPENT" value={money(totals.spent_minor)} />
                <Total label="RECEIVED" value={money(totals.received_minor)} />
              </Card>
            )}
          </>
        }
        ListEmptyComponent={txns ? <Empty icon="search" title="No matches" body="Try a wider date range or fewer filters." /> : <View style={styles.loading}><ThinkingDots color={t.muted} /></View>}
        ListFooterComponent={loadingMore ? <View style={styles.loading}><ThinkingDots color={t.muted} /></View> : undefined}
        renderSectionHeader={({ section }) => <Text style={[styles.day, { color: t.muted }]}>{section.title}</Text>}
        renderItem={({ item, index, section }) => <TxnRow txn={item} first={index === 0} last={index === section.data.length - 1} />}
      />

      <DateRangeSheet
        visible={calendar}
        initial={preset === "custom" ? custom : range}
        onClose={() => setCalendar(false)}
        onApply={(r) => {
          haptic.success();
          setCustom(r);
          setPreset("custom");
          setCalendar(false);
        }}
      />
      <FilterSheet visible={sheet} value={filters} onClose={() => setSheet(false)} onApply={(f) => { setFilters(f); setSheet(false); }} />
    </View>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={[styles.totalLabel, { color: t.inkMuted }]}>{label}</Text>
      <Text style={[styles.totalValue, { color: t.onInk }]} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Removable({ label, onRemove }: { label: string; onRemove: () => void }) {
  const t = useTheme();
  return (
    <View style={[styles.removable, { backgroundColor: t.ink }]}>
      <Text style={{ color: t.onInk, fontSize: 13 }}>{label}</Text>
      <Text onPress={() => { haptic.select(); onRemove(); }} accessibilityRole="button" accessibilityLabel={`Remove ${label}`} style={{ color: t.onInk, paddingHorizontal: 4 }} suppressHighlighting>
        ✕
      </Text>
    </View>
  );
}

/** Type, amount, category and bank. Changes apply when you tap Show results. */
function FilterSheet({ visible, value, onClose, onApply }: { visible: boolean; value: Filters; onClose: () => void; onApply: (f: Filters) => void }) {
  const t = useTheme();
  const { session } = useSession();
  const [f, setF] = useState<Filters>(value);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [banks, setBanks] = useState<string[]>([]);
  const [shownFor, setShownFor] = useState(visible);
  if (visible !== shownFor) {
    setShownFor(visible);
    if (visible) {
      setF(value);
      setMin(value.min !== undefined ? String(value.min / 100) : "");
      setMax(value.max !== undefined ? String(value.max / 100) : "");
    }
  }
  useEffect(() => {
    if (visible && session) getBanks(session).then((r) => setBanks(r.banks), () => {});
  }, [visible, session]);

  const toggle = (k: "categories" | "banks", v: string) => {
    const cur = f[k] ?? [];
    setF({ ...f, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const minMinor = min.trim() ? parseRupees(min) : undefined;
  const maxMinor = max.trim() ? parseRupees(max) : undefined;
  const badAmount = minMinor === null || maxMinor === null || (minMinor !== undefined && maxMinor !== undefined && minMinor > maxMinor);

  return (
    <Sheet visible={visible} onClose={onClose} height="88%">
      <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
        <Text style={[styles.sheetTitle, { color: t.text }]}>FILTERS</Text>

        <PixelLabel>Type</PixelLabel>
        <View style={styles.chips}>
          {([[undefined, "All"], ["debit", "Spent"], ["credit", "Received"]] as const).map(([d, label]) => (
            <Chip key={label} label={label} selected={f.direction === d} onPress={() => setF({ ...f, direction: d })} />
          ))}
        </View>

        <PixelLabel style={{ marginTop: 22 }}>Amount</PixelLabel>
        <View style={styles.chips}>
          {AMOUNTS.map((a) => (
            <Chip
              key={a.label}
              label={a.label}
              selected={minMinor === a.min && maxMinor === a.max}
              onPress={() => {
                setMin(a.min !== undefined ? String(a.min / 100) : "");
                setMax(a.max !== undefined ? String(a.max / 100) : "");
              }}
            />
          ))}
        </View>
        <View style={styles.amounts}>
          <TextInput style={[inputStyle(t), { flex: 1 }]} value={min} onChangeText={setMin} placeholder="Min ₹" placeholderTextColor={t.muted} keyboardType="decimal-pad" accessibilityLabel="Minimum amount" />
          <Text style={{ color: t.muted }}>to</Text>
          <TextInput style={[inputStyle(t), { flex: 1 }]} value={max} onChangeText={setMax} placeholder="Max ₹" placeholderTextColor={t.muted} keyboardType="decimal-pad" accessibilityLabel="Maximum amount" />
        </View>
        {badAmount && <Text style={{ color: t.dangerText, fontSize: 13, marginTop: 6 }}>Enter amounts in rupees, with the minimum below the maximum.</Text>}

        <PixelLabel style={{ marginTop: 22 }}>Category</PixelLabel>
        <View style={styles.chips}>
          {CATEGORIES.map((c) => (
            <Chip key={c.id} icon={c.icon} label={c.name} selected={!!f.categories?.includes(c.id)} onPress={() => toggle("categories", c.id)} />
          ))}
          <Chip icon="warning-diamond" label="Uncategorised" selected={!!f.categories?.includes("none")} onPress={() => toggle("categories", "none")} />
        </View>

        {banks.length > 0 && (
          <>
            <PixelLabel style={{ marginTop: 22 }}>Bank</PixelLabel>
            <View style={styles.chips}>
              {banks.map((b) => (
                <Chip key={b} label={b} selected={!!f.banks?.includes(b)} onPress={() => toggle("banks", b)} />
              ))}
            </View>
          </>
        )}
      </ScrollView>
      <View style={[styles.sheetFoot, { borderTopColor: t.border }]}>
        <Text
          style={{ color: t.text, fontSize: 15, fontWeight: "600", textDecorationLine: "underline", padding: 8 }}
          onPress={() => {
            haptic.tap();
            setF({});
            setMin("");
            setMax("");
          }}
        >
          Reset
        </Text>
        <CyberButton
          title="Show results"
          kind="solid"
          disabled={badAmount}
          onPress={() => onApply({ ...f, min: minMinor ?? undefined, max: maxMinor ?? undefined })}
          style={{ flex: 1, maxWidth: 240 }}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, height: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.pill },
  input: { flex: 1, fontSize: 16 },
  presets: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
  active: { paddingHorizontal: 16, gap: 8, paddingTop: 8, alignItems: "center" },
  removable: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: RADIUS.pill, paddingLeft: 12, paddingRight: 8, paddingVertical: 6 },
  clear: { fontSize: 14, fontWeight: "600", textDecorationLine: "underline", paddingHorizontal: 6 },
  totals: { flexDirection: "row", gap: 12, marginHorizontal: 16, marginTop: 14, paddingVertical: 16 },
  totalLabel: { fontFamily: FONT.pixel, fontSize: 9, letterSpacing: 1.4 },
  totalValue: { fontFamily: FONT.display, fontSize: 16 },
  day: { fontFamily: FONT.pixel, fontSize: 10, letterSpacing: 2, marginTop: 18, marginBottom: 10, marginHorizontal: 22, textTransform: "uppercase" },
  loading: { alignItems: "center", paddingVertical: 32 },
  sheetBody: { padding: 20, paddingBottom: 24 },
  sheetTitle: { fontFamily: FONT.pixel, fontSize: 14, letterSpacing: 1.6, marginBottom: 18 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  amounts: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  sheetFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
