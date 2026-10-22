import { classify, type PayeeRule } from "./classify.ts";
import { sha256, type Sealer } from "./crypto.ts";
import type { Sql, Tx } from "./db.ts";
import { groundExtraction, type SmsExtractor } from "./llm.ts";
import { parseSms, type ParseResult, type ParsedTxn } from "./sms/parser.ts";

const DAY_MS = 86_400_000;
// Raw text is kept only long enough to debug parsers, then nulled by purgeExpiredRaw.
const RETAIN_PARSED_MS = 30 * DAY_MS;
const RETAIN_UNRECOGNIZED_MS = 90 * DAY_MS;

export interface SmsInput {
  userId: string;
  deviceId: string | null;
  sender: string | null;
  body: string;
  receivedAt: Date;
  sourceId: string | null;
}

export type SourceType = "sms" | "email";

export interface EmailInput {
  userId: string;
  from: string;
  /** Subject plus the alert part of the body (see mail/filter.ts alertText). */
  text: string;
  receivedAt: Date;
  messageId: string | null;
}

export type EvidenceStatus = "linked" | "ignored" | "unrecognized" | "ambiguous";

export interface IngestOutcome {
  evidenceId: string;
  status: EvidenceStatus;
  reason: string | null;
  transactionId: string | null;
  duplicate: boolean;
}

/**
 * Stores an SMS as evidence and resolves it to a canonical transaction.
 * Idempotent: resending the same text returns the original outcome.
 * Unrecognized messages are left for processUnrecognized (LLM fallback).
 */
export function ingestSms(sql: Sql, sealer: Sealer, timeZone: string, input: SmsInput): Promise<IngestOutcome> {
  return ingest(sql, sealer, timeZone, "sms", input);
}

/**
 * Stores a bank alert email as evidence. Emails go through the same parser and
 * LLM fallback as SMS; the Message-ID makes re-reading the same mail a no-op.
 */
export function ingestEmail(sql: Sql, sealer: Sealer, timeZone: string, input: EmailInput): Promise<IngestOutcome> {
  return ingest(sql, sealer, timeZone, "email", {
    userId: input.userId,
    deviceId: null,
    sender: input.from,
    body: input.text,
    receivedAt: input.receivedAt,
    sourceId: input.messageId,
  });
}

async function ingest(sql: Sql, sealer: Sealer, timeZone: string, sourceType: SourceType, input: SmsInput): Promise<IngestOutcome> {
  const normalized = input.body.trim().replace(/\s+/g, " ");
  const hash = sha256(sourceType === "email" && input.sourceId ? `email:${input.sourceId}` : normalized);
  const parsed = parseSms(input.sender, input.body, input.receivedAt, timeZone);

  const raw = parsed.kind === "ignored" ? null : sealer.seal(input.body);
  const retainMs = parsed.kind === "unrecognized" ? RETAIN_UNRECOGNIZED_MS : RETAIN_PARSED_MS;

  return sql.begin(async (tx) => {
    const [ev] = await tx`
      insert into evidence (user_id, device_id, source_type, source_id, sender, observed_at,
                            content_hash, raw_content_enc, retention_until, status)
      values (${input.userId}, ${input.deviceId}, ${sourceType}, ${input.sourceId}, ${input.sender}, ${input.receivedAt},
              ${hash}, ${raw}, ${raw ? new Date(Date.now() + retainMs) : null}, 'new')
      on conflict (user_id, content_hash) do nothing
      returning id`;

    if (!ev) {
      const [prev] = await tx`
        select e.id, e.status, e.status_reason, te.transaction_id
        from evidence e left join transaction_evidence te on te.evidence_id = e.id
        where e.user_id = ${input.userId} and e.content_hash = ${hash}`;
      return {
        evidenceId: prev!.id, status: prev!.status, reason: prev!.status_reason,
        transactionId: prev!.transaction_id, duplicate: true,
      };
    }

    const r = await applyParseResult(tx, ev.id, input.userId, parsed, input.receivedAt, sourceType);
    return { evidenceId: ev.id, ...r, duplicate: false };
  }) as Promise<IngestOutcome>;
}

/** Records a parse result on an evidence row and, for transactions, resolves and links it. */
async function applyParseResult(tx: Tx, evidenceId: string, userId: string, parsed: ParseResult, receivedAt: Date, sourceType: SourceType) {
  if (parsed.kind !== "transaction") {
    await tx`
      update evidence set status = ${parsed.kind}, status_reason = ${parsed.reason}, parser = ${parsed.parser},
        raw_content_enc = ${parsed.kind === "ignored" ? null : tx`raw_content_enc`}
      where id = ${evidenceId}`;
    return { status: parsed.kind, reason: parsed.reason, transactionId: null } as const;
  }

  const occurredAt = parsed.txn.occurredAt ?? receivedAt;
  const res = await resolveTransaction(tx, userId, parsed.txn, occurredAt, parsed.parser.startsWith("llm/"), sourceType);
  await tx`
    update evidence set status = ${res.status}, status_reason = ${res.reason}, parser = ${parsed.parser},
      parsed = ${tx.json(parsed.txn as never)}, occurred_at = ${occurredAt}
    where id = ${evidenceId}`;
  if (res.transactionId) {
    await tx`
      insert into transaction_evidence (transaction_id, evidence_id, match_method)
      values (${res.transactionId}, ${evidenceId}, ${res.method})`;
  }
  return { status: res.status, reason: res.reason, transactionId: res.transactionId };
}

interface Resolution {
  status: "linked" | "ambiguous";
  reason: string | null;
  transactionId: string | null;
  method: "created" | "reference" | "heuristic";
}

// How close an SMS and an email for the same payment must be in time.
const CROSS_SOURCE_WINDOW_MS = 15 * 60_000;
const CROSS_SOURCE_WINDOW_NO_TIME_MS = 36 * 3_600_000; // the message only gave a date

/**
 * Matches on the bank/UPI reference first. Without one, an email may join a
 * transaction that so far only has an SMS (and vice versa) when bank, amount
 * and direction agree and the times are close: the same alert sent twice.
 * Two messages from the same source are never merged that way, because two
 * identical purchases are legitimate and each sends its own SMS.
 */
async function resolveTransaction(tx: Tx, userId: string, t: ParsedTxn, occurredAt: Date, fromLlm: boolean, sourceType: SourceType): Promise<Resolution> {
  if (t.reference) {
    const [existing] = await tx`
      select id, amount_minor from transactions
      where user_id = ${userId} and reference = ${t.reference} and direction = ${t.direction}
      for update`;
    if (existing) {
      if (Number(existing.amount_minor) !== t.amountMinor) {
        return { status: "ambiguous", reason: "reference_amount_mismatch", transactionId: null, method: "reference" };
      }
      await enrich(tx, userId, existing.id, t);
      return { status: "linked", reason: null, transactionId: existing.id, method: "reference" };
    }
  }

  const window = t.timeKnown ? CROSS_SOURCE_WINDOW_MS : CROSS_SOURCE_WINDOW_NO_TIME_MS;
  const [twin] = await tx`
    select t.id from transactions t
    where t.user_id = ${userId} and t.source <> 'manual'
      and t.amount_minor = ${t.amountMinor} and t.direction = ${t.direction} and t.institution = ${t.institution}
      and t.occurred_at between ${new Date(occurredAt.getTime() - window)} and ${new Date(occurredAt.getTime() + window)}
      and not exists (
        select 1 from transaction_evidence te join evidence e on e.id = te.evidence_id
        where te.transaction_id = t.id and e.source_type = ${sourceType})
    order by abs(extract(epoch from t.occurred_at - ${occurredAt}::timestamptz))
    limit 1
    for update`;
  if (twin) {
    await enrich(tx, userId, twin.id, t);
    return { status: "linked", reason: null, transactionId: twin.id, method: "heuristic" };
  }

  const accountId = t.last4 ? await upsertAccount(tx, userId, t) : null;
  const rules = await loadPayeeRules(tx, userId);
  const c = classify({ direction: t.direction, eventType: t.eventType, counterparty: t.counterparty, vpa: t.vpa, fromLlm }, rules);
  const [created] = await tx`
    insert into transactions (user_id, account_id, institution, institution_name, amount_minor, direction,
                              event_type, channel, occurred_at, counterparty, counterparty_vpa, reference,
                              category, category_source, label, review_reason, source)
    values (${userId}, ${accountId}, ${t.institution}, ${t.institutionName}, ${t.amountMinor}, ${t.direction},
            ${c.eventType}, ${t.channel}, ${occurredAt}, ${t.counterparty}, ${t.vpa}, ${t.reference},
            ${c.category}, ${c.categorySource}, ${c.label}, ${c.reviewReason}, ${sourceType})
    on conflict (user_id, reference, direction) where reference is not null do nothing
    returning id`;
  if (created) return { status: "linked", reason: null, transactionId: created.id, method: "created" };

  // Lost a race with a concurrent insert of the same reference.
  const [winner] = await tx`
    select id from transactions where user_id = ${userId} and reference = ${t.reference} and direction = ${t.direction}`;
  return { status: "linked", reason: null, transactionId: winner!.id, method: "reference" };
}

/**
 * Fills gaps on a transaction from a second message about it: the reference,
 * payee, UPI ID and account the first message left out. Never overwrites.
 */
async function enrich(tx: Tx, userId: string, transactionId: string, t: ParsedTxn) {
  const accountId = t.last4 ? await upsertAccount(tx, userId, t) : null;
  // A reference already used by another transaction is left alone (unique per user and direction).
  const [{ taken }] = (await tx`
    select exists (select 1 from transactions where user_id = ${userId} and reference = ${t.reference} and direction = ${t.direction}) as taken`) as unknown as [{ taken: boolean }];
  await tx`
    update transactions set
      reference = coalesce(reference, ${taken ? null : t.reference}),
      counterparty = coalesce(counterparty, ${t.counterparty}),
      counterparty_vpa = coalesce(counterparty_vpa, ${t.vpa}),
      account_id = coalesce(account_id, ${accountId}),
      updated_at = now()
    where id = ${transactionId}`;
}

export async function loadPayeeRules(sql: Sql | Tx, userId: string): Promise<PayeeRule[]> {
  return (await sql`
    select match_kind, match_value, label, category, event_type from payee_rules where user_id = ${userId}`) as unknown as PayeeRule[];
}

async function upsertAccount(tx: Tx, userId: string, t: ParsedTxn): Promise<string> {
  const [row] = await tx`
    insert into accounts (user_id, institution, institution_name, kind, last4)
    values (${userId}, ${t.institution}, ${t.institutionName}, ${t.accountKind}, ${t.last4})
    on conflict (user_id, institution, last4) do update
      set kind = case when accounts.kind = 'unknown' then excluded.kind else accounts.kind end,
          institution_name = coalesce(accounts.institution_name, excluded.institution_name)
    returning id`;
  return row!.id;
}

const LLM_MAX_ATTEMPTS = 3;
const LLM_CLAIM_TIMEOUT = "5 minutes";

/**
 * Sends unrecognized SMS through the LLM fallback. Rows are claimed first
 * (so the model call happens outside any transaction and concurrent workers
 * don't double-process), then each result is applied in its own transaction.
 * Failed calls stay unrecognized and are retried up to LLM_MAX_ATTEMPTS.
 */
export async function processUnrecognized(
  sql: Sql, sealer: Sealer, extractor: SmsExtractor, timeZone: string, batch = 10,
): Promise<{ processed: number; failed: number }> {
  const claimed = await sql`
    update evidence set llm_attempts = llm_attempts + 1, llm_claimed_at = now()
    where id in (
      select id from evidence
      where status = 'unrecognized' and raw_content_enc is not null and llm_attempts < ${LLM_MAX_ATTEMPTS}
        and (llm_claimed_at is null or llm_claimed_at < now() - ${LLM_CLAIM_TIMEOUT}::interval)
      order by ingested_at
      limit ${batch}
      for update skip locked)
    returning id, user_id, sender, observed_at, raw_content_enc, source_type`;

  let failed = 0;
  for (const row of claimed) {
    const body = sealer.open(row.raw_content_enc);
    try {
      const extraction = await extractor.extract(row.sender, body);
      const parsed = groundExtraction(extraction, body, row.observed_at, timeZone, extractor.name);
      await sql.begin(async (tx) => {
        await applyParseResult(tx, row.id, row.user_id, parsed, row.observed_at, row.source_type);
        // A usable answer that still isn't a transaction is final; asking again costs a call for the same verdict.
        const attempts = parsed.kind === "unrecognized" ? LLM_MAX_ATTEMPTS : tx`llm_attempts`;
        await tx`update evidence set llm_error = null, llm_attempts = ${attempts} where id = ${row.id}`;
      });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      await sql`update evidence set llm_error = ${message.slice(0, 500)}, llm_claimed_at = null where id = ${row.id}`;
    }
  }
  return { processed: claimed.length - failed, failed };
}

/** Drops raw message text whose retention window has passed. */
export async function purgeExpiredRaw(sql: Sql): Promise<number> {
  const r = await sql`
    update evidence set raw_content_enc = null
    where raw_content_enc is not null and retention_until < now()`;
  return r.count;
}
