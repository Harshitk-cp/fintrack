// Recurring charges found in the ledger: the same payee, about the same amount,
// about once a month (or once a year). Nothing is stored; the list is worked out
// from transactions each time, minus payees the user hid.
import type { Sql } from "./db.ts";

const DAY = 86_400_000;

export interface Charge {
  id: string;
  occurredAt: Date;
  amountMinor: number;
  name: string;
  category: string | null;
  bank: string | null;
}

export interface Subscription {
  key: string;
  name: string;
  category: string | null;
  bank: string | null;
  cadence: "monthly" | "yearly";
  amount_minor: number;
  /** The charge before the last one, when the price changed. */
  previous_minor: number | null;
  /** What it costs per month (a yearly plan spread over 12). */
  monthly_minor: number;
  last_at: string;
  next_at: string;
  charges: number;
  active: boolean;
  transaction_ids: string[];
}

/** Letters only, so "NETFLIX.COM 4471" and "Netflix" agree. */
export const payeeKey = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const CADENCES = [
  { cadence: "monthly" as const, min: 25, max: 35, tolerance: [20, 40], minCharges: 3 },
  { cadence: "yearly" as const, min: 340, max: 390, tolerance: [330, 400], minCharges: 2 },
];

/**
 * Whether one payee's charges look like a subscription. Monthly needs three
 * charges (two when it's already filed under Subscriptions), most gaps on
 * cadence, and most amounts within 25% of the latest.
 */
export function asSubscription(key: string, charges: Charge[], now: Date): Subscription | null {
  if (charges.length < 2) return null;
  const c = [...charges].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const gaps = c.slice(1).map((x, i) => (x.occurredAt.getTime() - c[i]!.occurredAt.getTime()) / DAY);
  const gap = median(gaps);
  const fit = CADENCES.find((k) => gap >= k.min && gap <= k.max);
  if (!fit) return null;
  const last = c.at(-1)!;
  const filed = last.category === "subscriptions";
  if (c.length < (filed && fit.cadence === "monthly" ? 2 : fit.minCharges)) return null;
  const onBeat = gaps.filter((g) => g >= fit.tolerance[0]! && g <= fit.tolerance[1]!).length;
  if (onBeat / gaps.length < 0.7) return null;
  const close = c.filter((x) => Math.abs(x.amountMinor - last.amountMinor) <= last.amountMinor * 0.25).length;
  if (close / c.length < 0.6) return null;

  // A price change stays flagged for its first few charges at the new price, not just the one it happened on.
  const differs = (x: Charge) => Math.abs(last.amountMinor - x.amountMinor) >= 100 && Math.abs(last.amountMinor - x.amountMinor) / x.amountMinor > 0.01;
  const changedAt = c.findLastIndex(differs);
  const prev = changedAt >= 0 && c.length - 1 - changedAt <= (fit.cadence === "monthly" ? 3 : 1) ? c[changedAt]! : null;
  const next = new Date(last.occurredAt);
  if (fit.cadence === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  const overdueDays = (now.getTime() - next.getTime()) / DAY;
  return {
    key,
    name: last.name,
    category: last.category,
    bank: last.bank,
    cadence: fit.cadence,
    amount_minor: last.amountMinor,
    previous_minor: prev?.amountMinor ?? null,
    monthly_minor: fit.cadence === "monthly" ? last.amountMinor : Math.round(last.amountMinor / 12),
    last_at: last.occurredAt.toISOString(),
    next_at: next.toISOString(),
    charges: c.length,
    // A missed month (plus slack for billing dates moving) means it was probably cancelled.
    active: overdueDays <= (fit.cadence === "monthly" ? 12 : 30),
    transaction_ids: c.map((x) => x.id).reverse().slice(0, 12),
  };
}

export async function findSubscriptions(sql: Sql, userId: string, now = new Date()) {
  const rows = await sql`
    select t.id, t.occurred_at, t.amount_minor, t.category, t.institution_name,
           coalesce(t.label, t.ai_name, nullif(trim(leading '*' from t.counterparty), ''), t.counterparty_vpa) as name
    from transactions t
    where t.user_id = ${userId} and t.direction = 'debit' and not t.excluded
      and t.event_type not in ('card_payment', 'transfer', 'cash_withdrawal')
      and coalesce(t.category, '') not in ('investments')
      and t.occurred_at > ${new Date(now.getTime() - 800 * DAY)}
    order by t.occurred_at`;
  const hidden = new Set((await sql`select payee_key from subscription_hides where user_id = ${userId}`).map((r) => r.payee_key as string));
  const byPayee = new Map<string, Charge[]>();
  for (const r of rows) {
    if (!r.name) continue;
    const key = payeeKey(r.name);
    if (key.length < 3 || hidden.has(key)) continue;
    const list = byPayee.get(key) ?? [];
    list.push({ id: r.id, occurredAt: r.occurred_at, amountMinor: Number(r.amount_minor), name: r.name, category: r.category, bank: r.institution_name });
    byPayee.set(key, list);
  }
  const subs = [...byPayee].map(([key, charges]) => asSubscription(key, charges, now)).filter((s): s is Subscription => !!s);
  subs.sort((a, b) => Number(b.active) - Number(a.active) || b.monthly_minor - a.monthly_minor);
  const active = subs.filter((s) => s.active);
  return {
    subscriptions: subs,
    monthly_total_minor: active.reduce((n, s) => n + s.monthly_minor, 0),
    yearly_total_minor: active.reduce((n, s) => n + (s.cadence === "monthly" ? s.amount_minor * 12 : s.amount_minor), 0),
    hidden: hidden.size,
  };
}
