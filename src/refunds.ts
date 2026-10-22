// Refunds linked by the user: money back for a purchase, optionally tied to the
// credit it arrived as. See stats.ts for how they change the totals.
import type { Sql } from "./db.ts";

export type RefundResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "not_a_purchase" | "credit_not_found" | "credit_already_linked" | "more_than_purchase" | "more_than_credit" };

/** Records `amountMinor` refunded against a purchase; `creditId` is the refund's own credit, if the user found it. */
export async function addRefund(sql: Sql, userId: string, purchaseId: string, amountMinor: number, creditId: string | null): Promise<RefundResult> {
  return sql.begin(async (tx) => {
    const [p] = await tx`select id, direction, amount_minor from transactions where id = ${purchaseId} and user_id = ${userId} for update`;
    if (!p) return { ok: false, error: "not_found" } as const;
    if (p.direction !== "debit") return { ok: false, error: "not_a_purchase" } as const;
    const [{ done }] = (await tx`select coalesce(sum(amount_minor), 0) as done from refunds where purchase_id = ${purchaseId}`) as unknown as [{ done: string }];
    if (Number(done) + amountMinor > Number(p.amount_minor)) return { ok: false, error: "more_than_purchase" } as const;

    if (creditId) {
      const [c] = await tx`
        select id, amount_minor, exists (select 1 from refunds r where r.refund_txn_id = t.id) as linked
        from transactions t where id = ${creditId} and user_id = ${userId} and direction = 'credit' for update`;
      if (!c) return { ok: false, error: "credit_not_found" } as const;
      if (c.linked) return { ok: false, error: "credit_already_linked" } as const;
      if (amountMinor > Number(c.amount_minor)) return { ok: false, error: "more_than_credit" } as const;
      // The credit is answered: it's a refund, not income.
      await tx`update transactions set event_type = 'refund', review_reason = null, reviewed_at = coalesce(reviewed_at, now()), updated_at = now() where id = ${creditId}`;
    }
    const [r] = await tx`
      insert into refunds (user_id, purchase_id, refund_txn_id, amount_minor) values (${userId}, ${purchaseId}, ${creditId}, ${amountMinor})
      returning id`;
    return { ok: true, id: r!.id as string } as const;
  });
}

export async function removeRefund(sql: Sql, userId: string, id: string) {
  const r = await sql`delete from refunds where id = ${id} and user_id = ${userId}`;
  return r.count > 0;
}
