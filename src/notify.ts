// Alerts: per-transaction alerts, "what was this?" review prompts, the daily
// digest and budget warnings. Each is stored in the user's in-app inbox and,
// when the user has turned push on, also sent to their ntfy topic.
import type { FastifyBaseLogger } from "fastify";
import { randomBytes } from "node:crypto";
import { categoryName } from "./categories.ts";
import type { Sql } from "./db.ts";
import { formatInr, localParts } from "./money.ts";
import { monthEnd, monthStart, netSpend, topCategories } from "./stats.ts";

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

export const newPushTopic = () => `fintrack-${randomBytes(18).toString("base64url")}`;

const REVIEW_PROMPT: Record<string, string> = {
  unknown_payee: "Who was this paid to? Tap to add a name and category.",
  uncategorized: "What was this for? Tap to pick a category.",
  llm_parsed: "Read by AI from an unfamiliar SMS. Tap to check it.",
};

interface NewNotification {
  userId: string;
  kind: "transaction" | "review" | "digest" | "budget";
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
    const users = await sql`select id, time_zone, digest_hour, monthly_budget_minor from users`;
    for (const u of users) {
      const local = localParts(now, u.time_zone);
      const month = await netSpend(sql, u.id, u.time_zone, monthStart(local.month), monthEnd(local.month));
      const budget = u.monthly_budget_minor ? Number(u.monthly_budget_minor) : null;

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

  /** Sends inbox items to ntfy for users who turned push on. Gives up after a few attempts or an hour. */
  async deliver() {
    if (!this.#push) return;
    const sql = this.#sql;
    const pending = await sql`
      select n.id, n.kind, n.title, n.body, n.transaction_id, u.push_topic
      from notifications n join users u on u.id = n.user_id
      where n.pushed_at is null and n.push_attempts < ${PUSH_MAX_ATTEMPTS}
        and n.created_at > now() - interval '1 hour' and u.push_topic is not null
      order by n.created_at limit 50`;
    for (const n of pending) {
      try {
        await this.#push.send(n.push_topic, {
          title: n.title,
          body: n.body,
          click: n.transaction_id ? `fintrack://transaction/${n.transaction_id}` : "fintrack://inbox",
          priority: n.kind === "budget" ? 4 : n.kind === "digest" ? 2 : 3,
          tags: [n.kind === "review" ? "question" : n.kind === "budget" ? "warning" : n.kind === "digest" ? "bar_chart" : "money_with_wings"],
        });
        await sql`update notifications set pushed_at = now(), push_error = null, push_attempts = push_attempts + 1 where id = ${n.id}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sql`update notifications set push_error = ${message.slice(0, 300)}, push_attempts = push_attempts + 1 where id = ${n.id}`;
        this.#log?.warn({ notification: n.id, err: message }, "push failed");
      }
    }
  }
}
