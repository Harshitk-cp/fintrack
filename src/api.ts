import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Assistant } from "./assistant.ts";
import { checkPin, hashPin, isWeakPin, normalizePhone, PIN_RE, type PinCheck } from "./auth.ts";
import { BUCKET, CATEGORIES, CATEGORY_IDS } from "./categories.ts";
import { newDeviceToken, normalizePairingCode, sha256, type Sealer } from "./crypto.ts";
import type { Sql } from "./db.ts";
import { ingestSms } from "./ingest.ts";
import { createManual, deleteManual, getTransaction, listTransactions, updateTransaction } from "./ledger.ts";
import { newPushTopic, type Notifier } from "./notify.ts";
import { imapServerFor } from "./mail/filter.ts";
import { MailAuthError, MailHostError, type MailSource } from "./mail/source.ts";
import { markPaid } from "./sips.ts";
import { looksLikeOtp } from "./sms/parser.ts";
import { isReceived, isRefund, isSaved, isSpend } from "./stats.ts";

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
  mail?: { source: MailSource; poller: { kick(accountId: string): void } } | null;
  /** True when the server can send Android push through Firebase. */
  fcm?: boolean;
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
  monthly_income_minor: z.number().int().positive().max(100_000_000_000).nullable().optional(),
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

const Phone = z.string().max(20).transform((s, ctx) => normalizePhone(s) ?? (ctx.addIssue({ code: "custom", message: "invalid_phone" }), z.NEVER));
const Pin = z.string().regex(PIN_RE);
const DeviceInfo = {
  platform: z.enum(["ios", "android", "other"]).default("other"),
  device_name: z.string().trim().min(1).max(60).default("Phone"),
};
const RegisterBody = z.object({
  phone: Phone, pin: Pin, name: z.string().trim().min(1).max(40),
  /** Monthly take-home pay in paise; optional. */
  monthly_income_minor: z.number().int().positive().max(100_000_000_000).nullable().optional(),
  ...DeviceInfo,
});
const LoginBody = z.object({ phone: Phone, pin: Pin, ...DeviceInfo });
const PinBody = z.object({ pin: Pin });
const ChangePinBody = z.object({ current_pin: Pin, new_pin: Pin });
const MailBody = z.object({
  address: z.email().max(200).transform((s) => s.trim().toLowerCase()),
  // App passwords are shown with spaces ("abcd efgh ijkl mnop"); IMAP wants them without.
  app_password: z.string().min(4).max(200).transform((s) => s.replace(/\s+/g, "")),
  host: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{3,200}$/).optional(),
  // IMAP over TLS only; plain-text 143 would send the password unencrypted.
  port: z.literal(993).optional(),
});

const SummaryQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BACKFILL_MS = 30 * 86_400_000;

/** Spending split into needs and wants (uncategorised kept apart), plus savings. */
function buckets(byCategory: { category: string | null; spent: number }[], saved: number) {
  const out = { needs: 0, wants: 0, unsorted: 0, savings: saved };
  for (const c of byCategory) {
    const b = c.category ? BUCKET[c.category] : undefined;
    if (b === "needs" || b === "wants") out[b] += c.spent;
    else out.unsorted += c.spent;
  }
  return out;
}

export async function buildApi({ sql, sealer, timeZone, logger = true, onUnrecognized, notifier = null, assistant = null, mail = null, fcm = false }: ApiDeps) {
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

  // Phone + PIN accounts. Per-IP limits here, per-account lockouts in checkPin.
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (r: FastifyRequest) => r.ip } } };

  async function newDevice(userId: string, platform: string, name: string) {
    const { token, hash } = newDeviceToken();
    const [d] = await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, ${name}, ${platform}, ${hash}) returning id`;
    return { token, device_id: d!.id as string };
  }

  const pinFailure = (reply: FastifyReply, r: Exclude<PinCheck, { ok: true }>, wrong = "wrong_pin") =>
    r.reason === "locked"
      ? reply.code(429).header("retry-after", String(r.retryAfterS)).send({ error: "locked", retry_after_s: r.retryAfterS })
      : reply.code(401).send({ error: wrong });

  app.post("/v1/auth/register", authLimit, async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.some((i) => i.message === "invalid_phone") ? "invalid_phone" : "invalid_body" });
    const b = parsed.data;
    if (isWeakPin(b.pin)) return reply.code(400).send({ error: "weak_pin" });
    const pinHash = await hashPin(b.pin);
    const [user] = await sql`
      insert into users (name, phone, pin_hash, monthly_income_minor) values (${b.name}, ${b.phone}, ${pinHash}, ${b.monthly_income_minor ?? null})
      on conflict (phone) do nothing returning id, name, phone`;
    if (!user) return reply.code(409).send({ error: "phone_taken" });
    const device = await newDevice(user.id, b.platform, b.device_name);
    return reply.code(201).send({ ...device, user: { id: user.id, name: user.name, phone: user.phone } });
  });

  app.post("/v1/auth/login", authLimit, async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.some((i) => i.message === "invalid_phone") ? "invalid_phone" : "invalid_body" });
    const b = parsed.data;
    const [user] = await sql`select id, name, phone from users where phone = ${b.phone}`;
    // Same answer for an unknown number and a wrong PIN.
    if (!user) {
      await checkPin(sql, "00000000-0000-0000-0000-000000000000", b.pin);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const check = await checkPin(sql, user.id, b.pin);
    if (!check.ok) return pinFailure(reply, check, "invalid_credentials");
    const device = await newDevice(user.id, b.platform, b.device_name);
    return { ...device, user: { id: user.id, name: user.name, phone: user.phone } };
  });

  // The app's lock screen falls back to this when Face ID / fingerprint isn't used.
  app.post("/v1/auth/verify-pin", { ...authed, ...authLimit, onRequest: authenticate }, async (req, reply) => {
    const parsed = PinBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const check = await checkPin(sql, req.device.userId, parsed.data.pin);
    return check.ok ? { ok: true } : pinFailure(reply, check);
  });

  app.post("/v1/auth/pin", { ...authed, ...authLimit, onRequest: authenticate }, async (req, reply) => {
    const parsed = ChangePinBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (isWeakPin(parsed.data.new_pin)) return reply.code(400).send({ error: "weak_pin" });
    const check = await checkPin(sql, req.device.userId, parsed.data.current_pin);
    if (!check.ok) return pinFailure(reply, check);
    await sql`update users set pin_hash = ${await hashPin(parsed.data.new_pin)} where id = ${req.device.userId}`;
    return reply.code(204).send();
  });

  app.post("/v1/auth/logout", authed, async (req, reply) => {
    await sql.begin(async (tx) => {
      await tx`update devices set revoked_at = now() where id = ${req.device.id}`;
      await tx`delete from push_tokens where device_id = ${req.device.id}`; // no more pushes to a signed-out phone
    });
    return reply.code(204).send();
  });

  // Android phones register their Firebase token; a token moves with whoever signs in on that phone.
  const FcmBody = z.object({ token: z.string().trim().min(20).max(4096) });
  app.put("/v1/push/fcm", authed, async (req, reply) => {
    if (!fcm) return reply.code(503).send({ error: "fcm_disabled" });
    const parsed = FcmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    await sql.begin(async (tx) => {
      await tx`delete from push_tokens where device_id = ${req.device.id} and token <> ${parsed.data.token}`; // one token per install
      await tx`
        insert into push_tokens (token, user_id, device_id) values (${parsed.data.token}, ${req.device.userId}, ${req.device.id})
        on conflict (token) do update set user_id = excluded.user_id, device_id = excluded.device_id, last_error = null`;
    });
    return reply.code(204).send();
  });

  app.delete("/v1/push/fcm", authed, async (req, reply) => {
    await sql`delete from push_tokens where device_id = ${req.device.id}`;
    return reply.code(204).send();
  });

  app.get("/v1/me", authed, async (req) => {
    const [row] = await sql`
      select u.id, u.name, u.phone, u.time_zone, d.id as device_id, d.name as device_name, d.platform
      from devices d join users u on u.id = d.user_id where d.id = ${req.device.id}`;
    return {
      user: { id: row!.id, name: row!.name, phone: row!.phone, time_zone: row!.time_zone },
      device: { id: row!.device_id, name: row!.device_name, platform: row!.platform },
    };
  });

  // Deterministic monthly totals; see stats.ts for what counts as spending.
  app.get("/v1/summary", authed, async (req, reply) => {
    const q = SummaryQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const [u] = await sql`select time_zone, monthly_budget_minor, monthly_income_minor from users where id = ${req.device.userId}`;
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
        coalesce(sum(amount_minor) filter (where ${isSaved(sql)}), 0) as invested_minor,
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
    // SIPs marked paid that no bank message matched; ones linked to a transaction are already in invested_minor.
    const [sipOnly] = await sql`
      select coalesce(sum(p.amount_minor), 0) as total from sip_payments p join sips s on s.id = p.sip_id
      where s.user_id = ${req.device.userId} and p.month = ${month} and p.transaction_id is null`;
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
      /** Monthly take-home the user entered; falls back to money received in the app. */
      income_minor: u!.monthly_income_minor === null ? null : n(u!.monthly_income_minor),
      saved_minor: n(totals!.invested_minor) + n(sipOnly!.total),
      buckets: buckets(byCategory.map((r) => ({ category: r.category, spent: n(r.spent_minor) })), n(totals!.invested_minor) + n(sipOnly!.total)),
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
    const [u] = await sql`
      select alert_min_minor, digest_hour, monthly_budget_minor, monthly_income_minor, push_topic, time_zone,
             (select count(*)::int from push_tokens p where p.user_id = users.id) as fcm_devices
      from users where id = ${userId}`;
    return {
      alert_min_minor: Number(u!.alert_min_minor),
      digest_hour: u!.digest_hour,
      monthly_budget_minor: u!.monthly_budget_minor === null ? null : Number(u!.monthly_budget_minor),
      monthly_income_minor: u!.monthly_income_minor === null ? null : Number(u!.monthly_income_minor),
      time_zone: u!.time_zone,
      push: {
        available: !!notifier?.pushServer,
        enabled: !!u!.push_topic,
        server: notifier?.pushServer ?? null,
        topic: u!.push_topic,
      },
      /** Android system notifications through Firebase. */
      fcm: { available: fcm, devices: u!.fcm_devices },
    };
  };

  app.get("/v1/settings", authed, async (req) => settingsOut(req.device.userId));

  app.patch("/v1/settings", authed, async (req, reply) => {
    const b = SettingsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", issues: b.error.issues });
    const s = b.data;
    if (s.push_enabled && !notifier?.pushServer) return reply.code(409).send({ error: "push_not_configured" });
    const [cur] = await sql`select alert_min_minor, digest_hour, monthly_budget_minor, monthly_income_minor, push_topic from users where id = ${req.device.userId}`;
    // Turning push on keeps an existing topic so the phone stays subscribed.
    const topic = s.push_enabled === undefined ? cur!.push_topic : s.push_enabled ? (cur!.push_topic ?? newPushTopic()) : null;
    await sql`
      update users set
        alert_min_minor = ${s.alert_min_minor ?? cur!.alert_min_minor},
        digest_hour = ${s.digest_hour ?? cur!.digest_hour},
        monthly_budget_minor = ${s.monthly_budget_minor === undefined ? cur!.monthly_budget_minor : s.monthly_budget_minor},
        monthly_income_minor = ${s.monthly_income_minor === undefined ? cur!.monthly_income_minor : s.monthly_income_minor},
        push_topic = ${topic}
      where id = ${req.device.userId}`;
    return settingsOut(req.device.userId);
  });

  // Sends a test push so the user can check their ntfy subscription.
  app.post("/v1/settings/push/test", { ...authed, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const [u] = await sql`
      select push_topic, exists (select 1 from push_tokens p where p.user_id = users.id) as has_fcm from users where id = ${req.device.userId}`;
    const ntfyOn = !!notifier?.pushServer && !!u!.push_topic;
    if (!notifier || (!ntfyOn && !(fcm && u!.has_fcm))) return reply.code(409).send({ error: "push_not_enabled" });
    await sql`insert into notifications (user_id, kind, title, body) values (${req.device.userId}, 'digest', 'Fintrack test', 'Push notifications are working.')`;
    notifier.kick();
    return { ok: true };
  });

  // Bank alert emails over IMAP, several mailboxes per user. A password is checked by logging in before it is saved.
  const MAX_MAILBOXES = 5;
  async function mailboxes(userId: string) {
    return sql`
      select id, address, host, status, last_error, last_checked_at, emails_found
      from mail_accounts where user_id = ${userId} order by created_at`;
  }

  app.get("/v1/mail", authed, async (req) => ({ available: !!mail, max: MAX_MAILBOXES, mailboxes: await mailboxes(req.device.userId) }));

  // Each attempt logs in to a mail server, so keep it tight: the API must not double as a password-guessing tool.
  app.put("/v1/mail", { ...authed, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!mail) return reply.code(503).send({ error: "mail_disabled" });
    const parsed = MailBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const b = parsed.data;
    const server = b.host ? { host: b.host, port: 993 } : imapServerFor(b.address);
    if (!server) return reply.code(422).send({ error: "unknown_provider" });
    try {
      await mail.source.verify({ ...server, user: b.address, pass: b.app_password });
    } catch (err) {
      req.log.info({ err: err instanceof Error ? err.message : String(err), host: server.host }, "mail verify failed");
      return reply.code(422).send({ error: err instanceof MailAuthError ? "auth_failed" : err instanceof MailHostError ? "bad_host" : "connect_failed" });
    }
    // Adding an address that is already connected updates its password; the cursor starts afresh.
    // The count check and insert share a transaction so two parallel requests can't pass the limit.
    const acc = await sql.begin(async (tx) => {
      await tx`select id from users where id = ${req.device.userId} for update`;
      const [{ n }] = (await tx`
        select count(*)::int as n from mail_accounts where user_id = ${req.device.userId} and address <> ${b.address}`) as unknown as [{ n: number }];
      if (n >= MAX_MAILBOXES) return null;
      const [row] = await tx`
        insert into mail_accounts (user_id, address, host, port, password_enc)
        values (${req.device.userId}, ${b.address}, ${server.host}, ${server.port}, ${sealer.seal(b.app_password)})
        on conflict (user_id, address) do update set host = excluded.host, port = excluded.port, password_enc = excluded.password_enc,
          uid_validity = null, last_uid = 0, status = 'pending', last_error = null, last_checked_at = null
        returning id`;
      return row!;
    });
    if (!acc) return reply.code(409).send({ error: "too_many_mailboxes" });
    mail.poller.kick(acc.id);
    return { available: true, max: MAX_MAILBOXES, mailboxes: await mailboxes(req.device.userId) };
  });

  // SIPs: the user's list with this month's paid status, and alerts the assistant couldn't pin down.
  const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
  const SipBody = z.object({
    name: z.string().trim().min(1).max(80),
    amount_minor: z.number().int().positive().max(10_000_000_000),
    day_of_month: z.number().int().min(1).max(31).nullable().optional(),
    /** Adding from a suggestion marks that alert's month as paid. */
    from_suggestion: z.uuid().optional(),
  });
  const SipPatch = SipBody.omit({ from_suggestion: true }).partial().extend({ active: z.boolean().optional() });
  const currentMonth = async (userId: string) => {
    const [u] = await sql`select time_zone from users where id = ${userId}`;
    return new Intl.DateTimeFormat("en-CA", { timeZone: u!.time_zone, year: "numeric", month: "2-digit" }).format(new Date());
  };
  async function sipsOut(userId: string, month: string) {
    const sips = await sql`
      select s.id, s.name, s.amount_minor, s.day_of_month, s.source, s.active,
             p.amount_minor as paid_minor, p.paid_at, p.transaction_id as paid_transaction_id
      from sips s left join sip_payments p on p.sip_id = s.id and p.month = ${month}
      where s.user_id = ${userId} order by s.active desc, s.created_at`;
    const suggestions = await sql`
      select g.id, g.scheme, g.amount_minor, g.transaction_id, g.created_at, coalesce(e.occurred_at, e.observed_at) as seen_at
      from sip_suggestions g join evidence e on e.id = g.evidence_id
      where g.user_id = ${userId} and g.status = 'needs_user' order by g.created_at desc`;
    const n = (v: unknown) => (v === null ? null : Number(v));
    return {
      month,
      sips: sips.map((s) => ({
        id: s.id, name: s.name, amount_minor: Number(s.amount_minor), day_of_month: s.day_of_month, source: s.source, active: s.active,
        paid: s.paid_minor === null ? null : { amount_minor: Number(s.paid_minor), paid_at: s.paid_at, transaction_id: s.paid_transaction_id },
      })),
      suggestions: suggestions.map((g) => ({ id: g.id, scheme: g.scheme, amount_minor: n(g.amount_minor), transaction_id: g.transaction_id, seen_at: g.seen_at })),
    };
  }

  app.get("/v1/sips", authed, async (req, reply) => {
    const m = Month.optional().safeParse((req.query as { month?: string }).month);
    if (!m.success) return reply.code(400).send({ error: "invalid_month" });
    return sipsOut(req.device.userId, m.data ?? (await currentMonth(req.device.userId)));
  });

  app.post("/v1/sips", authed, async (req, reply) => {
    const parsed = SipBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const b = parsed.data;
    const userId = req.device.userId;
    const created = await sql.begin(async (tx) => {
      const [sip] = await tx`
        insert into sips (user_id, name, amount_minor, day_of_month) values (${userId}, ${b.name}, ${b.amount_minor}, ${b.day_of_month ?? null})
        on conflict (user_id, lower(name)) do nothing returning id`;
      if (!sip) return null;
      if (b.from_suggestion) {
        const [g] = await tx`
          update sip_suggestions g set status = 'added' from evidence e
          where g.id = ${b.from_suggestion} and g.user_id = ${userId} and e.id = g.evidence_id
          returning g.transaction_id, coalesce(e.occurred_at, e.observed_at) as at`;
        if (g) {
          const [u] = await tx`select time_zone from users where id = ${userId}`;
          const month = new Intl.DateTimeFormat("en-CA", { timeZone: u!.time_zone, year: "numeric", month: "2-digit" }).format(g.at);
          await markPaid(tx, sip.id, month, b.amount_minor, g.transaction_id);
        }
      }
      return sip;
    });
    if (!created) return reply.code(409).send({ error: "sip_exists" });
    return reply.code(201).send(await sipsOut(userId, await currentMonth(userId)));
  });

  app.patch("/v1/sips/:id", authed, async (req, reply) => {
    const id = Id.safeParse(req.params);
    const parsed = SipPatch.safeParse(req.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const b = parsed.data;
    const r = await sql`
      update sips set
        name = coalesce(${b.name ?? null}, name), amount_minor = coalesce(${b.amount_minor ?? null}, amount_minor),
        day_of_month = ${b.day_of_month === undefined ? sql`day_of_month` : b.day_of_month}, active = coalesce(${b.active ?? null}, active)
      where id = ${id.data.id} and user_id = ${req.device.userId}`;
    if (!r.count) return reply.code(404).send({ error: "not_found" });
    return sipsOut(req.device.userId, await currentMonth(req.device.userId));
  });

  app.delete("/v1/sips/:id", authed, async (req, reply) => {
    const id = Id.safeParse(req.params);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    const r = await sql`delete from sips where id = ${id.data.id} and user_id = ${req.device.userId}`;
    return r.count ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });

  /** Ticks or unticks a month: a paid SIP counts as savings. */
  app.put("/v1/sips/:id/paid", authed, async (req, reply) => {
    const id = Id.safeParse(req.params);
    const body = z.object({ month: Month, paid: z.boolean() }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    const [sip] = await sql`select id, amount_minor from sips where id = ${id.data.id} and user_id = ${req.device.userId}`;
    if (!sip) return reply.code(404).send({ error: "not_found" });
    if (body.data.paid) await markPaid(sql, sip.id, body.data.month, Number(sip.amount_minor), null);
    else await sql`delete from sip_payments where sip_id = ${sip.id} and month = ${body.data.month}`;
    return sipsOut(req.device.userId, body.data.month);
  });

  app.post("/v1/sips/suggestions/:id/dismiss", authed, async (req, reply) => {
    const id = Id.safeParse(req.params);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    await sql`update sip_suggestions set status = 'dismissed' where id = ${id.data.id} and user_id = ${req.device.userId}`;
    return reply.code(204).send();
  });

  // The banner asking people to connect a mailbox: after each dismissal it waits
  // 1 day, then 7 days, then stops for good. `pending` (no mailbox yet) drives the
  // dot on the Settings tab, which stays until a mailbox is connected.
  const NUDGE_DELAYS = ["1 day", "7 days"];
  app.get("/v1/nudges", authed, async (req) => {
    const [u] = await sql`
      select mail_nudge_dismissals as dismissals, mail_nudge_next_at as next_at,
             exists (select 1 from mail_accounts m where m.user_id = users.id) as connected
      from users where id = ${req.device.userId}`;
    const pending = !!mail && !u!.connected;
    const show = pending && u!.dismissals <= NUDGE_DELAYS.length && (!u!.next_at || new Date(u!.next_at) <= new Date());
    return { mail: { pending, show } };
  });

  app.post("/v1/nudges/mail/dismiss", authed, async (req, reply) => {
    // Delay for this dismissal (1st: 1 day, 2nd: 7 days); after the last one, next_at is null and the count ends it.
    await sql`
      update users set
        mail_nudge_dismissals = mail_nudge_dismissals + 1,
        mail_nudge_next_at = case mail_nudge_dismissals
          ${sql.unsafe(NUDGE_DELAYS.map((d, i) => `when ${i} then now() + interval '${d}'`).join(" "))}
          else null end
      where id = ${req.device.userId}`;
    return reply.code(204).send();
  });

  /** Syncs all of the user's mailboxes now, or one with `?id=`. */
  app.post("/v1/mail/sync", authed, async (req, reply) => {
    const id = (req.query as { id?: string }).id;
    if (id && !Id.safeParse({ id }).success) return reply.code(400).send({ error: "invalid_id" });
    const accs = await sql`select id from mail_accounts where user_id = ${req.device.userId} ${id ? sql`and id = ${id}` : sql``}`;
    if (!accs.length || !mail) return reply.code(404).send({ error: "not_connected" });
    for (const a of accs) mail.poller.kick(a.id);
    return reply.code(202).send({ ok: true });
  });

  app.delete("/v1/mail/:id", authed, async (req, reply) => {
    const parsed = Id.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_id" });
    const r = await sql`delete from mail_accounts where id = ${parsed.data.id} and user_id = ${req.device.userId}`;
    return r.count ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
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
