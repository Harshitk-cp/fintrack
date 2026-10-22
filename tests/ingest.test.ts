// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { newDataKey, newDeviceToken, newPairingCode, normalizePairingCode, Sealer, sha256 } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { ingestSms, processUnrecognized, purgeExpiredRaw, type SmsInput } from "../src/ingest.ts";
import type { Extraction, SmsExtractor } from "../src/llm.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://fintrack:fintrack@127.0.0.1:54329/fintrack_test";
const sql = connect(url);
const sealer = new Sealer(newDataKey());
const TZ = "Asia/Kolkata";
let userId: string;

beforeAll(async () => {
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql);
});
afterAll(() => sql.end());
beforeEach(async () => {
  await sql`truncate users cascade`;
  [{ id: userId }] = (await sql`insert into users (name) values ('test') returning id`) as unknown as [{ id: string }];
});

const sms = (body: string, at = "2026-10-21T15:00:00+05:30"): SmsInput => ({
  userId, deviceId: null, sender: null, body, receivedAt: new Date(at), sourceId: null,
});
const ingest = (body: string, at?: string) => ingestSms(sql, sealer, TZ, sms(body, at));
const count = async (table: "transactions" | "evidence") =>
  Number((await sql`select count(*) from ${sql(table)}`)[0]!.count);

const BOB = (ref: string, amt = "180.00") =>
  `Rs.${amt} Dr. from A/C XXXXXX1234 and Cr. to ramesh.k@ybl. Ref:${ref}. AvlBal:Rs12345.67(2026:10:21 14:32:10). Not you? Call 18005700-BOB`;

describe("ingestSms", () => {
  it("creates one transaction and is idempotent on resend", async () => {
    const a = await ingest(BOB("429512345678"));
    const b = await ingest(BOB("429512345678"));
    expect(a).toMatchObject({ status: "linked", duplicate: false });
    expect(b).toMatchObject({ duplicate: true, transactionId: a.transactionId, evidenceId: a.evidenceId });
    expect(await count("transactions")).toBe(1);
    expect(await count("evidence")).toBe(1);
  });

  it("keeps two identical-amount purchases separate", async () => {
    await ingest(BOB("429500000001"));
    await ingest(BOB("429500000002"));
    expect(await count("transactions")).toBe(2);
  });

  it("links differently-worded evidence sharing a reference", async () => {
    const a = await ingest(BOB("429512345678"));
    const b = await ingest("Rs.180.00 debited from Bank of Baroda A/c XX1234 to ramesh.k@ybl UPI Ref 429512345678");
    expect(b).toMatchObject({ status: "linked", transactionId: a.transactionId, duplicate: false });
    expect(await count("transactions")).toBe(1);
    expect(await count("evidence")).toBe(2);
  });

  it("flags a reference whose amount disagrees instead of merging", async () => {
    await ingest(BOB("429512345678"));
    const b = await ingest(BOB("429512345678", "1800.00"));
    expect(b).toMatchObject({ status: "ambiguous", reason: "reference_amount_mismatch", transactionId: null });
    expect(await count("transactions")).toBe(1);
  });

  it("keeps a refund separate from the purchase with the same reference", async () => {
    await ingest(BOB("429512345678"));
    await ingest("Rs.180.00 Credited to A/c ...1234 thru UPI/429512345678 by ramesh.k@ybl. Reversal. Bank of Baroda");
    const rows = await sql`select direction, event_type from transactions order by direction`;
    expect(rows.map((r) => [r.direction, r.event_type])).toEqual([["credit", "refund"], ["debit", "unknown"]]);
  });

  it("stores unrecognized messages without a transaction", async () => {
    const r = await ingest("Rs.100 debited from A/c XX1111 to x@ybl");
    expect(r).toMatchObject({ status: "unrecognized", transactionId: null });
    expect(await count("transactions")).toBe(0);
  });

  it("does not keep raw text for ignored messages, and seals the rest", async () => {
    await ingest("Rs.199 will be debited from HDFC Bank A/c XX4321 on 25-10-26 for NETFLIX mandate");
    const linked = await ingest(BOB("429512345678"));
    const rows = await sql`select status, raw_content_enc from evidence order by status`;
    expect(rows.find((r) => r.status === "ignored")!.raw_content_enc).toBeNull();
    const sealed = rows.find((r) => r.status === "linked")!.raw_content_enc as Buffer;
    expect(sealed.toString("utf8")).not.toContain("ramesh");
    expect(sealer.open(sealed)).toBe(BOB("429512345678"));
    expect(linked.status).toBe("linked");
  });

  it("purges raw text after retention", async () => {
    await ingest(BOB("429512345678"));
    await sql`update evidence set retention_until = now() - interval '1 second'`;
    expect(await purgeExpiredRaw(sql)).toBe(1);
    expect((await sql`select raw_content_enc from evidence`)[0]!.raw_content_enc).toBeNull();
  });

  it("isolates users", async () => {
    await ingest(BOB("429512345678"));
    const [other] = await sql`insert into users (name) values ('friend') returning id`;
    const r = await ingestSms(sql, sealer, TZ, { ...sms(BOB("429512345678")), userId: other!.id });
    expect(r.duplicate).toBe(false);
    expect(await count("transactions")).toBe(2);
  });
});

describe("API", () => {
  async function setup() {
    const app = await buildApi({ sql, sealer, timeZone: TZ, logger: false });
    const { token, hash } = newDeviceToken();
    const [d] = await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, 'phone', 'ios', ${hash}) returning id`;
    const post = (payload: unknown, auth = `Bearer ${token}`) =>
      app.inject({ method: "POST", url: "/v1/sms", headers: { authorization: auth }, payload: payload as object });
    return { app, token, deviceId: d!.id as string, post };
  }

  it("ingests with a device token and lists transactions", async () => {
    const { app, token, post } = await setup();
    const res = await post({ body: BOB("429512345678"), received_at: "2026-10-21T15:00:00+05:30" });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: `Bearer ${token}` } });
    expect(list.json().transactions).toMatchObject([{ amount_minor: 18000, last4: "1234", evidence_count: 1 }]);
  });

  it("rejects missing, wrong and revoked tokens", async () => {
    const { deviceId, post } = await setup();
    expect((await post({ body: "x" }, "")).statusCode).toBe(401);
    expect((await post({ body: "x" }, "Bearer ftd_nope")).statusCode).toBe(401);
    await sql`update devices set revoked_at = now() where id = ${deviceId}`;
    expect((await post({ body: BOB("429512345678") })).statusCode).toBe(401);
  });

  it("refuses OTPs without storing them", async () => {
    const { post } = await setup();
    const res = await post({ body: "123456 is your OTP for Rs.500 on HDFC Bank Card 5678" });
    expect(res.statusCode).toBe(422);
    expect(await count("evidence")).toBe(0);
  });

  it("rejects oversized and malformed bodies", async () => {
    const { post } = await setup();
    expect((await post({ body: "x".repeat(20_000) })).statusCode).toBe(413);
    expect((await post({ body: "x".repeat(2_001) })).statusCode).toBe(400);
    expect((await post({ text: "wrong field" })).statusCode).toBe(400);
  });
});

describe("LLM fallback worker", () => {
  const ODD = "Paid INR 640.50 via Jupiter card ending 7788 at BLINKIT on 21/10/2026 14:05. Txn id 600000000020";
  const good: Extraction = {
    is_completed_transaction: true, not_transaction_reason: null, bank_name: "Jupiter", direction: "debit",
    amount: "640.50", account_last4: "7788", account_kind: "debit_card", channel: "card", counterparty: "BLINKIT",
    vpa: null, reference: "600000000020", date_text: "21/10/2026 14:05",
  };
  const fake = (fn: () => Extraction): SmsExtractor & { calls: number } => ({
    name: "fake", calls: 0,
    async extract() { this.calls++; return fn(); },
  });
  const run = (x: SmsExtractor) => processUnrecognized(sql, sealer, x, TZ);

  it("turns an unrecognized SMS into a linked transaction", async () => {
    const first = await ingest(ODD);
    expect(first.status).toBe("unrecognized");
    expect(await run(fake(() => good))).toEqual({ processed: 1, failed: 0 });
    const [ev] = await sql`select status, parser from evidence`;
    expect(ev).toMatchObject({ status: "linked", parser: "llm/fake" });
    const [t] = await sql`select t.amount_minor, a.institution_name from transactions t join accounts a on a.id = t.account_id`;
    expect(t).toMatchObject({ amount_minor: "64050", institution_name: "Jupiter" });
    // Resending the same SMS now reports the resolved state.
    expect(await ingest(ODD)).toMatchObject({ duplicate: true, status: "linked", transactionId: expect.any(String) });
  });

  it("does not create a transaction from an ungrounded amount", async () => {
    await ingest(ODD);
    const wrong = fake(() => ({ ...good, amount: "6400.00" }));
    for (let i = 0; i < 3; i++) await run(wrong);
    expect(wrong.calls).toBe(1); // the verdict is final, not retried
    expect(await count("transactions")).toBe(0);
    expect((await sql`select status, status_reason from evidence`)[0]).toMatchObject({ status: "unrecognized", status_reason: "llm_amount_not_in_text" });
  });

  it("records failures and stops retrying after 3 attempts", async () => {
    await ingest(ODD);
    const broken = fake(() => { throw new Error("overloaded"); });
    for (let i = 0; i < 5; i++) await run(broken);
    expect(broken.calls).toBe(3);
    const [ev] = await sql`select status, llm_attempts, llm_error from evidence`;
    expect(ev).toMatchObject({ status: "unrecognized", llm_attempts: 3, llm_error: "overloaded" });
  });

  it("marks non-transactions ignored and drops their raw text", async () => {
    await ingest("Get 10% cashback on your Jupiter card this Diwali! T&C apply");
    await run(fake(() => ({ ...good, is_completed_transaction: false, not_transaction_reason: "promotional" })));
    const [ev] = await sql`select status, status_reason, raw_content_enc from evidence`;
    expect(ev).toMatchObject({ status: "ignored", status_reason: "promotional", raw_content_enc: null });
  });

  it("leaves rule-parsed evidence alone", async () => {
    await ingest(BOB("429512345678"));
    const x = fake(() => good);
    await run(x);
    expect(x.calls).toBe(0);
  });
});

describe("pairing and summary API", () => {
  const app = () => buildApi({ sql, sealer, timeZone: TZ, logger: false });
  async function code(expiresIn = "15 minutes") {
    const c = newPairingCode();
    await sql`insert into pairing_codes (code_hash, user_id, device_name, platform, expires_at)
              values (${sha256(normalizePairingCode(c))}, ${userId}, 'Pixel', 'android', now() + ${expiresIn}::interval)`;
    return c;
  }

  it("redeems a code once for a working token", async () => {
    const a = await app();
    const c = await code();
    const res = await a.inject({ method: "POST", url: "/v1/pair", payload: { code: c.toLowerCase().replace("-", " ") } });
    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    const me = await a.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ user: { id: userId, name: "test" }, device: { name: "Pixel", platform: "android" } });
    expect((await a.inject({ method: "POST", url: "/v1/pair", payload: { code: c } })).statusCode).toBe(404);
  });

  it("rejects expired codes", async () => {
    const a = await app();
    const c = await code("-1 minute");
    expect((await a.inject({ method: "POST", url: "/v1/pair", payload: { code: c } })).statusCode).toBe(404);
  });

  it("summarizes a month without counting card bill payments as spending", async () => {
    const a = await app();
    const { token, hash } = newDeviceToken();
    await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, 'p', 'ios', ${hash})`;
    await ingest(BOB("429500000001"));                                   // 180 debit (BoB)
    await ingest("Spent Rs.3451 On HDFC Bank Card 3333 At SWIGGY On 2026-10-11:21:30:13");  // 3451 debit (HDFC)
    await ingest("Payment of Rs.10,000.00 received towards your HDFC Bank Credit Card ending 3333 on 21-10-2026");
    await ingest("Rs.180.00 Credited to A/c ...1234 thru UPI/429500000001 by ramesh.k@ybl. Reversal. Bank of Baroda");
    await ingest("Rs.12500 Credited to A/c ...1111 thru NEFT UTR IN12345678901234 by A PERSON. - Bank of Baroda");
    const res = await a.inject({ method: "GET", url: "/v1/summary?month=2026-10", headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toMatchObject({
      month: "2026-10", spent_minor: 363100, refunds_minor: 18000, net_spent_minor: 345100,
      received_minor: 1250000, transaction_count: 5,
      by_bank: [{ institution_name: "HDFC Bank", spent_minor: 345100 }, { institution_name: "Bank of Baroda", spent_minor: 18000 }],
    });
  });
});

describe("bank name without account digits", () => {
  it("keeps the institution on the transaction", async () => {
    await ingest("ICICI Bank Acct XX789 debited for Rs 120.00 on 21-Oct-26; chaiwala@ybl credited. UPI:600000000077.");
    const [t] = await sql`select account_id, institution, institution_name from transactions`;
    expect(t).toMatchObject({ account_id: null, institution: "icici", institution_name: "ICICI Bank" });
  });
});

describe("iOS Shortcut payloads", () => {
  it("accepts blank optional fields and trims a long sender", async () => {
    const app = await buildApi({ sql, sealer, timeZone: TZ, logger: false });
    const { token, hash } = newDeviceToken();
    await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, 'iphone', 'ios', ${hash})`;
    const res = await app.inject({
      method: "POST", url: "/v1/sms", headers: { authorization: `Bearer ${token}` },
      payload: { body: BOB("429512345678"), received_at: "", sender: `  ${"AD-BOBTXN-S ".repeat(6)}`, source_id: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "linked" });
    const [ev] = await sql`select sender from evidence`;
    expect((ev!.sender as string).length).toBeLessThanOrEqual(40);
  });
});
