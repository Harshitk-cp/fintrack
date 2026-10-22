// SIPs (systematic investment plans): added by the user, or picked up from a
// bank/fund alert that mentions one. A month's SIP counts as savings once it's
// paid, either because the user ticked it or because a debit alert matched it.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { Sealer } from "./crypto.ts";
import type { Sql, Tx } from "./db.ts";
import { allAmounts, toMinor } from "./sms/parser.ts";

/** Alerts worth reading for SIP details. */
export const mentionsSip = (text: string) => /\b(sip|systematic investment|mutual fund|nach.*(fund|mf)|amc)\b/i.test(text);

export const SipReading = z.object({
  is_sip: z.boolean(),
  scheme: z.string().nullable(),
  amount: z.string().nullable(),
  status: z.enum(["debited", "scheduled", "failed", "other"]),
  confident: z.boolean(),
});
export type SipReading = z.infer<typeof SipReading>;

export interface SipReader {
  read(text: string): Promise<SipReading>;
}

const SYSTEM = `You read Indian bank and mutual-fund alerts about SIPs (systematic investment plans).

- is_sip: the message is about a SIP or mutual-fund instalment (not an insurance premium, loan EMI or ad).
- scheme: the fund or scheme name as written (e.g. "Parag Parikh Flexi Cap Fund - Direct Growth"), or the AMC if that's all it says. null if not stated.
- amount: the instalment amount as written, without currency symbol. null if not stated.
- status: debited (money taken or units allotted), scheduled (an upcoming debit or reminder), failed, or other.
- confident: true only if scheme and amount are both stated plainly. Never guess a scheme from the bank name alone.`;

export class ClaudeSipReader implements SipReader {
  #client: Anthropic;
  #model: string;
  constructor(model: string, client = new Anthropic()) {
    this.#model = model;
    this.#client = client;
  }
  async read(text: string): Promise<SipReading> {
    const res = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: 1024,
      output_config: { effort: "low", format: zodOutputFormat(SipReading) },
      system: SYSTEM,
      messages: [{ role: "user", content: text.slice(0, 1500) }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no sip reading (stop_reason=${res.stop_reason})`);
    return res.parsed_output;
  }
}

const monthOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(d);

/** Records a paid month for a SIP; linked to the bank transaction when there is one. */
export async function markPaid(sql: Sql | Tx, sipId: string, month: string, amountMinor: number, transactionId: string | null) {
  await sql`
    insert into sip_payments (sip_id, month, amount_minor, transaction_id) values (${sipId}, ${month}, ${amountMinor}, ${transactionId})
    on conflict (sip_id, month) do update set transaction_id = coalesce(sip_payments.transaction_id, excluded.transaction_id)`;
  if (transactionId) {
    // The debit is savings, not spending, and needs no further questions.
    await sql`
      update transactions set category = 'investments', category_source = case when category_source = 'user' then category_source else 'ai' end,
        review_reason = case when review_reason in ('unknown_payee', 'uncategorized') then null else review_reason end
      where id = ${transactionId} and coalesce(category_source, '') <> 'user'`;
  }
}

/** A SIP with this name (case-insensitive), or a new one. */
async function findOrCreateSip(tx: Tx, userId: string, scheme: string, amountMinor: number, day: number | null) {
  const [found] = await tx`
    select id from sips where user_id = ${userId}
      and (lower(name) = lower(${scheme}) or lower(name) like ${`%${scheme.toLowerCase().slice(0, 24)}%`} or ${scheme.toLowerCase()} like '%' || lower(name) || '%')
    order by active desc, created_at limit 1`;
  if (found) return found.id as string;
  const [made] = await tx`
    insert into sips (user_id, name, amount_minor, day_of_month, source) values (${userId}, ${scheme}, ${amountMinor}, ${day}, 'detected')
    on conflict (user_id, lower(name)) do update set active = true returning id`;
  return made!.id as string;
}

/**
 * Reads new SIP mentions. Clear, debited instalments become a paid month on a
 * (new or existing) SIP; clear reminders just make sure the SIP exists. Anything
 * the reader isn't sure of is left for the user in Review.
 */
export async function processSipSuggestions(sql: Sql, sealer: Sealer, reader: SipReader | null, timeZone: string, batch = 10) {
  const rows = await sql`
    select s.id, s.user_id, s.transaction_id, e.raw_content_enc, e.occurred_at, e.observed_at
    from sip_suggestions s join evidence e on e.id = s.evidence_id
    where s.status = 'new' and s.attempts < 3
    order by s.created_at limit ${batch}`;
  let done = 0;
  for (const r of rows) {
    await sql`update sip_suggestions set attempts = attempts + 1 where id = ${r.id}`;
    if (!reader || !r.raw_content_enc) {
      await sql`update sip_suggestions set status = 'needs_user' where id = ${r.id}`;
      continue;
    }
    const text = sealer.open(r.raw_content_enc);
    let reading: SipReading;
    try {
      reading = await reader.read(text);
    } catch {
      continue; // retried next run
    }
    // Same rule as the SMS fallback: an amount the model reports must be written in the message.
    const amount = reading.amount ? toMinor(reading.amount.replace(/^(rs\.?|inr|₹)\s*/i, "").trim()) : null;
    const grounded = amount !== null && allAmounts(text).includes(amount) ? amount : null;
    const scheme = reading.scheme?.trim() || null;
    if (!reading.is_sip) {
      await sql`update sip_suggestions set status = 'dismissed' where id = ${r.id}`;
    } else if (reading.confident && scheme && grounded && (reading.status === "debited" || reading.status === "scheduled")) {
      const when: Date = r.occurred_at ?? r.observed_at;
      await sql.begin(async (tx) => {
        const day = Number(new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric" }).format(when));
        const sipId = await findOrCreateSip(tx, r.user_id, scheme, grounded, day);
        if (reading.status === "debited") await markPaid(tx, sipId, monthOf(when, timeZone), grounded, r.transaction_id);
        await tx`update sip_suggestions set status = 'matched', scheme = ${scheme}, amount_minor = ${grounded} where id = ${r.id}`;
      });
    } else {
      await sql`update sip_suggestions set status = 'needs_user', scheme = ${scheme}, amount_minor = ${grounded} where id = ${r.id}`;
    }
    done++;
  }
  return { looked: rows.length, done };
}

export class SipWorker {
  #run: () => ReturnType<typeof processSipSuggestions>;
  #log: FastifyBaseLogger;
  #running = false;
  constructor(sql: Sql, sealer: Sealer, reader: SipReader | null, timeZone: string, log: FastifyBaseLogger) {
    this.#run = () => processSipSuggestions(sql, sealer, reader, timeZone);
    this.#log = log;
  }
  start(intervalMs = 60_000) {
    setInterval(() => void this.tick(), intervalMs).unref();
    void this.tick();
  }
  async tick() {
    if (this.#running) return;
    this.#running = true;
    try {
      const r = await this.#run();
      if (r.looked) this.#log.info(r, "sip suggestions");
    } catch (err) {
      this.#log.error({ err }, "sip suggestions failed");
    } finally {
      this.#running = false;
    }
  }
}
