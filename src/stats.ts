// Spending totals shared by the summary API, alerts and the assistant.
// Card bill payments, own-account transfers and ATM withdrawals move money
// without spending it, and excluded transactions are left out entirely.
import type { Sql } from "./db.ts";

export const isSpend = (sql: Sql) =>
  sql`t.direction = 'debit' and not t.excluded and t.event_type not in ('card_payment', 'transfer', 'cash_withdrawal')`;
export const isRefund = (sql: Sql) => sql`t.direction = 'credit' and not t.excluded and t.event_type = 'refund'`;
export const isReceived = (sql: Sql) =>
  sql`t.direction = 'credit' and not t.excluded and t.event_type not in ('refund', 'card_payment', 'transfer')`;

/** Net spend (spend minus refunds) between two local dates, inclusive. */
export async function netSpend(sql: Sql, userId: string, tz: string, from: string, to: string) {
  const [r] = await sql`
    select coalesce(sum(amount_minor) filter (where ${isSpend(sql)}), 0) as spent,
           coalesce(sum(amount_minor) filter (where ${isRefund(sql)}), 0) as refunds,
           count(*) filter (where ${isSpend(sql)})::int as count
    from transactions t
    where t.user_id = ${userId}
      and t.occurred_at >= (${from}::date)::timestamp at time zone ${tz}
      and t.occurred_at < (${to}::date + 1)::timestamp at time zone ${tz}`;
  return { netMinor: Number(r!.spent) - Number(r!.refunds), count: r!.count as number };
}

export async function topCategories(sql: Sql, userId: string, tz: string, from: string, to: string, limit = 3) {
  const rows = await sql`
    select coalesce(t.category, 'uncategorized') as category, sum(t.amount_minor) as spent
    from transactions t
    where t.user_id = ${userId} and ${isSpend(sql)}
      and t.occurred_at >= (${from}::date)::timestamp at time zone ${tz}
      and t.occurred_at < (${to}::date + 1)::timestamp at time zone ${tz}
    group by 1 order by 2 desc limit ${limit}`;
  return rows.map((r) => ({ category: r.category as string, spentMinor: Number(r.spent) }));
}

export const monthStart = (month: string) => `${month}-01`;
export function monthEnd(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}
