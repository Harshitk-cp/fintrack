import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Assistant } from "./assistant.ts";
import { CATEGORIES, CATEGORY_IDS } from "./categories.ts";
import { newDeviceToken, normalizePairingCode, sha256, type Sealer } from "./crypto.ts";
import type { Sql } from "./db.ts";
import { ingestSms } from "./ingest.ts";
import { createManual, deleteManual, getTransaction, listTransactions, updateTransaction } from "./ledger.ts";
import { newPushTopic, type Notifier } from "./notify.ts";
import { looksLikeOtp } from "./sms/parser.ts";
import { isReceived, isRefund, isSpend } from "./stats.ts";

interface Device {
  id: string;
  userId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    device: Device;
  }
}

export interface ApiDeps {
  sql: Sql;
  sealer: Sealer;
  timeZone: string;
  logger?: boolean;
  onUnrecognized?: () => void; // wakes the LLM fallback worker
  notifier?: Notifier | null;
  assistant?: Assistant | null;
}

// iOS Shortcuts sends "" for unset fields and may format Sender loosely, so
// optional fields are normalised instead of rejected.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const SmsBody = z.object({
  body: z.string().trim().min(1).max(2000),
  sender: z.preprocess(blankToUndefined, z.string().transform((s) => s.trim().slice(0, 40)).optional()),
  received_at: z.preprocess(blankToUndefined, z.iso.datetime({ offset: true }).optional()),
  source_id: z.preprocess(blankToUndefined, z.string().max(200).optional()),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
  review: z.enum(["1", "true"]).optional(),
  category: z.enum(CATEGORY_IDS).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

const Id = z.object({ id: z.uuid() });
const text = (max: number) => z.string().trim().max(max).transform((s) => s || null);

const ManualBody = z.object({
  amount_minor: z.number().int().positive().max(1_000_000_000),
  direction: z.enum(["debit", "credit"]).default("debit"),
  counterparty: z.string().trim().min(1).max(80),
  category: z.enum(CATEGORY_IDS).nullable().default(null),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  paid_with: text(60).nullable().default(null),
  note: text(500).nullable().default(null),
});

// Event types a user may pick. "unknown" from the parser shows as a purchase.
const USER_EVENT_TYPES = ["purchase", "transfer", "income", "refund", "fee", "card_payment", "cash_withdrawal"] as const;

const PatchBody = z.object({
  label: text(80).nullable().optional(),
  category: z.enum(CATEGORY_IDS).nullable().optional(),
  note: text(500).nullable().optional(),
  event_type: z.enum(USER_EVENT_TYPES).optional(),
  excluded: z.boolean().optional(),
  amount_minor: z.number().int().positive().max(1_000_000_000).optional(),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  remember: z.boolean().optional(),
});

const SettingsBody = z.object({
  alert_min_minor: z.number().int().min(0).max(100_000_000).optional(),
  digest_hour: z.number().int().min(0).max(23).optional(),
  monthly_budget_minor: z.number().int().positive().max(10_000_000_000).nullable().optional(),
  push_enabled: z.boolean().optional(),
});

const AskBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(20)
    .refine((m) => m[0]!.role === "user" && m.at(-1)!.role === "user" && m.every((x, i) => i === 0 || x.role !== m[i - 1]!.role), {
      message: "messages must alternate, starting and ending with the user",
    }),
});

const PairBody = z.object({ code: z.string().trim().min(8).max(20) });

const SummaryQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BACKFILL_MS = 30 * 86_400_000;

export async function buildApi({ sql, sealer, timeZone, logger = true, onUnrecognized, notifier = null, assistant = null }: ApiDeps) {
  const app = Fastify({
    trustProxy: true, // behind Caddy
    bodyLimit: 16 * 1024,
    logger: logger && { redact: ["req.headers.authorization"] },
  });

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
  });

  app.decorateRequest("device", null as unknown as Device);

  const unauthorized = () => Object.assign(new Error("unauthorized"), { statusCode: 401 });

  async function authenticate(req: FastifyRequest) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) throw unauthorized();
    const [row] = await sql`
      update devices set last_seen_at = now()
      where token_hash = ${sha256(token)} and revoked_at is null
      returning id, user_id`;
    if (!row) throw unauthorized();
    req.device = { id: row.id, userId: row.user_id };
  }

  const authed = { onRequest: authenticate, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  app.get("/healthz", async () => {
    await sql`select 1`;
    return { ok: true };
  });

  app.post("/v1/sms", authed, async (req, reply) => {
    const parsed = SmsBody.safeParse(req.body);
    if (!parsed.success) {
      // Shape only, never the message text: helps debug Shortcut setups.
      const fields = req.body && typeof req.body === "object" ? Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, typeof v])) : typeof req.body;
      req.log.warn({ issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })), fields, contentType: req.headers["content-type"] }, "invalid sms body");
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const b = parsed.data;

    // Refuse before anything touches the database.
    if (looksLikeOtp(b.body)) return reply.code(422).send({ error: "otp_rejected", stored: false });

    const now = Date.now();
    let receivedAt = b.received_at ? new Date(b.received_at) : new Date(now);
    const age = now - receivedAt.getTime();
    if (age < -MAX_CLOCK_SKEW_MS || age > MAX_BACKFILL_MS) receivedAt = new Date(now);

    const outcome = await ingestSms(sql, sealer, timeZone, {
      userId: req.device.userId,
      deviceId: req.device.id,
      sender: b.sender ?? null,
      body: b.body,
      receivedAt,
      sourceId: b.source_id ?? null,
    });
    if (outcome.status === "unrecognized" && !outcome.duplicate) onUnrecognized?.();
    if (outcome.transactionId && !outcome.duplicate) notifier?.kick();
    return outcome;
  });

  // Unauthenticated by design: the one-time code is the credential. Tight per-IP limit.
  app.post("/v1/pair", { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (r: FastifyRequest) => r.ip } } }, async (req, reply) => {
    const parsed = PairBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const codeHash = sha256(normalizePairingCode(parsed.data.code));
    const { token, hash } = newDeviceToken();
    const result = await sql.begin(async (tx) => {
      const [code] = await tx`
        select p.user_id, p.device_name, p.platform, u.name as user_name
        from pairing_codes p join users u on u.id = p.user_id
        where p.code_hash = ${codeHash} and p.redeemed_at is null and p.expires_at > now()
        for update of p`;
      if (!code) return null;
      const [device] = await tx`
        insert into devices (user_id, name, platform, token_hash)
        values (${code.user_id}, ${code.device_name}, ${code.platform}, ${hash}) returning id`;
      await tx`update pairing_codes set redeemed_at = now(), device_id = ${device!.id} where code_hash = ${codeHash}`;
      return { token, device_id: device!.id, user: { id: code.user_id, name: code.user_name } };
    });
    if (!result) return reply.code(404).send({ error: "invalid_or_expired_code" });
    return result;
  });

  app.get("/v1/me", authed, async (req) => {
    const [row] = await sql`
      select u.id, u.name, u.time_zone, d.id as device_id, d.name as device_name, d.platform
      from devices d join users u on u.id = d.user_id where d.id = ${req.device.id}`;
    return {
      user: { id: row!.id, name: row!.name, time_zone: row!.time_zone },
      device: { id: row!.device_id, name: row!.device_name, platform: row!.platform },
    };
  });

  // Deterministic monthly totals; see stats.ts for what counts as spending.
  app.get("/v1/summary", authed, async (req, reply) => {
    const q = SummaryQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const [u] = await sql`select time_zone, monthly_budget_minor from users where id = ${req.device.userId}`;
    const tz: string = u!.time_zone;
    const month = q.data.month ?? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
    const scope = sql`
      from transactions t
      where t.user_id = ${req.device.userId}
        and to_char(t.occurred_at at time zone ${tz}, 'YYYY-MM') = ${month}`;
    const [totals] = await sql`
      select
        coalesce(sum(amount_minor) filter (where ${isSpend(sql)}), 0) as spent_minor,
        coalesce(sum(amount_minor) filter (where ${isRefund(sql)}), 0) as refunds_minor,
        coalesce(sum(amount_minor) filter (where ${isReceived(sql)}), 0) as received_minor,
        coalesce(sum(amount_minor) filter (where t.event_type = 'cash_withdrawal' and not t.excluded), 0) as cash_withdrawn_minor,
        count(*) filter (where not t.excluded)::int as transaction_count
      ${scope}`;
    const byBank = await sql`
      select coalesce(t.institution_name, 'Unknown bank') as institution_name,
             sum(amount_minor) as spent_minor, count(*)::int as transaction_count
      ${scope} and ${isSpend(sql)}
      group by 1 order by 2 desc`;
    const byCategory = await sql`
      select t.category, sum(amount_minor) as spent_minor, count(*)::int as transaction_count
      ${scope} and ${isSpend(sql)}
      group by 1 order by 2 desc`;
    const [{ pending }] = (await sql`
      select count(*)::int as pending from transactions
      where user_id = ${req.device.userId} and review_reason is not null and reviewed_at is null`) as unknown as [{ pending: number }];
    const n = (v: unknown) => Number(v);
    return {
      month,
      spent_minor: n(totals!.spent_minor),
      refunds_minor: n(totals!.refunds_minor),
      net_spent_minor: n(totals!.spent_minor) - n(totals!.refunds_minor),
      received_minor: n(totals!.received_minor),
      cash_withdrawn_minor: n(totals!.cash_withdrawn_minor),
      transaction_count: totals!.transaction_count,
      budget_minor: u!.monthly_budget_minor === null ? null : n(u!.monthly_budget_minor),
      review_count: pending,
      by_bank: byBank.map((r) => ({ institution_name: r.institution_name, spent_minor: n(r.spent_minor), transaction_count: r.transaction_count })),
      by_category: byCategory.map((r) => ({ category: r.category, spent_minor: n(r.spent_minor), transaction_count: r.transaction_count })),
    };
  });

  app.get("/v1/categories", authed, async () => ({ categories: CATEGORIES }));

  app.get("/v1/transactions", authed, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", issues: q.error.issues });
    const transactions = await listTransactions(sql, req.device.userId, {
      limit: q.data.limit,
      before: q.data.before ? new Date(q.data.before) : undefined,
      review: !!q.data.review,
      category: q.data.category,
      q: q.data.q,
    });
    return { transactions };
  });

  app.post("/v1/transactions", authed, async (req, reply) => {
    const b = ManualBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", issues: b.error.issues });
    const txn = await createManual(sql, req.device.userId, {
      ...b.data,
      occurred_at: b.data.occurred_at ? new Date(b.data.occurred_at) : new Date(),
    });
    return reply.code(201).send({ transaction: txn });
  });

  app.get("/v1/transactions/:id", authed, async (req, reply) => {
    const p = Id.safeParse(req.params);
    const txn = p.success ? await getTransaction(sql, req.device.userId, p.data.id) : null;
    if (!txn) return reply.code(404).send({ error: "not_found" });
    return { transaction: txn };
  });

  app.patch("/v1/transactions/:id", authed, async (req, reply) => {
    const p = Id.safeParse(req.params);
    const b = PatchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", issues: b.error.issues });
    const r = p.success
      ? await updateTransaction(sql, req.device.userId, p.data.id, {
          ...b.data,
          occurred_at: b.data.occurred_at ? new Date(b.data.occurred_at) : undefined,
        })
      : null;
    if (!r) return reply.code(404).send({ error: "not_found" });
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { transaction: r.transaction, applied_to: r.applied_to };
  });

  app.delete("/v1/transactions/:id", authed, async (req, reply) => {
    const p = Id.safeParse(req.params);
    const r = p.success ? await deleteManual(sql, req.device.userId, p.data.id) : "not_found";
    if (r === "not_found") return reply.code(404).send({ error: "not_found" });
    if (r === "not_manual") return reply.code(409).send({ error: "bank_transactions_cannot_be_deleted" });
    return reply.code(204).send();
  });

  app.get("/v1/notifications", authed, async (req) => {
    const rows = await sql`
      select id, kind, title, body, transaction_id, created_at, read_at from notifications
      where user_id = ${req.device.userId} order by created_at desc limit 100`;
    const [{ unread }] = (await sql`
      select count(*)::int as unread from notifications where user_id = ${req.device.userId} and read_at is null`) as unknown as [{ unread: number }];
    return { notifications: rows, unread };
  });

  app.post("/v1/notifications/read", authed, async (req) => {
    const ids = z.object({ ids: z.array(z.uuid()).max(200).optional() }).safeParse(req.body ?? {});
    const only = ids.success && ids.data.ids ? sql`and id = any(${ids.data.ids}::uuid[])` : sql``;
    await sql`update notifications set read_at = now() where user_id = ${req.device.userId} and read_at is null ${only}`;
    return { ok: true };
  });

  const settingsOut = async (userId: string) => {
    const [u] = await sql`select alert_min_minor, digest_hour, monthly_budget_minor, push_topic, time_zone from users where id = ${userId}`;
    return {
      alert_min_minor: Number(u!.alert_min_minor),
      digest_hour: u!.digest_hour,
      monthly_budget_minor: u!.monthly_budget_minor === null ? null : Number(u!.monthly_budget_minor),
      time_zone: u!.time_zone,
      push: {
        available: !!notifier?.pushServer,
        enabled: !!u!.push_topic,
        server: notifier?.pushServer ?? null,
        topic: u!.push_topic,
      },
    };
  };

  app.get("/v1/settings", authed, async (req) => settingsOut(req.device.userId));

  app.patch("/v1/settings", authed, async (req, reply) => {
    const b = SettingsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", issues: b.error.issues });
    const s = b.data;
    if (s.push_enabled && !notifier?.pushServer) return reply.code(409).send({ error: "push_not_configured" });
    const [cur] = await sql`select alert_min_minor, digest_hour, monthly_budget_minor, push_topic from users where id = ${req.device.userId}`;
    // Turning push on keeps an existing topic so the phone stays subscribed.
    const topic = s.push_enabled === undefined ? cur!.push_topic : s.push_enabled ? (cur!.push_topic ?? newPushTopic()) : null;
    await sql`
      update users set
        alert_min_minor = ${s.alert_min_minor ?? cur!.alert_min_minor},
        digest_hour = ${s.digest_hour ?? cur!.digest_hour},
        monthly_budget_minor = ${s.monthly_budget_minor === undefined ? cur!.monthly_budget_minor : s.monthly_budget_minor},
        push_topic = ${topic}
      where id = ${req.device.userId}`;
    return settingsOut(req.device.userId);
  });

  // Sends a test push so the user can check their ntfy subscription.
  app.post("/v1/settings/push/test", { ...authed, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const [u] = await sql`select push_topic from users where id = ${req.device.userId}`;
    if (!notifier?.pushServer || !u!.push_topic) return reply.code(409).send({ error: "push_not_enabled" });
    await sql`insert into notifications (user_id, kind, title, body) values (${req.device.userId}, 'digest', 'Fintrack test', 'Push notifications are working.')`;
    notifier.kick();
    return { ok: true };
  });

  app.post("/v1/ask", { ...authed, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!assistant) return reply.code(503).send({ error: "assistant_disabled" });
    const b = AskBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", issues: b.error.issues });
    const [u] = await sql`select time_zone from users where id = ${req.device.userId}`;
    try {
      return { answer: await assistant.ask(req.device.userId, u!.time_zone, b.data.messages) };
    } catch (err) {
      req.log.error({ err }, "assistant failed");
      return reply.code(502).send({ error: "assistant_failed" });
    }
  });

  return app;
}
