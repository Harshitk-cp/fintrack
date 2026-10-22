import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { TZ } from "@/lib/format";
import { haptic } from "@/lib/haptics";
import { alpha, FONT, PALETTE, RADIUS, useTheme } from "@/lib/theme";
import { CyberButton } from "./cyber";
import { Sheet } from "./sheet";
import { Text } from "./text";

// Dates here are plain local days, "YYYY-MM-DD", compared as strings. No time
// zones inside the grid: "today" is worked out once, in India time.

export interface DateRange {
  from: string;
  to: string;
}

const MONTHS_BACK = 36;
const ROW = 46;
const TITLE = 48;
const MONTH_HEIGHT = TITLE + ROW * 6 + 8; // every month gets six rows, so scrolling to "now" is exact
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

/** "12 Oct", or "12 Oct 2025" when it isn't this year. */
export function shortDate(day: string) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const thisYear = Number(todayLocal().slice(0, 4));
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(y !== thisYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

export const daysBetween = (a: string, b: string) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8))) / 86_400_000) + 1;

export const rangeLabel = (r: DateRange) => (r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`);

interface Month {
  y: number;
  m: number; // 1–12
}

/**
 * Pick a range by tapping two days, like booking a stay: the first tap is the
 * start, the second the end (tapping earlier than the start moves the start
 * instead), and a third tap starts again. Future days can't be picked.
 */
export function DateRangeSheet({ visible, initial, onClose, onApply }: {
  visible: boolean; initial: DateRange | null; onClose: () => void; onApply: (r: DateRange) => void;
}) {
  const t = useTheme();
  const today = todayLocal();
  const [start, setStart] = useState<string | null>(initial?.from ?? null);
  const [end, setEnd] = useState<string | null>(initial?.to ?? null);
  const [shownFor, setShownFor] = useState(visible);
  // Opening again starts from what's applied, not from an abandoned selection.
  if (visible !== shownFor) {
    setShownFor(visible);
    if (visible) {
      setStart(initial?.from ?? null);
      setEnd(initial?.to ?? null);
    }
  }

  const months = useMemo(() => {
    const [ty, tm] = today.split("-").map(Number) as [number, number];
    return Array.from({ length: MONTHS_BACK + 1 }, (_, i) => {
      const k = ty * 12 + (tm - 1) - (MONTHS_BACK - i);
      return { y: Math.floor(k / 12), m: (k % 12) + 1 };
    });
  }, [today]);

  const tap = useCallback(
    (day: string) => {
      haptic.select();
      if (!start || end) {
        setStart(day);
        setEnd(null);
      } else if (day < start) {
        setStart(day);
      } else {
        setEnd(day);
      }
    },
    [start, end],
  );

  const status = !start ? "Tap a start date" : !end ? `${shortDate(start)} → tap an end date` : `${rangeLabel({ from: start, to: end })} · ${daysBetween(start, end)} day${daysBetween(start, end) === 1 ? "" : "s"}`;

  return (
    <Sheet visible={visible} onClose={onClose} height="88%">
      <View style={styles.head}>
        <Text style={[styles.title, { color: t.text }]}>SELECT DATES</Text>
        <Text style={{ color: t.muted, fontSize: 15, marginTop: 4 }}>{status}</Text>
      </View>
      <View style={[styles.weekdays, { borderBottomColor: t.border }]}>
        {WEEKDAYS.map((w, i) => (
          <Text key={i} style={[styles.weekday, { color: t.muted }]}>{w}</Text>
        ))}
      </View>
      <FlatList
        data={months}
        keyExtractor={(m) => `${m.y}-${m.m}`}
        initialScrollIndex={months.length - 1}
        getItemLayout={(_, i) => ({ length: MONTH_HEIGHT, offset: MONTH_HEIGHT * i, index: i })}
        initialNumToRender={2}
        windowSize={5}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => <MonthGrid month={item} start={start} end={end} today={today} onTap={tap} />}
        style={{ flex: 1 }}
      />
      <View style={[styles.foot, { borderTopColor: t.border }]}>
        <Text
          style={{ color: start ? t.text : t.muted, fontSize: 15, fontWeight: "600", textDecorationLine: "underline", padding: 8 }}
          onPress={() => {
            haptic.tap();
            setStart(null);
            setEnd(null);
          }}
        >
          Clear
        </Text>
        <CyberButton
          title="Apply"
          kind="solid"
          disabled={!start}
          onPress={() => start && onApply({ from: start, to: end ?? start })}
          style={{ flex: 1, maxWidth: 220 }}
        />
      </View>
    </Sheet>
  );
}

const MonthGrid = memo(function MonthGrid({ month, start, end, today, onTap }: {
  month: Month; start: string | null; end: string | null; today: string; onTap: (day: string) => void;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const cell = Math.floor((Math.min(width, 560) - 32) / 7);
  const first = new Date(Date.UTC(month.y, month.m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate();
  const title = new Date(Date.UTC(month.y, month.m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const lo = start;
  const hi = end ?? start;

  return (
    <View style={{ height: MONTH_HEIGHT, paddingHorizontal: 16 }}>
      <Text style={[styles.month, { color: t.text }]}>{title.toUpperCase()}</Text>
      <View style={styles.grid}>
        {Array.from({ length: 42 }, (_, i) => {
          const d = i - first + 1;
          if (d < 1 || d > days) return <View key={i} style={{ width: cell, height: ROW }} />;
          const day = ymd(month.y, month.m, d);
          const future = day > today;
          const isStart = day === lo;
          const isEnd = day === hi;
          const inside = !!lo && !!hi && day > lo && day < hi;
          const edge = isStart || isEnd;
          const spans = !!lo && !!hi && lo !== hi; // a band joins the ends
          const col = i % 7;
          return (
            <Pressable
              key={i}
              disabled={future}
              onPress={() => onTap(day)}
              accessibilityRole="button"
              accessibilityLabel={`${d} ${title}${isStart ? ", start" : ""}${isEnd && spans ? ", end" : ""}`}
              accessibilityState={{ disabled: future, selected: edge || inside }}
              style={{ width: cell, height: ROW, alignItems: "center", justifyContent: "center" }}
            >
              {/* The band: full width inside the range, half width behind each end. Rounded where a week wraps. */}
              {(inside || (spans && edge)) && (
                <View
                  style={[
                    styles.band,
                    { backgroundColor: alpha(PALETTE.vista, 0.55) },
                    isStart && { left: cell / 2 },
                    isEnd && { right: cell / 2 },
                    inside && col === 0 && { borderTopLeftRadius: RADIUS.pill, borderBottomLeftRadius: RADIUS.pill },
                    inside && col === 6 && { borderTopRightRadius: RADIUS.pill, borderBottomRightRadius: RADIUS.pill },
                  ]}
                />
              )}
              <View
                style={[
                  styles.day,
                  edge && { backgroundColor: t.ink },
                  !edge && day === today && { borderWidth: 1.5, borderColor: t.accent },
                ]}
              >
                <Text style={[styles.dayText, { color: edge ? t.onInk : future ? alpha(PALETTE.oxford, 0.25) : t.text }, edge && { fontFamily: FONT.bold }]}>{d}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  title: { fontFamily: FONT.pixel, fontSize: 14, letterSpacing: 1.6 },
  weekdays: { flexDirection: "row", paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  weekday: { flex: 1, textAlign: "center", fontFamily: FONT.pixel, fontSize: 10 },
  month: { fontFamily: FONT.pixel, fontSize: 11, letterSpacing: 1.6, height: TITLE, paddingTop: 20 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  band: { position: "absolute", left: 0, right: 0, top: 5, bottom: 5 },
  day: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  dayText: { fontSize: 15, fontVariant: ["tabular-nums"] },
  foot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
