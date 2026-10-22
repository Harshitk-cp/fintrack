// Date extraction for Indian bank SMS. Numeric dates are always day-first.

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  hasTime: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const num = (s: string | undefined) => (s ? Number(s) : 0);
const year = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => Parts | null }[] = [
  { // 2026-10-21:14:32:10, 2026:10:21 14:32:10, 2026-10-21 14:32
    re: /\b(\d{4})[-:/](\d{2})[-:/](\d{2})[ :T](\d{2}):(\d{2})(?::(\d{2}))?/g,
    build: (m) => ({ y: num(m[1]), mo: num(m[2]), d: num(m[3]), h: num(m[4]), mi: num(m[5]), s: num(m[6]), hasTime: true }),
  },
  { // 21-10-2026 15:00:00, 21/10/26 15:00
    re: /\b(\d{2})[-/](\d{2})[-/](\d{4}|\d{2})[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?/g,
    build: (m) => ({ y: year(m[3]!), mo: num(m[2]), d: num(m[1]), h: num(m[4]), mi: num(m[5]), s: num(m[6]), hasTime: true }),
  },
  { // 2026-10-21
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    build: (m) => ({ y: num(m[1]), mo: num(m[2]), d: num(m[3]), h: 0, mi: 0, s: 0, hasTime: false }),
  },
  { // 21-10-26, 21/10/2026
    re: /\b(\d{2})[-/](\d{2})[-/](\d{4}|\d{2})\b/g,
    build: (m) => ({ y: year(m[3]!), mo: num(m[2]), d: num(m[1]), h: 0, mi: 0, s: 0, hasTime: false }),
  },
  { // "On 14-10" (no year; y=0 means infer from received)
    re: /\bon\s+(\d{1,2})[-/](\d{1,2})\b(?![-/]\d)/gi,
    build: (m) => ({ y: 0, mo: num(m[2]), d: num(m[1]), h: 0, mi: 0, s: 0, hasTime: false }),
  },
  { // 21Oct26, 21-Oct-2026, 21 Oct 2026
    re: /\b(\d{1,2})[- ]?([a-z]{3})[- ]?(\d{4}|\d{2})\b/gi,
    build: (m) => {
      const mo = MONTHS[m[2]!.toLowerCase()];
      return mo ? { y: year(m[3]!), mo, d: num(m[1]), h: 0, mi: 0, s: 0, hasTime: false } : null;
    },
  },
];

/**
 * Returns the transaction time. When the SMS carries only a date, the time
 * comes from `received` (same day) or defaults to noon. Dates far from
 * `received` are rejected as misreads.
 */
export function findDate(text: string, received: Date, timeZone: string): { at: Date; timeKnown: boolean } | null {
  const rcvDay = localDay(received, timeZone);
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const parts = p.build(m);
      if (parts?.y === 0) {
        // Yearless date: assume the most recent occurrence, e.g. "31-12" received in January.
        const [ry, rmd] = [Number(rcvDay.slice(0, 4)), rcvDay.slice(5)];
        parts.y = `${pad(parts.mo)}-${pad(parts.d)}` > rmd ? ry - 1 : ry;
      }
      if (!parts || !valid(parts)) continue;
      let at: Date;
      if (parts.hasTime) {
        at = zonedTime(parts, timeZone);
      } else if (`${parts.y}-${pad(parts.mo)}-${pad(parts.d)}` === rcvDay) {
        at = received;
      } else {
        at = zonedTime({ ...parts, h: 12 }, timeZone);
      }
      const ageMs = received.getTime() - at.getTime();
      if (ageMs > 45 * 86_400_000 || ageMs < -86_400_000) continue;
      return { at, timeKnown: parts.hasTime };
    }
  }
  return null;
}

function valid(p: Parts): boolean {
  if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.h > 23 || p.mi > 59 || p.s > 59) return false;
  return p.d <= new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate(); // rejects 31 Feb etc.
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD of `d` in `timeZone`. */
export function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Interprets wall-clock parts in `timeZone` as an instant. */
function zonedTime(p: Parts, timeZone: string): Date {
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return new Date(asUtc - tzOffsetMs(new Date(asUtc), timeZone));
}

function tzOffsetMs(at: Date, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const get = (t: string) => Number(f.formatToParts(at).find((x) => x.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at.getTime();
}
