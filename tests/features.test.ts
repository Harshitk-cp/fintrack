// Review queue, payee rules, manual entries, notifications, settings and the assistant.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { ledgerTools, type Assistant, type ChatMessage } from "../src/assistant.ts";
import { classify } from "../src/classify.ts";
import { newDataKey, newDeviceToken, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { ingestSms } from "../src/ingest.ts";
import { classifyBackfill } from "../src/ledger.ts";
import { Notifier, type PushMessage, type PushSender } from "../src/notify.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://fintrack:fintrack@127.0.0.1:54329/fintrack_test";
const sql = connect(url);
const sealer = new Sealer(newDataKey());
const TZ = "Asia/Kolkata";
let userId: string;
let token: string;

beforeAll(async () => {
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql);
});
afterAll(() => sql.end());
beforeEach(async () => {
  await sql`truncate users cascade`;
  [{ id: userId }] = (await sql`insert into users (name) values ('test') returning id`) as unknown as [{ id: string }];
  const t = newDeviceToken();
  token = t.token;
  await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, 'phone', 'ios', ${t.hash})`;
});

const ingest = (body: string, at = "2026-10-21T15:00:00+05:30") =>
  ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: null, body, receivedAt: new Date(at), sourceId: null });

const BOB_TO = (vpa: string, ref: string, amt = "270.00") =>
  `Rs.${amt} Dr. from A/C XXXXXX1234 and Cr. to ${vpa}. Ref:${ref}. AvlBal:Rs12345.67(2026:10:21 14:32:10). Not you? Call 18005700-BOB`;
const SWIGGY = "Spent Rs.3451 On HDFC Bank Card 3333 At SWIGGYI14242463 On 2026-10-21:13:30:13";

class FakePush implements PushSender {
  readonly server = "https://push.test";
  sent: { topic: string; m: PushMessage }[] = [];
  fail = false;
  async send(topic: string, m: PushMessage) {
    if (this.fail) throw new Error("down");
    this.sent.push({ topic, m });
  }
}

async function api(deps: Partial<Parameters<typeof buildApi>[0]> = {}) {
  const app = await buildApi({ sql, sealer, timeZone: TZ, logger: false, ...deps });
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: object) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { app, call };
}

describe("classify", () => {
  const base = { direction: "debit" as const, eventType: "unknown", counterparty: null, vpa: null, fromLlm: false };

  it("uses built-in merchant keywords", () => {
    expect(classify({ ...base, counterparty: "SWIGGYI14242463" }, [])).toMatchObject({ category: "food", categorySource: "builtin", reviewReason: null });
    expect(classify({ ...base, vpa: "zeptomarketplace@ybl" }, [])).toMatchObject({ category: "groceries" });
  });

  it("asks who a bare UPI ID or phone number is", () => {
    expect(classify({ ...base, counterparty: "9742663090@ibl", vpa: "9742663090@ibl" }, [])).toMatchObject({ category: null, reviewReason: "unknown_payee" });
    expect(classify({ ...base, counterparty: "RAMESH STORES" }, [])).toMatchObject({ reviewReason: "uncategorized" });
  });

  it("prefers the user's payee rule", () => {
    const rules = [{ match_kind: "vpa" as const, match_value: "9742663090@ibl", label: "Chai stall", category: "food", event_type: null }];
    expect(classify({ ...base, vpa: "9742663090@IBL" }, rules)).toMatchObject({ label: "Chai stall", category: "food", categorySource: "rule", reviewReason: null });
  });

  it("does not ask about settlements or income", () => {
    expect(classify({ ...base, eventType: "card_payment" }, [])).toMatchObject({ category: null, reviewReason: null });
    expect(classify({ ...base, direction: "credit", counterparty: "A PERSON" }, [])).toMatchObject({ category: "income", reviewReason: null });
  });
});

describe("review queue and payee rules", () => {
  it("categorises known merchants and queues unknown payees", async () => {
    await ingest(SWIGGY);
    await ingest(BOB_TO("9742663090@ibl", "600000000001"));
    const { call } = await api();
    const review = (await call("GET", "/v1/transactions?review=1")).json().transactions;
    expect(review).toMatchObject([{ counterparty_vpa: "9742663090@ibl", review_reason: "unknown_payee", category: null }]);
    const all = (await call("GET", "/v1/transactions")).json().transactions;
    expect(all.find((t: { category: string }) => t.category === "food")).toBeTruthy();
  });

  it("learns from an answer and applies it to past and future payments", async () => {
    const a = await ingest(BOB_TO("9742663090@ibl", "600000000001"));
    await ingest(BOB_TO("9742663090@ibl", "600000000002"));
    const { call } = await api();
    const res = await call("PATCH", `/v1/transactions/${a.transactionId}`, { label: "Chai stall", category: "food", remember: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied_to: 1, transaction: { label: "Chai stall", category: "food", category_source: "user" } });
    expect((await call("GET", "/v1/transactions?review=1")).json().transactions).toEqual([]);

    const later = await ingest(BOB_TO("9742663090@ibl", "600000000003"));
    const [t] = await sql`select label, category, review_reason from transactions where id = ${later.transactionId}`;
    expect(t).toMatchObject({ label: "Chai stall", category: "food", review_reason: null });
  });

  it("remembers 'transfer to my own account' and leaves it out of spending", async () => {
    const a = await ingest(BOB_TO("kage@okhdfcbank", "600000000001", "5000.00"));
    const { call } = await api();
    await call("PATCH", `/v1/transactions/${a.transactionId}`, { event_type: "transfer", remember: true });
    await ingest(BOB_TO("kage@okhdfcbank", "600000000002", "2000.00"));
    const s = (await call("GET", "/v1/summary?month=2026-10")).json();
    expect(s.spent_minor).toBe(0);
  });

  it("excluded transactions drop out of totals", async () => {
    const a = await ingest(SWIGGY);
    const { call } = await api();
    expect((await call("GET", "/v1/summary?month=2026-10")).json().spent_minor).toBe(345100);
    await call("PATCH", `/v1/transactions/${a.transactionId}`, { excluded: true });
    expect((await call("GET", "/v1/summary?month=2026-10")).json()).toMatchObject({ spent_minor: 0, transaction_count: 0 });
  });

  it("backfills categories for transactions that predate them", async () => {
    await ingest(SWIGGY);
    await sql`update transactions set category = null, category_source = null, review_reason = null`;
    expect(await classifyBackfill(sql)).toBe(1);
    expect((await sql`select category from transactions`)[0]!.category).toBe("food");
  });
});

describe("manual entries", () => {
  it("adds, edits and deletes a cash expense", async () => {
    const { call } = await api();
    const res = await call("POST", "/v1/transactions", { amount_minor: 4000, counterparty: "Auto", category: "transport", occurred_at: "2026-10-21T09:00:00+05:30" });
    expect(res.statusCode).toBe(201);
    const t = res.json().transaction;
    expect(t).toMatchObject({ source: "manual", institution_name: "Cash", channel: "cash", category: "transport", review_reason: null });
    expect((await call("GET", "/v1/summary?month=2026-10")).json().spent_minor).toBe(4000);
    expect((await call("PATCH", `/v1/transactions/${t.id}`, { amount_minor: 5000 })).json().transaction.amount_minor).toBe(5000);
    expect((await call("DELETE", `/v1/transactions/${t.id}`)).statusCode).toBe(204);
  });

  it("protects bank transactions from deletion and amount edits", async () => {
    const a = await ingest(SWIGGY);
    const { call } = await api();
    expect((await call("DELETE", `/v1/transactions/${a.transactionId}`)).statusCode).toBe(409);
    expect((await call("PATCH", `/v1/transactions/${a.transactionId}`, { amount_minor: 1 })).statusCode).toBe(409);
  });

  it("does not show another user's transaction", async () => {
    const a = await ingest(SWIGGY);
    const [other] = await sql`insert into users (name) values ('other') returning id`;
    await sql`update transactions set user_id = ${other!.id} where id = ${a.transactionId}`;
    const { call } = await api();
    expect((await call("GET", `/v1/transactions/${a.transactionId}`)).statusCode).toBe(404);
    expect((await call("PATCH", `/v1/transactions/${a.transactionId}`, { note: "x" })).statusCode).toBe(404);
  });
});

describe("notifications", () => {
  // 15:00 IST, before the default 21:00 digest.
  const afternoon = () => new Date("2026-10-21T09:30:00Z");

  it("alerts on large payments, asks about unknown payees and skips small ones", async () => {
    await ingest(SWIGGY); // ₹3,451 ≥ ₹500 default
    await ingest(BOB_TO("9742663090@ibl", "600000000001")); // unknown payee
    await ingest(BOB_TO("chai@ybl", "600000000002", "20.00")); // also unknown → review, regardless of size
    await sql`update transactions set review_reason = null where counterparty_vpa = 'chai@ybl'`; // pretend it was known: now just small
    await new Notifier(sql, null, null, afternoon).runOnce();
    const rows = await sql`select kind, title, body from notifications order by kind, title`;
    expect(rows.map((r) => r.kind)).toEqual(["review", "transaction"]);
    expect(rows[0]!.title).toBe("₹270 to 9742663090@ibl · Bank of Baroda");
    expect(rows[1]).toMatchObject({ title: "₹3,451 spent · HDFC Bank", body: "SWIGGYI14242463 · Food & dining" });
    await new Notifier(sql, null, null, afternoon).runOnce(); // nothing twice
    expect((await sql`select count(*)::int as n from notifications`)[0]!.n).toBe(2);
  });

  it("sends one daily digest after the chosen hour", async () => {
    await ingest(SWIGGY);
    const evening = () => new Date("2026-10-21T16:00:00Z"); // 21:30 IST
    await new Notifier(sql, null, null, evening).runOnce();
    await new Notifier(sql, null, null, evening).runOnce();
    const digests = await sql`select title, body from notifications where kind = 'digest'`;
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ title: "Today: ₹3,451 spent" });
    expect(digests[0]!.body).toContain("Top: Food & dining ₹3,451");
  });

  it("warns at 80% and 100% of the monthly budget, once each", async () => {
    await sql`update users set monthly_budget_minor = 400000`;
    await ingest(SWIGGY); // 3451 of 4000 = 86%
    const n = new Notifier(sql, null, null, afternoon);
    await n.runOnce();
    await ingest("Spent Rs.1000 On HDFC Bank Card 3333 At ZEPTO On 2026-10-21:14:00:00");
    await n.runOnce();
    await n.runOnce();
    const titles = (await sql`select title from notifications where kind = 'budget' order by created_at`).map((r) => r.title);
    expect(titles).toEqual(["80% of your monthly budget used", "Monthly budget reached"]);
  });

  it("pushes only for users who turned push on, and retries failures", async () => {
    const push = new FakePush();
    const { call } = await api({ notifier: new Notifier(sql, push, null, afternoon) });
    const on = (await call("PATCH", "/v1/settings", { push_enabled: true })).json();
    expect(on.push).toMatchObject({ available: true, enabled: true, server: "https://push.test" });
    expect(on.push.topic).toMatch(/^fintrack-[\w-]{20,}$/);

    await ingest(SWIGGY);
    push.fail = true;
    const n = new Notifier(sql, push, null, afternoon);
    await n.runOnce();
    expect(push.sent).toHaveLength(0);
    push.fail = false;
    await n.runOnce();
    expect(push.sent).toMatchObject([{ topic: on.push.topic, m: { title: "₹3,451 spent · HDFC Bank" } }]);
    expect(push.sent[0]!.m.click).toMatch(/^fintrack:\/\/transaction\//);
  });

  it("lists the inbox and marks it read", async () => {
    await ingest(SWIGGY);
    await new Notifier(sql, null, null, afternoon).runOnce();
    const { call } = await api();
    expect((await call("GET", "/v1/notifications")).json()).toMatchObject({ unread: 1 });
    await call("POST", "/v1/notifications/read", {});
    expect((await call("GET", "/v1/notifications")).json()).toMatchObject({ unread: 0 });
  });

  it("refuses to turn push on when the server has none", async () => {
    const { call } = await api();
    expect((await call("PATCH", "/v1/settings", { push_enabled: true })).statusCode).toBe(409);
    expect((await call("PATCH", "/v1/settings", { digest_hour: 8, monthly_budget_minor: 3000000 })).json()).toMatchObject({
      digest_hour: 8, monthly_budget_minor: 3000000, push: { available: false, enabled: false },
    });
  });
});

describe("assistant", () => {
  it("is off without a model and validates the conversation", async () => {
    expect((await (await api()).call("POST", "/v1/ask", { messages: [{ role: "user", content: "hi" }] })).statusCode).toBe(503);
    const seen: ChatMessage[][] = [];
    const fake: Assistant = { ask: async (_u, _tz, m) => (seen.push(m), "₹3,451") };
    const { call } = await api({ assistant: fake });
    expect((await call("POST", "/v1/ask", { messages: [{ role: "assistant", content: "hi" }] })).statusCode).toBe(400);
    const res = await call("POST", "/v1/ask", { messages: [{ role: "user", content: "How much on food?" }] });
    expect(res.json()).toEqual({ answer: "₹3,451" });
  });

  it("tools only see the asking user's data and compute totals in SQL", async () => {
    await ingest(SWIGGY);
    await ingest("Rs.180.00 Credited to A/c ...1234 thru UPI/429500000001 by ramesh.k@ybl. Reversal. Bank of Baroda");
    const [other] = await sql`insert into users (name) values ('other') returning id`;
    await sql`insert into transactions (user_id, amount_minor, direction, occurred_at, category) values (${other!.id}, 99999, 'debit', '2026-10-21T10:00:00Z', 'food')`;
    const { search, breakdown } = ledgerTools(sql, userId, TZ);
    const b = JSON.parse((await breakdown.run({ from: "2026-10-01", to: "2026-10-31", group_by: "category", limit: 15 })) as string);
    expect(b).toMatchObject({
      net_spent_rupees: 3271,
      groups: [{ key: "food", net_spent_rupees: 3451, payments: 1 }, { key: "uncategorized", net_spent_rupees: -180, payments: 0 }],
    });
    const s = JSON.parse((await search.run({ text: "swiggy", limit: 25 })) as string);
    expect(s).toMatchObject([{ rupees: 3451, category: "food", bank: "HDFC Bank" }]);
  });
});
