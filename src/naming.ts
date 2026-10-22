// Clean payee names (and, when it's sure, a category) from the model, for payees
// the rules can't name well: "SWIGGYI14242463", "paperandpie.12345678@hdfcbank",
// or a payment whose payee was lost. One lookup per payee, cached per user.
// The name goes into ai_name, never over the user's own label.
import Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CATEGORIES, CATEGORY_IDS } from "./categories.ts";
import { payeeKeys } from "./classify.ts";
import type { Sealer } from "./crypto.ts";
import type { Sql } from "./db.ts";
import { looksLikeProse, parseSms } from "./sms/parser.ts";

export const PayeeGuess = z.object({
  name: z.string().nullable(),
  kind: z.enum(["merchant", "person", "self", "unknown"]),
  category: z.enum(CATEGORY_IDS).nullable(),
  confident: z.boolean(),
});
export type PayeeGuess = z.infer<typeof PayeeGuess>;

export interface PayeeQuestion {
  counterparty: string | null;
  vpa: string | null;
  bank: string | null;
  direction: "debit" | "credit";
  amount: string;
  /** The bank alert itself, when it's still kept; helps when the payee field is missing. */
  alert: string | null;
}

export interface PayeeNamer {
  name(q: PayeeQuestion): Promise<PayeeGuess>;
}

const SYSTEM = `You name the other party of an Indian bank transaction for a personal expense app.

From the payee field, UPI ID and (if given) the bank's alert text, say who was paid or who paid:
- name: how a person would say it: "Swiggy", "MakeMyTrip", "Paper & Pie", "Indian Oil". Drop payment-gateway noise, order and terminal numbers, "PVT LTD", "INDIA", city suffixes and UPI handles. For a person, their name in normal case ("Ramesh Kumar") if it's in the data. null if the data doesn't say.
- kind: merchant (a business), person (an individual), self (the user's own account, card bill or wallet top-up) or unknown.
- category: one of ${CATEGORIES.map((c) => c.id).join(", ")}; only for a merchant whose business you recognise; otherwise null.
- confident: true only if you recognise the merchant or the data spells it out. Guessing from a bare UPI handle or digits is not confident.
Never invent a name that isn't supported by the data or widely known from the handle (e.g. "swiggy@icici" is Swiggy).`;

export class ClaudePayeeNamer implements PayeeNamer {
  #client: Anthropic;
  #model: string;
  constructor(model: string, client = new Anthropic()) {
    this.#model = model;
    this.#client = client;
  }
  async name(q: PayeeQuestion): Promise<PayeeGuess> {
    const res = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: 1024,
      output_config: { effort: "low", format: zodOutputFormat(PayeeGuess) },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          `Direction: ${q.direction === "debit" ? "money paid out" : "money received"} (${q.amount})`,
          `Bank: ${q.bank ?? "unknown"}`,
          `Payee field: ${q.counterparty ?? "(none)"}`,
          `UPI ID: ${q.vpa ?? "(none)"}`,
          q.alert ? `Bank alert:\n${q.alert}` : null,
        ].filter(Boolean).join("\n"),
      }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no payee guess (stop_reason=${res.stop_reason})`);
    return res.parsed_output;
  }
}

/** Payees whose name is already clean don't need a lookup: plain words, no digits, no UPI handle. */
export function needsNaming(counterparty: string | null, vpa: string | null): boolean {
  if (!counterparty) return true;
  if (vpa && counterparty.trim().toLowerCase() === vpa.trim().toLowerCase()) return true;
  return /\d{3,}|@|_|\b(pvt|ltd|private|limited|india|payu|razorpay|cashfree|billdesk|ccavenue)\b/i.test(counterparty) || counterparty === counterparty.toUpperCase();
}

const CACHE_KEY = (counterparty: string | null, vpa: string | null) => {
  const k = payeeKeys(counterparty, vpa);
  return k.vpa ? `vpa:${k.vpa}` : k.name ? `name:${k.name}` : null;
};

/**
 * Names a batch of transactions that haven't been looked at yet. Returns how
 * many it looked at (0 means nothing is waiting).
 */
export async function nameTransactions(sql: Sql, sealer: Sealer, namer: PayeeNamer, batch = 20): Promise<{ looked: number; asked: number; failed: number }> {
  const rows = await sql`
    select t.id, t.user_id, t.counterparty, t.counterparty_vpa, t.institution_name, t.direction, t.amount_minor,
           t.category, t.category_source, t.label, t.review_reason, t.reviewed_at,
           (select e.raw_content_enc from transaction_evidence te join evidence e on e.id = te.evidence_id
             where te.transaction_id = t.id and e.raw_content_enc is not null order by e.ingested_at limit 1) as raw
    from transactions t
    where t.named_at is null
    order by t.created_at desc
    limit ${batch}`;
  let asked = 0;
  let failed = 0;
  for (const t of rows) {
    // The user already named it, or the bank's name is fine as it is.
    if (t.label || !needsNaming(t.counterparty, t.counterparty_vpa)) {
      await sql`update transactions set named_at = now() where id = ${t.id}`;
      continue;
    }
    const key = CACHE_KEY(t.counterparty, t.counterparty_vpa);
    let guess: PayeeGuess | null = null;
    if (key) {
      const [hit] = await sql`select name, kind, category, confident from payee_names where user_id = ${t.user_id} and key = ${key}`;
      if (hit) guess = { name: hit.name, kind: hit.kind, category: hit.category, confident: hit.confident };
    }
    if (!guess) {
      try {
        asked++;
        guess = await namer.name({
          counterparty: t.counterparty, vpa: t.counterparty_vpa, bank: t.institution_name, direction: t.direction,
          amount: `₹${(Number(t.amount_minor) / 100).toFixed(2)}`, alert: t.raw ? sealer.open(t.raw).slice(0, 800) : null,
        });
      } catch {
        failed++;
        continue; // left for the next run
      }
      if (key) {
        await sql`
          insert into payee_names (user_id, key, name, kind, category, confident)
          values (${t.user_id}, ${key}, ${guess.name}, ${guess.kind}, ${guess.category}, ${guess.confident})
          on conflict (user_id, key) do nothing`;
      }
    }
    await applyGuess(sql, t as unknown as NamingRow, guess);
  }
  return { looked: rows.length, asked, failed };
}

/**
 * Repairs payee names stored by an older parser that read a sentence as the
 * payee ("inform you that Rs"). Re-parses the alert when it's still kept,
 * otherwise clears the name; either way the namer looks at it again.
 */
export async function repairProseNames(sql: Sql, sealer: Sealer, timeZone: string): Promise<number> {
  const rows = await sql`
    select t.id, t.counterparty,
           (select e.raw_content_enc from transaction_evidence te join evidence e on e.id = te.evidence_id
             where te.transaction_id = t.id and e.raw_content_enc is not null order by e.ingested_at limit 1) as raw,
           (select e.sender from transaction_evidence te join evidence e on e.id = te.evidence_id
             where te.transaction_id = t.id order by e.ingested_at limit 1) as sender
    from transactions t where t.counterparty is not null and t.source <> 'manual'`;
  let fixed = 0;
  for (const r of rows) {
    if (!looksLikeProse(r.counterparty)) continue;
    const reparsed = r.raw ? parseSms(r.sender, sealer.open(r.raw), new Date(), timeZone) : null;
    const name = reparsed?.kind === "transaction" ? reparsed.txn.counterparty : null;
    await sql`update transactions set counterparty = ${name}, ai_name = null, named_at = null where id = ${r.id}`;
    fixed++;
  }
  return fixed;
}

interface NamingRow {
  id: string;
  category: string | null;
  category_source: string | null;
  review_reason: string | null;
  reviewed_at: Date | null;
}

async function applyGuess(sql: Sql, t: NamingRow, g: PayeeGuess) {
  const merchant = g.kind === "merchant" && g.confident;
  const category = merchant && g.category && !t.category && t.category_source !== "user" ? g.category : null;
  // A confident merchant answers "who/what was this?"; AI-read payments still ask to be checked.
  const clearReview = merchant && !t.reviewed_at && (t.review_reason === "unknown_payee" || (t.review_reason === "uncategorized" && (category ?? t.category) !== null));
  await sql`
    update transactions set
      named_at = now(),
      ai_name = ${g.name && (g.confident || g.kind === "person") ? g.name : null},
      category = coalesce(category, ${category}),
      category_source = case when ${category}::text is not null and category is null then 'ai' else category_source end,
      review_reason = case when ${clearReview} then null else review_reason end
    where id = ${t.id}`;
}

/** Names new transactions in the background: every 30 seconds, draining what's waiting. */
export class NamingWorker {
  #running = false;
  #run: () => ReturnType<typeof nameTransactions>;
  #log: FastifyBaseLogger;

  constructor(sql: Sql, sealer: Sealer, namer: PayeeNamer, log: FastifyBaseLogger) {
    this.#run = () => nameTransactions(sql, sealer, namer);
    this.#log = log;
  }

  start(intervalMs = 30_000) {
    setInterval(() => void this.#drain(), intervalMs).unref();
    void this.#drain();
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let i = 0; i < 50; i++) {
        const r = await this.#run();
        if (r.asked || r.failed) this.#log.info(r, "payee naming batch");
        if (r.looked < 20 || r.failed === r.looked) return;
      }
    } catch (err) {
      this.#log.error({ err }, "payee naming failed");
    } finally {
      this.#running = false;
    }
  }
}
