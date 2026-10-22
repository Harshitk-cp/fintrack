// Alerts: per-transaction alerts, "what was this?" review prompts, the daily
// digest and budget warnings. Each is stored in the user's in-app inbox and
// pushed to every channel the user has: their ntfy topic (if turned on) and the
// FCM token of each Android phone they're signed in on.
import type { FastifyBaseLogger } from "fastify";
import { randomBytes } from "node:crypto";
import { categoryName } from "./categories.ts";
import { paceLevel, plainNote, type Coach, type PaceFacts } from "./coach.ts";
import type { FcmMessage, FcmResult } from "./fcm.ts";
import type { Sql } from "./db.ts";
import { formatInr, localParts } from "./money.ts";
import { SMS_STALE_DAYS } from "./health.ts";
import { isSpend, monthEnd, monthStart, netAmount, netSpend, topCategories } from "./stats.ts";

export interface PushMessage {
  title: string;
  body: string;
  click?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
}

export interface PushSender {
  readonly server: string;
  send(topic: string, m: PushMessage): Promise<void>;
}

/** ntfy (https://ntfy.sh, or self-hosted): no developer account needed on either platform. */
export class NtfyPush implements PushSender {
  readonly server: string;
  #token: string | null;

  constructor(server: string, token: string | null = null) {
    this.server = server.replace(/\/+$/, "");
    this.#token = token;
  }

  async send(topic: string, m: PushMessage) {
    const res = await fetch(this.server, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
      body: JSON.stringify({ topic, title: m.title, message: m.body, click: m.click, priority: m.priority, tags: m.tags }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** What the Notifier needs from FCM (FcmSender, or a fake in tests). */
export interface FcmLike {
  send(token: string, m: FcmMessage): Promise<FcmResult>;
}

const CHANNEL: Record<string, FcmMessage["channel"]> = { transaction: "payments", review: "review", digest: "summary", budget: "budget", insight: "summary" };

export const newPushTopic = () => `fintrack-${randomBytes(18).toString("base64url")}`;

const REVIEW_PROMPT: Record<string, string> = {
  unknown_payee: "Who was this paid to? Tap to add a name and category.",
  uncategorized: "What was this for? Tap to pick a category.",
  llm_parsed: "Read by AI from an unfamiliar SMS. Tap to check it.",
};

interface NewNotification {
  userId: string;
  kind: "transaction" | "review" | "digest" | "budget" | "insight";
  title: string;
  body: string;
  transactionId?: string | null;
  dedupeKey?: string | null;
}

async function insert(sql: Sql, n: NewNotification) {
  await sql`
    insert into notifications (user_id, kind, title, body, transaction_id, dedupe_key)
    values (${n.userId}, ${n.kind}, ${n.title}, ${n.body}, ${n.transactionId ?? null}, ${n.dedupeKey ?? null})
    on conflict (user_id, dedupe_key) do nothing`;
}

const PUSH_MAX_ATTEMPTS = 3;
const BUDGET_STEPS = [80, 100] as const;

interface PaceUser {
  id: string;
  name: string;
  time_zone: string;
  digest_hour: number;
  monthly_income_minor: string | number;
}

/** Transactions older than this when they first arrive get no alert. */
const STALE_ALERT_MS = 6 * 3_600_000;

export class Notifier {
  #sql: Sql;
  #push: PushSender | null;
  #log: FastifyBaseLogger | null;
  #running: Promise<void> | null = null;
  #again = false;
  #now: () => Date;

  constructor(sql: Sql, push: PushSender | null, log: FastifyBaseLogger | null = null, now = () => new Date()) {
    this.#sql = sql;
    this.#push = push;
    this.#log = log;
    this.#now = now;
  }

  setLogger(log: FastifyBaseLogger) {
    this.#log = log;
  }

  get pushServer() {
    return this.#push?.server ?? null;
  }

  start(intervalMs = 30_000) {
    setInterval(() => this.kick(), intervalMs).unref();
    this.kick();
  }

  /** Runs a pass soon; coalesces calls that arrive while one is running. */
  kick() {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.runOnce()
      .catch((err) => this.#log?.error({ err }, "notifier failed"))
      .finally(() => {
        this.#running = null;
        if (this.#again) {
          this.#again = false;
          this.kick();
        }
      });
  }

  async runOnce() {
    await this.transactionAlerts();
    await this.periodic();
    await this.deliver();
  }

  /** One alert or review prompt per new bank transaction. */
  async transactionAlerts() {
    const sql = this.#sql;
    const rows = await sql`
      update transactions t set notified_at = now()
      from users u
      where t.id in (select id from transactions where notified_at is null order by created_at limit 100 for update skip locked)
        and u.id = t.user_id
      returning t.id, t.user_id, t.source, t.occurred_at, t.amount_minor, t.direction, t.event_type, t.counterparty, t.counterparty_vpa,
                t.label, t.category, t.institution_name, t.review_reason, t.reviewed_at, t.excluded, u.alert_min_minor`;
    for (const t of rows) {
      if (t.source === "manual" || t.excluded) continue;
      // Catch-up (a mailbox's first sync, an SMS backlog) isn't news: it shows in the app, not as an alert.
      if (this.#now().getTime() - new Date(t.occurred_at).getTime() > STALE_ALERT_MS) continue;
      const amount = formatInr(Number(t.amount_minor));
      const payee = t.label ?? t.counterparty?.replace(/^\*+/, "") ?? t.counterparty_vpa ?? null;
      const bank = t.institution_name ?? "your bank";
      if (t.review_reason && !t.reviewed_at) {
        await insert(sql, {
          userId: t.user_id, kind: "review", transactionId: t.id, dedupeKey: `review:${t.id}`,
          title: `${amount} ${t.direction === "credit" ? "from" : "to"} ${payee ?? "someone"} · ${bank}`,
          body: REVIEW_PROMPT[t.review_reason] ?? "Tap to review.",
        });
      } else if (Number(t.amount_minor) >= Number(t.alert_min_minor)) {
        const what = t.event_type === "card_payment" ? "card bill paid" : t.direction === "credit" ? (t.event_type === "refund" ? "refunded" : "received") : "spent";
        await insert(sql, {
          userId: t.user_id, kind: "transaction", transactionId: t.id, dedupeKey: `txn:${t.id}`,
          title: `${amount} ${what} · ${bank}`,
          body: [payee, categoryName(t.category)].filter(Boolean).join(" · ") || "Tap to see details.",
        });
      }
    }
  }

  /** Daily digest at each user's chosen hour, and budget warnings. */
  async periodic() {
    const sql = this.#sql;
    const now = this.#now();
    const users = await sql`select id, name, time_zone, digest_hour, monthly_budget_minor, monthly_income_minor from users`;
    for (const u of users) {
      const local = localParts(now, u.time_zone);
      const month = await netSpend(sql, u.id, u.time_zone, monthStart(local.month), monthEnd(local.month));
      const budget = u.monthly_budget_minor ? Number(u.monthly_budget_minor) : null;

      if (u.monthly_income_minor) await this.#pace(u as unknown as PaceUser, local, month.netMinor);

      if (budget) {
        const pct = (month.netMinor / budget) * 100;
        const step = [...BUDGET_STEPS].reverse().find((s) => pct >= s);
        if (step) {
          await insert(sql, {
            userId: u.id, kind: "budget", dedupeKey: `budget:${local.month}:${step}`,
            title: step >= 100 ? "Monthly budget reached" : `${step}% of your monthly budget used`,
            body: `${formatInr(month.netMinor)} of ${formatInr(budget)} spent this month.`,
          });
        }
      }

      await this.#categoryBudgets(u.id, u.time_zone, local);
      if (local.hour >= u.digest_hour) await this.#smsStopped(u.id);

      if (local.hour >= u.digest_hour) {
        const [exists] = await sql`select 1 from notifications where user_id = ${u.id} and dedupe_key = ${`digest:${local.date}`}`;
        if (exists) continue;
        const today = await netSpend(sql, u.id, u.time_zone, local.date, local.date);
        const top = await topCategories(sql, u.id, u.time_zone, local.date, local.date, 2);
        const [{ pending }] = (await sql`
          select count(*)::int as pending from transactions
          where user_id = ${u.id} and review_reason is not null and reviewed_at is null`) as unknown as [{ pending: number }];
        const lines = [
          today.count
            ? `${today.count} payment${today.count === 1 ? "" : "s"} today.` +
              (top.length ? ` Top: ${top.map((c) => `${categoryName(c.category) ?? "Uncategorised"} ${formatInr(c.spentMinor)}`).join(", ")}.` : "")
            : "No spending recorded today.",
          `This month: ${formatInr(month.netMinor)}${budget ? ` of ${formatInr(budget)}` : ""}.`,
          pending ? `${pending} transaction${pending === 1 ? "" : "s"} waiting for review.` : null,
        ];
        await insert(sql, {
          userId: u.id, kind: "digest", dedupeKey: `digest:${local.date}`,
          title: `Today: ${formatInr(today.netMinor)} spent`,
          body: lines.filter(Boolean).join(" "),
        });
      }
    }
  }

  /** Calm salary check-ins: when spending runs ahead of the month, and every Sunday at the digest hour. */
  async #pace(u: PaceUser, local: ReturnType<typeof localParts>, spentMinor: number) {
    const sql = this.#sql;
    const income = Number(u.monthly_income_minor);
    const [y, m, d] = local.date.split("-").map(Number) as [number, number, number];
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthDone = d / daysInMonth;
    const level = paceLevel(spentMinor / income, monthDone);
    const sunday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0 && local.hour >= u.digest_hour;
    const key = level ? `pace:${local.month}:${level}` : sunday ? `weekly:${local.date}` : null;
    if (!key) return;
    const [exists] = await sql`select 1 from notifications where user_id = ${u.id} and dedupe_key = ${key}`;
    if (exists) return;

    const [top] = await topCategories(sql, u.id, u.time_zone, monthStart(local.month), local.date, 1);
    const [saved] = await sql`
      select coalesce(sum(t.amount_minor), 0) as total from transactions t
      where t.user_id = ${u.id} and t.direction = 'debit' and not t.excluded and t.category = 'investments'
        and to_char(t.occurred_at at time zone ${u.time_zone}, 'YYYY-MM') = ${local.month}`;
    const facts: PaceFacts = {
      name: u.name, incomeMinor: income, spentMinor, savedMinor: Number(saved!.total), monthDone, daysLeft: daysInMonth - d,
      topCategory: top && top.category !== "uncategorized" ? { name: categoryName(top.category) ?? top.category, spentMinor: top.spentMinor } : null,
      reason: level ? "ahead" : "weekly",
    };
    const note = this.#coach ? await this.#coach.write(facts).catch(() => plainNote(facts)) : plainNote(facts);
    await insert(sql, { userId: u.id, kind: "insight", dedupeKey: key, title: note.title, body: note.body });
  }

  /**
   * Category budgets: a calm note at 80% and another at 100%, once each per month.
   * Factual and kind; it never tells anyone off.
   */
  async #categoryBudgets(userId: string, tz: string, local: ReturnType<typeof localParts>) {
    const sql = this.#sql;
    const rows = await sql`
      select b.category, b.amount_minor,
             coalesce((select sum(${netAmount(sql)}) from transactions t
                       where t.user_id = b.user_id and t.category = b.category and ${isSpend(sql)}
                         and to_char(t.occurred_at at time zone ${tz}, 'YYYY-MM') = ${local.month}), 0) as spent
      from category_budgets b where b.user_id = ${userId}`;
    if (!rows.length) return;
    const [y, m, d] = local.date.split("-").map(Number) as [number, number, number];
    const daysLeft = new Date(Date.UTC(y, m, 0)).getUTCDate() - d;
    for (const r of rows) {
      const limit = Number(r.amount_minor);
      const spent = Number(r.spent);
      const step = [...BUDGET_STEPS].reverse().find((s) => spent >= (limit * s) / 100);
      if (!step) continue;
      const name = categoryName(r.category) ?? r.category;
      const left = daysLeft === 0 ? "the last day of the month" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} to go`;
      await insert(sql, {
        userId, kind: "budget", dedupeKey: `catbudget:${local.month}:${r.category}:${step}`,
        title: step >= 100 ? `${name} budget reached` : `${name} is at ${step}% of its budget`,
        body: step >= 100
          ? `${formatInr(spent)} of ${formatInr(limit)} this month, ${left}. No stress: there's just less room here until the 1st.`
          : `${formatInr(spent)} of ${formatInr(limit)} spent, ${left}. A lighter few days would keep it comfortable.`,
      });
    }
  }

  /** One heads-up when bank SMS stop arriving, so a broken forwarder doesn't go unnoticed for weeks. */
  async #smsStopped(userId: string) {
    const sql = this.#sql;
    const [last] = await sql`
      select id, observed_at from evidence where user_id = ${userId} and source_type = 'sms' order by observed_at desc limit 1`;
    if (!last || this.#now().getTime() - new Date(last.observed_at).getTime() < SMS_STALE_DAYS * 86_400_000) return;
    await insert(sql, {
      userId, kind: "insight", dedupeKey: `health:sms:${last.id}`, // once per quiet spell
      title: `No bank SMS for ${SMS_STALE_DAYS} days`,
      body: "If you've paid by card or UPI since, SMS forwarding may have stopped. Settings shows what's working.",
    });
  }

  /** Writes the salary check-ins; without one they use a plain message. */
  setCoach(coach: Coach | null) {
    this.#coach = coach;
  }
  #coach: Coach | null = null;

  /** Sends inbox items to ntfy for users who turned push on. Gives up after a few attempts or an hour. */
  /** Android push via FCM, when the server has a Firebase service account. */
  setFcm(fcm: FcmLike | null) {
    this.#fcm = fcm;
  }
  #fcm: FcmLike | null = null;

  async deliver() {
    if (!this.#push && !this.#fcm) return;
    const sql = this.#sql;
    const pending = await sql`
      select n.id, n.kind, n.title, n.body, n.transaction_id, n.dedupe_key, n.user_id,
             case when ${!!this.#push} then u.push_topic end as topic,
             case when ${!!this.#fcm} then array(select token from push_tokens p where p.user_id = n.user_id) else '{}' end as tokens
      from notifications n join users u on u.id = n.user_id
      where n.pushed_at is null and n.push_attempts < ${PUSH_MAX_ATTEMPTS}
        and n.created_at > now() - interval '1 hour'
        and ((${!!this.#push} and u.push_topic is not null) or (${!!this.#fcm} and exists (select 1 from push_tokens p where p.user_id = n.user_id)))
      order by n.created_at limit 50`;
    for (const n of pending) {
      const url = n.transaction_id ? `fintrack://transaction/${n.transaction_id}` : "fintrack://inbox";
      const errors: string[] = [];
      let delivered = false;
      if (n.topic && this.#push) {
        try {
          await this.#push.send(n.topic, {
            title: n.title,
            body: n.body,
            click: url,
            priority: n.kind === "budget" ? 4 : n.kind === "digest" ? 2 : 3,
            tags: [n.kind === "review" ? "question" : n.kind === "budget" ? "warning" : n.kind === "digest" ? "bar_chart" : "money_with_wings"],
          });
          delivered = true;
        } catch (err) {
          errors.push(`ntfy: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const token of (n.tokens as string[]) ?? []) {
        try {
          const r = await this.#fcm!.send(token, {
            title: n.title, body: n.body, url, channel: CHANNEL[n.kind] ?? "payments",
            tag: n.dedupe_key ?? undefined, high: n.kind !== "digest",
          });
          if (r === "unregistered") await sql`delete from push_tokens where token = ${token}`; // app uninstalled or token rotated
          else delivered = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`fcm: ${message}`);
          await sql`update push_tokens set last_error = ${message.slice(0, 300)} where token = ${token}`;
        }
      }
      if (delivered) {
        await sql`update notifications set pushed_at = now(), push_error = ${errors.length ? errors.join("; ").slice(0, 300) : null}, push_attempts = push_attempts + 1 where id = ${n.id}`;
      } else {
        await sql`update notifications set push_error = ${(errors.join("; ") || "no target").slice(0, 300)}, push_attempts = push_attempts + 1 where id = ${n.id}`;
        this.#log?.warn({ notification: n.id, err: errors }, "push failed");
      }
    }
  }
}
