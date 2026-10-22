// Spending totals shared by the summary API, alerts and the assistant.
// Card bill payments, own-account transfers and ATM withdrawals move money
// without spending it; investments (SIPs, brokers) are savings, not spending;
// excluded transactions are left out entirely. A refund the user linked to its
// purchase is netted off that purchase, and its credit stops counting as income.
import type { Sql, Tx } from "./db.ts";

/** What a purchase cost after refunds linked to it. Use in place of t.amount_minor for spending sums. */
export const netAmount = (sql: Sql | Tx) =>
  sql`(t.amount_minor - coalesce((select sum(r.amount_minor) from refunds r where r.purchase_id = t.id), 0))`;
const LINKED = (sql: Sql) => sql`exists (select 1 from refunds r where r.refund_txn_id = t.id)`;

const MOVED = (sql: Sql) => sql`t.direction = 'debit' and not t.excluded and t.event_type not in ('card_payment', 'transfer', 'cash_withdrawal')`;
export const isSpend = (sql: Sql) => sql`${MOVED(sql)} and coalesce(t.category, '') <> 'investments'`;
/** Money put away: debits filed as investments. */
export const isSaved = (sql: Sql) => sql`${MOVED(sql)} and t.category = 'investments'`;
/** Refund credits not linked to a purchase (linked ones are already netted off it). */
export const isRefund = (sql: Sql) => sql`t.direction = 'credit' and not t.excluded and t.event_type = 'refund' and not ${LINKED(sql)}`;
export const isReceived = (sql: Sql) =>
  sql`t.direction = 'credit' and not t.excluded and t.event_type not in ('refund', 'card_payment', 'transfer') and not ${LINKED(sql)}`;

/** Net spend (spend minus refunds) between two local dates, inclusive. */
export async function netSpend(sql: Sql, userId: string, tz: string, from: string, to: string) {
  const [r] = await sql`
    select coalesce(sum(${netAmount(sql)}) filter (where ${isSpend(sql)}), 0) as spent,
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
    select coalesce(t.category, 'uncategorized') as category, sum(${netAmount(sql)}) as spent
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
