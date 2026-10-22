// Search filters, refunds, subscriptions, category budgets and the health check.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { newDataKey, newDeviceToken, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { ingestSms } from "../src/ingest.ts";
import { Notifier } from "../src/notify.ts";
import { asSubscription, type Charge } from "../src/subscriptions.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://fintrack:fintrack@127.0.0.1:54329/fintrack_test";
const sql = connect(url);
const sealer = new Sealer(newDataKey());
const TZ = "Asia/Kolkata";
const DAY = 86_400_000;
let userId: string;
let token: string;
let app: Awaited<ReturnType<typeof buildApi>>;

beforeAll(async () => {
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql);
});
afterAll(() => sql.end());
beforeEach(async () => {
  await sql`truncate users cascade`;
  [{ id: userId }] = (await sql`insert into users (name) values ('Kage') returning id`) as unknown as [{ id: string }];
  const t = newDeviceToken();
  token = t.token;
  await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, 'phone', 'ios', ${t.hash})`;
  app = await buildApi({ sql, sealer, timeZone: TZ, logger: false });
});
afterEach(() => app.close());

const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: path, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const sms = (body: string, at = new Date()) => ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "BOBSMS-S", body, receivedAt: at, sourceId: null });
const BOB_TO = (vpa: string, ref: string, amt: string) =>
  `Rs.${amt} Dr. from A/C XXXXXX1234 and Cr. to ${vpa}. Ref:${ref}. AvlBal:Rs12345.67. Not you? Call 18005700-BOB`;
const BOB_FROM = (vpa: string, ref: string, amt: string) =>
  `Rs.${amt} Cr. to A/C XXXXXX1234 from ${vpa}. Ref:${ref}. AvlBal:Rs12345.67. Not you? Call 18005700-BOB`;
const manual = async (amount: number, counterparty: string, at: Date, category: string | null = null, direction = "debit") =>
  (await req("POST", "/v1/transactions", { amount_minor: amount, counterparty, category, direction, occurred_at: at.toISOString() })).json().transaction.id as string;
const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

describe("search filters", () => {
  it("filters by date range, direction, amount, category and bank, and totals every match", async () => {
    const now = new Date();
    await manual(50_000, "Swiggy", new Date(now.getTime() - 2 * DAY), "food");
    await manual(120_000, "Zara", new Date(now.getTime() - 3 * DAY), "shopping");
    await manual(80_000, "Old dinner", new Date(now.getTime() - 40 * DAY), "food");
    await manual(500_000, "Salary", new Date(now.getTime() - 1 * DAY), "income", "credit");

    const last7 = (await req("GET", `/v1/transactions?from=${localDate(new Date(now.getTime() - 6 * DAY))}&to=${localDate(now)}&totals=1`)).json();
    expect(last7.transactions).toHaveLength(3);
    expect(last7.totals).toEqual({ count: 3, spent_minor: 170_000, received_minor: 500_000 });

    const food = (await req("GET", "/v1/transactions?categories=food&direction=debit&totals=1")).json();
    expect(food.transactions.map((t: { counterparty: string }) => t.counterparty).sort()).toEqual(["Old dinner", "Swiggy"]);
    expect(food.totals.spent_minor).toBe(130_000);

    const big = (await req("GET", "/v1/transactions?min=100000&max=200000")).json();
    expect(big.transactions.map((t: { counterparty: string }) => t.counterparty)).toEqual(["Zara"]);

    expect((await req("GET", "/v1/transactions?banks=Cash")).json().transactions).toHaveLength(4);
    expect((await req("GET", "/v1/transactions?banks=HDFC%20Bank")).json().transactions).toHaveLength(0);
    expect((await req("GET", "/v1/transactions/banks")).json().banks).toEqual(["Cash"]);
    expect((await req("GET", "/v1/transactions?from=2026-13-01")).statusCode).toBe(400);
    expect((await req("GET", "/v1/transactions?categories=food,nope")).statusCode).toBe(400);
  });
});

describe("refunds", () => {
  it("nets a refund off its purchase, and a linked credit stops counting as received", async () => {
    await sms(BOB_TO("amazon@apl", "700000000001", "2000.00"));
    await sms(BOB_FROM("amazon@apl", "700000000002", "800.00"));
    const [purchase] = await sql`select id from transactions where direction = 'debit'`;
    const [credit] = await sql`select id from transactions where direction = 'credit'`;
    const before = (await req("GET", "/v1/summary")).json();
    expect(before.net_spent_minor).toBe(200_000);

    const r = await req("POST", `/v1/transactions/${purchase!.id}/refunds`, { amount_minor: 80_000, refund_transaction_id: credit!.id });
    expect(r.statusCode).toBe(201);
    expect(r.json().transaction.refunded_minor).toBe(80_000);
    expect(r.json().transaction.refunds[0].credit_name).toBeTruthy();

    const after = (await req("GET", "/v1/summary")).json();
    expect(after.net_spent_minor).toBe(120_000);
    expect(after.spent_minor).toBe(120_000);
    expect(after.received_minor).toBe(before.received_minor - 80_000);
    expect(after.refunds_minor).toBe(0); // counted on the purchase, not twice
    const creditNow = (await req("GET", `/v1/transactions/${credit!.id}`)).json().transaction;
    expect(creditNow.event_type).toBe("refund");
    expect(creditNow.refund_for_id).toBe(purchase!.id);

    // Can't link the same credit twice, or refund more than was paid.
    expect((await req("POST", `/v1/transactions/${purchase!.id}/refunds`, { amount_minor: 100, refund_transaction_id: credit!.id })).json().error).toBe("credit_already_linked");
    expect((await req("POST", `/v1/transactions/${purchase!.id}/refunds`, { amount_minor: 130_000 })).json().error).toBe("more_than_purchase");
    expect((await req("POST", `/v1/transactions/${credit!.id}/refunds`, { amount_minor: 100 })).json().error).toBe("not_a_purchase");

    // A second, unlinked partial refund; then undo it.
    const second = (await req("POST", `/v1/transactions/${purchase!.id}/refunds`, { amount_minor: 20_000 })).json();
    expect((await req("GET", "/v1/summary")).json().net_spent_minor).toBe(100_000);
    expect((await req("DELETE", `/v1/refunds/${second.refund_id}`)).statusCode).toBe(204);
    expect((await req("GET", "/v1/summary")).json().net_spent_minor).toBe(120_000);
  });

  it("refuses a refund larger than the credit it's linked to", async () => {
    const p = await manual(300_000, "Flight", new Date());
    const c = await manual(50_000, "Airline", new Date(), null, "credit");
    expect((await req("POST", `/v1/transactions/${p}/refunds`, { amount_minor: 60_000, refund_transaction_id: c })).json().error).toBe("more_than_credit");
  });
});

describe("subscriptions", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const charges = (name: string, amounts: number[], gapDays: number, category: string | null = null): Charge[] =>
    amounts.map((a, i) => ({
      id: `${name}-${i}`, amountMinor: a, name, category, bank: "HDFC Bank",
      occurredAt: new Date(now.getTime() - (amounts.length - 1 - i) * gapDays * DAY - 2 * DAY),
    }));

  it("spots monthly charges and flags a price rise", () => {
    const s = asSubscription("netflix", charges("Netflix", [49_900, 49_900, 64_900], 30), now)!;
    expect(s).toMatchObject({ cadence: "monthly", amount_minor: 64_900, previous_minor: 49_900, monthly_minor: 64_900, active: true, charges: 3 });
    // Still flagged two charges after the rise; forgotten once it's old news.
    expect(asSubscription("netflix", charges("Netflix", [49_900, 64_900, 64_900, 64_900], 30), now)?.previous_minor).toBe(49_900);
    expect(asSubscription("netflix", charges("Netflix", [49_900, 64_900, 64_900, 64_900, 64_900], 30), now)?.previous_minor).toBeNull();
  });

  it("needs only two charges when filed under Subscriptions, and spots yearly plans", () => {
    expect(asSubscription("spotify", charges("Spotify", [11_900, 11_900], 31, "subscriptions"), now)?.cadence).toBe("monthly");
    expect(asSubscription("spotify", charges("Spotify", [11_900, 11_900], 31), now)).toBeNull();
    const y = asSubscription("icloud", charges("iCloud", [99_900, 99_900], 365), now)!;
    expect(y).toMatchObject({ cadence: "yearly", monthly_minor: 8_325 });
  });

  it("ignores irregular payees and marks a stopped one inactive", () => {
    expect(asSubscription("swiggy", charges("Swiggy", [40_000, 25_000, 61_000, 30_000], 6), now)).toBeNull();
    expect(asSubscription("swiggy", charges("Swiggy", [40_000, 95_000, 20_000], 30), now)).toBeNull(); // amounts all over
    const old = charges("Hotstar", [29_900, 29_900, 29_900], 30).map((c) => ({ ...c, occurredAt: new Date(c.occurredAt.getTime() - 90 * DAY) }));
    expect(asSubscription("hotstar", old, now)?.active).toBe(false);
  });

  it("lists them through the API, and hiding one is undoable", async () => {
    const t = Date.now();
    for (let i = 0; i < 3; i++) await manual(64_900, "Netflix", new Date(t - (2 - i) * 30 * DAY - DAY), "subscriptions");
    const list = (await req("GET", "/v1/subscriptions")).json();
    expect(list.subscriptions).toHaveLength(1);
    expect(list.monthly_total_minor).toBe(64_900);
    expect(list.yearly_total_minor).toBe(64_900 * 12);
    await req("PUT", "/v1/subscriptions/hidden", { key: "netflix", hidden: true });
    expect((await req("GET", "/v1/subscriptions")).json().subscriptions).toHaveLength(0);
    await req("PUT", "/v1/subscriptions/hidden", { key: "netflix", hidden: false });
    expect((await req("GET", "/v1/subscriptions")).json().subscriptions).toHaveLength(1);
  });
});

describe("category budgets", () => {
  it("tracks spending against a category limit and sends one calm note at 80% and at 100%", async () => {
    expect((await req("PUT", "/v1/budgets/income", { amount_minor: 100 })).statusCode).toBe(400);
    await req("PUT", "/v1/budgets/food", { amount_minor: 100_000 });
    await manual(85_000, "Swiggy", new Date(), "food");
    const b = (await req("GET", "/v1/budgets")).json();
    expect(b.budgets).toEqual([{ category: "food", amount_minor: 100_000, spent_minor: 85_000 }]);

    const notifier = new Notifier(sql, null);
    await notifier.periodic();
    await notifier.periodic(); // no repeat
    let notes = await sql`select title, body from notifications where kind = 'budget' order by created_at`;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Food & dining is at 80% of its budget");
    expect(notes[0]!.body).not.toMatch(/!/);

    await manual(20_000, "Zomato", new Date(), "food");
    await notifier.periodic();
    notes = await sql`select title from notifications where kind = 'budget' order by created_at`;
    expect(notes.map((n) => n.title)).toEqual(["Food & dining is at 80% of its budget", "Food & dining budget reached"]);

    expect((await req("DELETE", "/v1/budgets/food")).json().budgets).toEqual([]);
  });
});

describe("health check", () => {
  it("reports SMS, mailboxes and notifications, and warns once when SMS stop", async () => {
    let h = (await req("GET", "/v1/health")).json();
    expect(h.checks.find((c: { id: string }) => c.id === "sms").state).toBe("off");
    expect(h.checks.find((c: { id: string }) => c.id === "push").state).toBe("off");

    await sms(BOB_TO("swiggy@icici", "800000000001", "100.00"), new Date(Date.now() - 5 * DAY));
    h = (await req("GET", "/v1/health")).json();
    expect(h.overall).toBe("warn");
    expect(h.checks.find((c: { id: string }) => c.id === "sms")).toMatchObject({ state: "warn", title: "Last bank SMS 5 days ago" });

    await sql`update users set digest_hour = 0`;
    const notifier = new Notifier(sql, null);
    await notifier.periodic();
    await notifier.periodic();
    expect(await sql`select title from notifications where dedupe_key like 'health:sms:%'`).toEqual([{ title: "No bank SMS for 3 days" }]);

    await sms(BOB_TO("swiggy@icici", "800000000002", "120.00"));
    h = (await req("GET", "/v1/health")).json();
    expect(h.checks.find((c: { id: string }) => c.id === "sms").state).toBe("ok");
  });
});

describe("undo", () => {
  it("puts an answered transaction back in the review queue", async () => {
    await sms(BOB_TO("9876543210@ybl", "900000000001", "250.00"));
    const [t] = await sql`select id from transactions`;
    expect((await req("GET", "/v1/transactions?review=1")).json().transactions).toHaveLength(1);
    await req("PATCH", `/v1/transactions/${t!.id}`, { category: "food", remember: true });
    expect((await req("GET", "/v1/transactions?review=1")).json().transactions).toHaveLength(0);
    expect(await sql`select count(*)::int as n from payee_rules`).toEqual([{ n: 1 }]);
    await req("PATCH", `/v1/transactions/${t!.id}`, { category: null, reviewed: false, forget: true });
    expect((await req("GET", "/v1/transactions?review=1")).json().transactions).toHaveLength(1);
    expect(await sql`select count(*)::int as n from payee_rules`).toEqual([{ n: 0 }]);
  });
});
