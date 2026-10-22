// Payee names and categories from the model: when it's asked, what it may change, the cache, and repairs.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newDataKey, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { ingestEmail, ingestSms } from "../src/ingest.ts";
import { nameTransactions, needsNaming, repairProseNames, type PayeeGuess, type PayeeNamer, type PayeeQuestion } from "../src/naming.ts";

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

class FakeNamer implements PayeeNamer {
  asked: PayeeQuestion[] = [];
  #answer: (q: PayeeQuestion) => PayeeGuess;
  constructor(answer: (q: PayeeQuestion) => PayeeGuess) {
    this.#answer = answer;
  }
  async name(q: PayeeQuestion) {
    this.asked.push(q);
    return this.#answer(q);
  }
}

const sms = (body: string, at = "2026-10-21T15:00:00+05:30") =>
  ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "BOBSMS-S", body, receivedAt: new Date(at), sourceId: null });
const BOB_TO = (vpa: string, ref: string, amt = "270.00") =>
  `Rs.${amt} Dr. from A/C XXXXXX1234 and Cr. to ${vpa}. Ref:${ref}. AvlBal:Rs12345.67(2026:10:21 14:32:10). Not you? Call 18005700-BOB`;

describe("needsNaming", () => {
  it.each([
    ["SWIGGYI14242463", null, true],
    ["paperandpie.12345678@hdfcbank", "paperandpie.12345678@hdfcbank", true],
    ["MAKEMYTRIP INDIA PVT LTD", null, true],
    [null, "ramesh.k99@oksbi", true],
    ["Zomato Ltd", null, true],
    ["Chai Point", null, false],
  ])("%s / %s → %s", (cp, vpa, out) => expect(needsNaming(cp, vpa)).toBe(out));
});

describe("nameTransactions", () => {
  it("names a merchant, files it and takes it off the review queue; asks once per payee", async () => {
    await sms(BOB_TO("paperandpie.12345678@hdfcbank", "600000000001"));
    await sms(BOB_TO("paperandpie.12345678@hdfcbank", "600000000002", "120.00"));
    const namer = new FakeNamer(() => ({ name: "Paper & Pie", kind: "merchant", category: "food", confident: true }));
    expect(await nameTransactions(sql, sealer, namer)).toMatchObject({ looked: 2, asked: 1 });
    const rows = await sql`select ai_name, category, category_source, review_reason, label from transactions`;
    expect(rows).toEqual([
      { ai_name: "Paper & Pie", category: "food", category_source: "ai", review_reason: null, label: null },
      { ai_name: "Paper & Pie", category: "food", category_source: "ai", review_reason: null, label: null },
    ]);
    expect(namer.asked[0]).toMatchObject({ vpa: "paperandpie.12345678@hdfcbank", bank: "Bank of Baroda", direction: "debit" });
    expect(namer.asked[0]!.alert).toContain("Dr. from A/C");
    expect(await nameTransactions(sql, sealer, namer)).toMatchObject({ looked: 0 });
  });

  it("files an uncategorised merchant and takes it off the review queue", async () => {
    await ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "HDFCBK-S", body: "Sent Rs.455.00\nFrom HDFC Bank A/C *4321\nTo CHAI POINT\nOn 22/10/26\nRef 629599990999", receivedAt: new Date("2026-10-22T12:00:00Z"), sourceId: null });
    expect((await sql`select review_reason from transactions`)[0]!.review_reason).toBe("uncategorized");
    await nameTransactions(sql, sealer, new FakeNamer(() => ({ name: "Chai Point", kind: "merchant", category: "food", confident: true })));
    expect((await sql`select ai_name, category, review_reason from transactions`)[0]).toEqual({ ai_name: "Chai Point", category: "food", review_reason: null });
  });

  it("keeps people in review: AI can name them but not say who they are to you", async () => {
    await sms(BOB_TO("ramesh.k99@oksbi", "600000000003"));
    await nameTransactions(sql, sealer, new FakeNamer(() => ({ name: "Ramesh K", kind: "person", category: null, confident: false })));
    expect((await sql`select ai_name, category, review_reason from transactions`)[0]).toEqual({ ai_name: "Ramesh K", category: null, review_reason: "unknown_payee" });
  });

  it("leaves unsure guesses out, and never touches the user's label or category", async () => {
    await sms(BOB_TO("q8x7.pay@ybl", "600000000004"));
    await sql`update transactions set label = 'Gym', category = 'health', category_source = 'user'`;
    await sms(BOB_TO("zz91@axl", "600000000005"));
    const namer = new FakeNamer(() => ({ name: "Some Shop", kind: "merchant", category: "shopping", confident: false }));
    await nameTransactions(sql, sealer, namer);
    expect(namer.asked).toHaveLength(1); // the labelled one wasn't asked about
    const rows = await sql`select label, ai_name, category, category_source from transactions order by created_at`;
    expect(rows).toEqual([
      { label: "Gym", ai_name: null, category: "health", category_source: "user" },
      { label: null, ai_name: null, category: null, category_source: null },
    ]);
  });

  it("retries next time when the model call fails", async () => {
    await sms(BOB_TO("x1.y2@ybl", "600000000006"));
    const r = await nameTransactions(sql, sealer, new FakeNamer(() => { throw new Error("overloaded"); }));
    expect(r).toMatchObject({ failed: 1 });
    expect((await sql`select named_at from transactions`)[0]!.named_at).toBeNull();
  });
});

describe("repairProseNames", () => {
  const HDFC_EMAIL = "Alert : Update on your HDFC Bank Credit Card\nDear Card Member, We wish to inform you that Rs. 3283.36 has been debited from your HDFC Bank Credit Card ending 0271 towards MAKEMYTRIP INDIA PVT LTD on 12 Oct, 2026 at 06:13:10.";

  it("re-reads the alert to recover the payee, or clears it when the alert is gone", async () => {
    const a = await ingestEmail(sql, sealer, TZ, { userId, from: "alerts@hdfcbank.net", text: HDFC_EMAIL, receivedAt: new Date("2026-10-12T01:00:00Z"), messageId: "<a@x>" });
    const b = await ingestEmail(sql, sealer, TZ, { userId, from: "alerts@hdfcbank.net", text: HDFC_EMAIL.replace("3283.36", "999.00").replace("MAKEMYTRIP", "IRCTC"), receivedAt: new Date("2026-10-12T02:00:00Z"), messageId: "<b@x>" });
    // Simulate rows written by the old parser; for b the alert text has already been purged.
    await sql`update transactions set counterparty = 'inform you that Rs', named_at = now()`;
    await sql`update evidence set raw_content_enc = null where id = ${b.evidenceId}`;
    expect(await repairProseNames(sql, sealer, TZ)).toBe(2);
    expect((await sql`select counterparty, named_at from transactions where id = ${a.transactionId}`)[0]).toEqual({ counterparty: "MAKEMYTRIP INDIA PVT LTD", named_at: null });
    expect((await sql`select counterparty, named_at from transactions where id = ${b.transactionId}`)[0]).toEqual({ counterparty: null, named_at: null });
  });
});
