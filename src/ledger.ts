// Reading and editing the transaction ledger: listing, manual entries, review
// answers, and payee rules learned from them.
import { builtinCategory } from "./categories.ts";
import { classify, findRule, payeeKeys } from "./classify.ts";
import type { Sql, Tx } from "./db.ts";
import { loadPayeeRules } from "./ingest.ts";
import { slugify } from "./sms/parser.ts";

export const TXN_COLUMNS = (sql: Sql | Tx) => sql`
  t.id, t.amount_minor, t.currency, t.direction, t.event_type, t.status, t.channel, t.source,
  t.occurred_at, t.counterparty, t.counterparty_vpa, t.reference, t.institution, t.institution_name,
  t.category, t.category_source, t.label, t.ai_name, t.note, t.excluded, t.review_reason, t.reviewed_at,
  a.kind as account_kind, a.last4,
  (select count(*) from transaction_evidence te where te.transaction_id = t.id)::int as evidence_count`;

const rowOut = <T extends Record<string, unknown>>(r: T) => ({ ...r, amount_minor: Number(r.amount_minor) });

export interface ListOptions {
  limit: number;
  before?: Date;
  review?: boolean; // only transactions waiting for the user's answer
  category?: string;
  q?: string;
}

export async function listTransactions(sql: Sql, userId: string, o: ListOptions) {
  const rows = await sql`
    select ${TXN_COLUMNS(sql)}
    from transactions t left join accounts a on a.id = t.account_id
    where t.user_id = ${userId} and t.occurred_at < ${o.before ?? new Date("9999-01-01")}
      ${o.review ? sql`and t.review_reason is not null and t.reviewed_at is null` : sql``}
      ${o.category ? sql`and t.category = ${o.category}` : sql``}
      ${o.q ? sql`and concat_ws(' ', t.label, t.ai_name, t.counterparty, t.counterparty_vpa, t.note, t.institution_name) ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"}` : sql``}
    order by t.occurred_at desc
    limit ${o.limit}`;
  return rows.map(rowOut);
}

export async function getTransaction(sql: Sql, userId: string, id: string) {
  const [row] = await sql`
    select ${TXN_COLUMNS(sql)}
    from transactions t left join accounts a on a.id = t.account_id
    where t.user_id = ${userId} and t.id = ${id}`;
  if (!row) return null;
  // Where the transaction came from, without the raw message text.
  const evidence = await sql`
    select e.id, e.source_type, e.sender, e.observed_at, e.parser, te.match_method
    from transaction_evidence te join evidence e on e.id = te.evidence_id
    where te.transaction_id = ${id} order by e.observed_at`;
  return { ...rowOut(row), evidence };
}

export interface ManualEntry {
  amount_minor: number;
  direction: "debit" | "credit";
  counterparty: string;
  category: string | null;
  occurred_at: Date;
  paid_with: string | null; // "Cash" or a bank name
  note: string | null;
}

export async function createManual(sql: Sql, userId: string, m: ManualEntry) {
  const cash = !m.paid_with || /^cash$/i.test(m.paid_with.trim());
  const institutionName = cash ? "Cash" : m.paid_with!.trim();
  const rules = await loadPayeeRules(sql, userId);
  const rule = findRule(rules, m.counterparty, null);
  const category =
    m.category ?? rule?.category ?? builtinCategory(m.counterparty) ?? (m.direction === "credit" ? "income" : null);
  // The user typed it in, so there is nothing to ask about and nothing to alert on.
  const [row] = await sql`
    insert into transactions (user_id, source, institution, institution_name, amount_minor, direction, event_type,
                              channel, occurred_at, counterparty, category, category_source, note,
                              reviewed_at, notified_at)
    values (${userId}, 'manual', ${cash ? "cash" : slugify(institutionName)}, ${institutionName}, ${m.amount_minor},
            ${m.direction}, ${m.direction === "credit" ? "income" : "purchase"}, ${cash ? "cash" : "unknown"},
            ${m.occurred_at}, ${m.counterparty}, ${category}, ${category ? "user" : null}, ${m.note},
            now(), now())
    returning id`;
  return getTransaction(sql, userId, row!.id);
}

export interface TxnPatch {
  label?: string | null;
  category?: string | null;
  note?: string | null;
  event_type?: string;
  excluded?: boolean;
  amount_minor?: number; // manual entries only
  occurred_at?: Date; // manual entries only
  remember?: boolean; // learn a payee rule and apply it to this payee's other unreviewed transactions
}

export type PatchResult = { ok: true; transaction: Awaited<ReturnType<typeof getTransaction>>; applied_to: number } | { ok: false; error: string };

export async function updateTransaction(sql: Sql, userId: string, id: string, p: TxnPatch): Promise<PatchResult | null> {
  const outcome = await sql.begin(async (tx) => {
    const [cur] = await tx`select * from transactions where id = ${id} and user_id = ${userId} for update`;
    if (!cur) return null;
    if ((p.amount_minor !== undefined || p.occurred_at !== undefined) && cur.source !== "manual") {
      return { ok: false as const, error: "bank_fields_read_only" };
    }
    const set = <K extends keyof TxnPatch>(k: K, fallback: unknown) => (p[k] === undefined ? fallback : p[k]);
    const next = {
      label: set("label", cur.label) as string | null,
      category: set("category", cur.category) as string | null,
      note: set("note", cur.note) as string | null,
      event_type: set("event_type", cur.event_type) as string,
      excluded: set("excluded", cur.excluded) as boolean,
      amount_minor: set("amount_minor", cur.amount_minor) as number | string,
      occurred_at: set("occurred_at", cur.occurred_at) as Date,
    };
    await tx`
      update transactions set
        label = ${next.label}, category = ${next.category}, note = ${next.note}, event_type = ${next.event_type},
        excluded = ${next.excluded}, amount_minor = ${next.amount_minor}, occurred_at = ${next.occurred_at},
        category_source = ${p.category !== undefined ? (next.category ? "user" : null) : cur.category_source},
        reviewed_at = now(), updated_at = now()
      where id = ${id}`;

    let applied = 0;
    if (p.remember) applied = await rememberPayee(tx, userId, id, cur.counterparty, cur.counterparty_vpa, next);
    return { ok: true as const, applied };
  });
  if (!outcome) return null;
  if (!outcome.ok) return outcome;
  return { ok: true, transaction: await getTransaction(sql, userId, id), applied_to: outcome.applied };
}

async function rememberPayee(
  tx: Tx, userId: string, sourceId: string, counterparty: string | null, vpa: string | null,
  v: { label: string | null; category: string | null; event_type: string },
): Promise<number> {
  const keys = payeeKeys(counterparty, vpa);
  const [kind, value] = keys.vpa ? (["vpa", keys.vpa] as const) : keys.name ? (["name", keys.name] as const) : [null, null];
  if (!kind) return 0;
  // Only remember a non-default kind, so "it was a transfer to my own account" sticks.
  const eventType = ["transfer", "card_payment", "cash_withdrawal"].includes(v.event_type) ? v.event_type : null;
  await tx`
    insert into payee_rules (user_id, match_kind, match_value, label, category, event_type)
    values (${userId}, ${kind}, ${value}, ${v.label}, ${v.category}, ${eventType})
    on conflict (user_id, match_kind, match_value) do update
      set label = excluded.label, category = excluded.category, event_type = excluded.event_type, updated_at = now()`;

  // Apply to the same payee's transactions the user hasn't answered for yet.
  const candidates = await tx`
    select id, counterparty, counterparty_vpa from transactions
    where user_id = ${userId} and id <> ${sourceId} and reviewed_at is null`;
  const ids = candidates
    .filter((c) => {
      const k = payeeKeys(c.counterparty, c.counterparty_vpa);
      return kind === "vpa" ? k.vpa === value : k.name === value;
    })
    .map((c) => c.id as string);
  if (!ids.length) return 0;
  await tx`
    update transactions set label = ${v.label}, category = ${v.category},
      category_source = ${v.category ? "rule" : null},
      event_type = coalesce(${eventType}, event_type), review_reason = null, updated_at = now()
    where id = any(${ids}::uuid[])`;
  return ids.length;
}

/** Manual entries can be deleted; bank transactions can only be excluded, since the SMS would recreate them. */
export async function deleteManual(sql: Sql, userId: string, id: string): Promise<"deleted" | "not_found" | "not_manual"> {
  const [row] = await sql`select source from transactions where id = ${id} and user_id = ${userId}`;
  if (!row) return "not_found";
  if (row.source !== "manual") return "not_manual";
  await sql`delete from transactions where id = ${id}`;
  return "deleted";
}

/** Categorises transactions created before categories existed. Safe to run repeatedly. */
export async function classifyBackfill(sql: Sql): Promise<number> {
  const rows = await sql`
    select t.id, t.user_id, t.direction, t.event_type, t.counterparty, t.counterparty_vpa,
           exists (select 1 from transaction_evidence te join evidence e on e.id = te.evidence_id
                   where te.transaction_id = t.id and e.parser like 'llm/%') as from_llm
    from transactions t
    where t.source = 'sms' and t.category is null and t.category_source is null
      and t.review_reason is null and t.reviewed_at is null`;
  const rulesByUser = new Map<string, Awaited<ReturnType<typeof loadPayeeRules>>>();
  let changed = 0;
  for (const r of rows) {
    if (!rulesByUser.has(r.user_id)) rulesByUser.set(r.user_id, await loadPayeeRules(sql, r.user_id));
    const c = classify(
      { direction: r.direction, eventType: r.event_type, counterparty: r.counterparty, vpa: r.counterparty_vpa, fromLlm: r.from_llm },
      rulesByUser.get(r.user_id)!,
    );
    if (!c.category && !c.reviewReason && !c.label) continue;
    await sql`
      update transactions set category = ${c.category}, category_source = ${c.categorySource}, label = ${c.label},
        event_type = ${c.eventType}, review_reason = ${c.reviewReason}
      where id = ${r.id}`;
    changed++;
  }
  return changed;
}
