// Salary, savings and SIPs, and calm pace check-ins.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { paceLevel, type Coach, type PaceFacts } from "../src/coach.ts";
import { newDataKey, newDeviceToken, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { ingestEmail, ingestSms } from "../src/ingest.ts";
import { Notifier } from "../src/notify.ts";
import { processSipSuggestions, type SipReader, type SipReading } from "../src/sips.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://fintrack:fintrack@127.0.0.1:54329/fintrack_test";
const sql = connect(url);
const sealer = new Sealer(newDataKey());
const TZ = "Asia/Kolkata";
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

const auth = () => ({ authorization: `Bearer ${token}` });
const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: object) =>
  app.inject({ method, url: path, headers: auth(), ...(payload ? { payload } : {}) });
const sms = (body: string, at = new Date()) => ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "BOBSMS-S", body, receivedAt: at, sourceId: null });
const BOB_TO = (vpa: string, ref: string, amt: string) =>
  `Rs.${amt} Dr. from A/C XXXXXX1234 and Cr. to ${vpa}. Ref:${ref}. AvlBal:Rs12345.67. Not you? Call 18005700-BOB`;
const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date());

class FakeReader implements SipReader {
  answer: SipReading;
  constructor(answer: SipReading) {
    this.answer = answer;
  }
  async read() {
    return this.answer;
  }
}

describe("salary and savings in the summary", () => {
  it("counts investments and unmatched SIP payments as savings, not spending, and splits needs and wants", async () => {
    await req("PATCH", "/v1/settings", { monthly_income_minor: 8_000_000 });
    await sms(BOB_TO("swiggy@icici", "600000000001", "500.00")); // food → wants
    await sms(BOB_TO("bescom.bill@okaxis", "600000000002", "1200.00")); // bills → needs
    const inv = await sms(BOB_TO("zerodha.broking@hdfcbank", "600000000003", "5000.00")); // investments → savings
    expect((await sql`select category from transactions where id = ${inv.transactionId}`)[0]!.category).toBe("investments");
    const sip = (await req("POST", "/v1/sips", { name: "PPFAS Flexi Cap", amount_minor: 300_000 })).json().sips[0];
    await req("PUT", `/v1/sips/${sip.id}/paid`, { month: thisMonth, paid: true });

    const s = (await req("GET", "/v1/summary")).json();
    expect(s.income_minor).toBe(8_000_000);
    expect(s.net_spent_minor).toBe(170_000);
    expect(s.saved_minor).toBe(800_000);
    expect(s.buckets).toEqual({ needs: 120_000, wants: 50_000, unsorted: 0, savings: 800_000 });
  });

  it("asks for the salary at sign-up (optional) and lets it change", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { phone: "9876543210", pin: "4821", name: "Kage", monthly_income_minor: 9_500_000 } });
    const t2 = r.json().token;
    expect((await app.inject({ url: "/v1/settings", headers: { authorization: `Bearer ${t2}` } })).json().monthly_income_minor).toBe(9_500_000);
    const r2 = await app.inject({ method: "PATCH", url: "/v1/settings", headers: { authorization: `Bearer ${t2}` }, payload: { monthly_income_minor: null } });
    expect(r2.json().monthly_income_minor).toBeNull();
  });
});

describe("SIPs", () => {
  it("adds, ticks a month paid and unticks it, and refuses duplicates", async () => {
    const created = await req("POST", "/v1/sips", { name: "Nifty 50 Index", amount_minor: 500_000, day_of_month: 5 });
    expect(created.statusCode).toBe(201);
    const sip = created.json().sips[0];
    expect(sip).toMatchObject({ name: "Nifty 50 Index", amount_minor: 500_000, day_of_month: 5, paid: null });
    expect((await req("POST", "/v1/sips", { name: "nifty 50 INDEX", amount_minor: 1 })).json()).toEqual({ error: "sip_exists" });

    const paid = await req("PUT", `/v1/sips/${sip.id}/paid`, { month: thisMonth, paid: true });
    expect(paid.json().sips[0].paid).toMatchObject({ amount_minor: 500_000, transaction_id: null });
    expect((await req("PUT", `/v1/sips/${sip.id}/paid`, { month: thisMonth, paid: false })).json().sips[0].paid).toBeNull();
  });

  it("only lets the owner see or change a SIP", async () => {
    const sip = (await req("POST", "/v1/sips", { name: "Gold ETF", amount_minor: 100_000 })).json().sips[0];
    const [other] = await sql`insert into users (name) values ('other') returning id`;
    const t2 = newDeviceToken();
    await sql`insert into devices (user_id, name, platform, token_hash) values (${other!.id}, 'p', 'ios', ${t2.hash})`;
    const h = { authorization: `Bearer ${t2.token}` };
    expect((await app.inject({ url: "/v1/sips", headers: h })).json().sips).toEqual([]);
    expect((await app.inject({ method: "PUT", url: `/v1/sips/${sip.id}/paid`, headers: h, payload: { month: thisMonth, paid: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/sips/${sip.id}`, headers: h })).statusCode).toBe(404);
  });
});

describe("SIP alerts", () => {
  const SIP_EMAIL = "SIP instalment processed\nYour SIP of Rs.5,000.00 in Parag Parikh Flexi Cap Fund - Direct Growth has been debited from your A/c XX1234 on 05-10-2026.";
  const ingestSip = (text = SIP_EMAIL, id = "<sip1@x>") =>
    ingestEmail(sql, sealer, TZ, { userId, from: "alerts@hdfcbank.net", text, receivedAt: new Date(), messageId: id });
  const reading = (r: Partial<SipReading>): SipReading => ({ is_sip: true, scheme: "Parag Parikh Flexi Cap Fund", amount: "5,000.00", status: "debited", confident: true, ...r });

  it("a clear debit creates the SIP and marks the month paid, as savings", async () => {
    const e = await ingestSip();
    await processSipSuggestions(sql, sealer, new FakeReader(reading({})), TZ);
    const s = (await req("GET", "/v1/sips")).json();
    expect(s.sips).toEqual([expect.objectContaining({ name: "Parag Parikh Flexi Cap Fund", amount_minor: 500_000, source: "detected", paid: expect.objectContaining({ transaction_id: e.transactionId }) })]);
    expect(s.suggestions).toEqual([]);
    expect((await sql`select category from transactions where id = ${e.transactionId}`)[0]!.category).toBe("investments");
  });

  it("a second month's debit is matched to the same SIP", async () => {
    await req("POST", "/v1/sips", { name: "Parag Parikh Flexi Cap", amount_minor: 500_000 });
    await ingestSip();
    await processSipSuggestions(sql, sealer, new FakeReader(reading({ scheme: "Parag Parikh Flexi Cap Fund - Direct Growth" })), TZ);
    expect((await req("GET", "/v1/sips")).json().sips).toHaveLength(1);
  });

  it("an unclear one goes to the user, who adds it from Review with that month paid", async () => {
    const e = await ingestSip("Mutual fund SIP alert\nAmount Rs.2,500 debited towards your SIP.", "<sip2@x>");
    await processSipSuggestions(sql, sealer, new FakeReader(reading({ scheme: null, amount: "2,500", confident: false })), TZ);
    const [g] = (await req("GET", "/v1/sips")).json().suggestions;
    expect(g).toMatchObject({ scheme: null, amount_minor: 250_000, transaction_id: e.transactionId });

    const added = await req("POST", "/v1/sips", { name: "Axis ELSS", amount_minor: 250_000, from_suggestion: g.id });
    expect(added.json().suggestions).toEqual([]);
    expect(added.json().sips[0].paid).toMatchObject({ amount_minor: 250_000, transaction_id: e.transactionId });
  });

  it("doesn't trust an amount that isn't in the alert, and drops things that aren't SIPs", async () => {
    await ingestSip();
    await processSipSuggestions(sql, sealer, new FakeReader(reading({ amount: "50,000" })), TZ);
    expect((await sql`select status, amount_minor from sip_suggestions`)[0]).toEqual({ status: "needs_user", amount_minor: null });
    await sql`truncate sip_suggestions`;
    await ingestSip("Your mutual fund statement is ready", "<sip3@x>");
    await processSipSuggestions(sql, sealer, new FakeReader(reading({ is_sip: false })), TZ);
    expect((await sql`select status from sip_suggestions`)[0]!.status).toBe("dismissed");
  });

  it("keeps the text of a SIP reminder even though it isn't a payment", async () => {
    const r = await ingestSip("SIP reminder: Rs.5,000 will be debited on 05-11-2026 for your SIP in Nifty 50 Index Fund.", "<sip4@x>");
    expect(r.status).toBe("ignored");
    expect((await sql`select raw_content_enc is not null as kept from evidence where id = ${r.evidenceId}`)[0]!.kept).toBe(true);
    expect((await sql`select count(*)::int as n from sip_suggestions`)[0]!.n).toBe(1);
  });
});

describe("pace check-ins", () => {
  it("levels", () => {
    expect(paceLevel(0.3, 0.3)).toBeNull();
    expect(paceLevel(0.55, 0.35)).toBe(1);
    expect(paceLevel(0.55, 0.5)).toBeNull(); // half gone, half the month gone: fine
    expect(paceLevel(0.8, 0.6)).toBe(2);
    expect(paceLevel(0.95, 0.7)).toBe(3);
    expect(paceLevel(0.95, 0.95)).toBeNull();
  });

  class FakeCoach implements Coach {
    facts: PaceFacts[] = [];
    async write(f: PaceFacts) {
      this.facts.push(f);
      return { title: "Easy does it", body: "Half your salary is spent with most of the month to go." };
    }
  }

  it("sends a calm note once per level per month, written with the real numbers", async () => {
    await sql`update users set monthly_income_minor = 1000000, digest_hour = 23 where id = ${userId}`;
    // 10 Oct (a Saturday): 6,000 of 10,000 spent → level 1.
    const now = new Date("2026-10-10T06:00:00Z");
    await sms(BOB_TO("swiggy@icici", "600000000010", "6000.00"), new Date("2026-10-09T10:00:00Z"));
    const coach = new FakeCoach();
    const n = new Notifier(sql, null, null, () => now);
    n.setCoach(coach);
    await n.periodic();
    await n.periodic();
    const notes = await sql`select kind, title, dedupe_key from notifications where kind = 'insight'`;
    expect(notes).toEqual([{ kind: "insight", title: "Easy does it", dedupe_key: "pace:2026-10:1" }]);
    expect(coach.facts[0]).toMatchObject({ incomeMinor: 1_000_000, spentMinor: 600_000, reason: "ahead", daysLeft: 21, topCategory: { name: "Food & dining" } });
  });

  it("checks in on Sundays at the digest hour, plainly when there's no model", async () => {
    await sql`update users set monthly_income_minor = 1000000, digest_hour = 20 where id = ${userId}`;
    const n = new Notifier(sql, null, null, () => new Date("2026-10-11T15:00:00Z")); // Sun 20:30 IST
    await n.periodic();
    const [note] = await sql`select title, body, dedupe_key from notifications where kind = 'insight'`;
    expect(note).toMatchObject({ dedupe_key: "weekly:2026-10-11", title: "You're on track this month" });
  });
});
