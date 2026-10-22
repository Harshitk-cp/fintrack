// Bank alert emails: filters, parsing, mailbox sync, SMS+email matching and the API.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { newDataKey, newDeviceToken, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { ingestSms } from "../src/ingest.ts";
import { alertText, htmlToText, imapServerFor, isBankSender, looksLikeTransactionSubject, parseEmail } from "../src/mail/filter.ts";
import { MailPoller, syncMailbox } from "../src/mail/poller.ts";
import { ImapMailSource, MailAuthError, MailHostError, resolvePublicHost, type MailBatch, type MailCredentials, type MailCursor, type MailSource } from "../src/mail/source.ts";
import { Notifier } from "../src/notify.ts";
import { parseSms } from "../src/sms/parser.ts";

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

/** A raw RFC 822 message. By default the provider's header says DKIM and DMARC passed for the From domain. */
function mime({ from, subject, html, text, date = "Thu, 22 Oct 2026 15:10:40 +0530", id, auth }: { from: string; subject: string; html?: string; text?: string; date?: string; id: string; auth?: string | null }) {
  const domain = /@([^>]+)>?$/.exec(from)![1];
  const ar = auth === undefined ? `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=REJECT) header.from=${domain}` : auth;
  const head = `${ar === null ? "" : `Authentication-Results: ${ar}\r\n`}From: ${from}\r\nTo: kage@gmail.com\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${id}>\r\nMIME-Version: 1.0\r\n`;
  return Buffer.from(html
    ? `${head}Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`
    : `${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`);
}

const HDFC_UPI_HTML = `<html><body><table><tr><td>Dear Customer,</td></tr>
<tr><td>Rs.640.00 has been debited from account **4321 to VPA swiggy@icici SWIGGY on 22-10-26.</td></tr>
<tr><td>Your UPI transaction reference number is 629512340101.</td></tr>
<tr><td>If you did not authorize this transaction, please report it immediately. Never share your OTP, PIN or password with anyone.</td></tr>
<tr><td>Warm Regards,<br>HDFC Bank</td></tr></table></body></html>`;

const SWIGGY_SMS = `Sent Rs.640.00
From HDFC Bank A/C *4321
To SWIGGY
On 22/10/26
Ref 629512340101
Not You?
Call 18002586161/SMS BLOCK UPI to 7308080808`;

describe("filters", () => {
  it("knows the IMAP server for common providers", () => {
    expect(imapServerFor("kage@gmail.com")).toEqual({ host: "imap.gmail.com", port: 993 });
    expect(imapServerFor("x@outlook.com")?.host).toBe("outlook.office365.com");
    expect(imapServerFor("x@mycompany.in")).toBeNull();
  });

  it("recognises bank senders, including .bank.in and subdomains", () => {
    expect(isBankSender("alerts@hdfcbank.net")).toBe(true);
    expect(isBankSender("alerts@hdfcbank.bank.in")).toBe(true);
    expect(isBankSender("noreply@mailers.icicibank.com")).toBe(true);
    expect(isBankSender("offers@hdfcbank-rewards.com")).toBe(false);
    expect(isBankSender("friend@gmail.com")).toBe(false);
  });

  it("keeps transaction subjects and drops marketing and security mail", () => {
    expect(looksLikeTransactionSubject("You have done a UPI txn. Check details!")).toBe(true);
    expect(looksLikeTransactionSubject("Alert : Update on your HDFC Bank Credit Card")).toBe(true);
    expect(looksLikeTransactionSubject("Your account has been debited")).toBe(true);
    expect(looksLikeTransactionSubject("Exclusive festive offer on your card")).toBe(false);
    expect(looksLikeTransactionSubject("Your e-statement for October")).toBe(false);
    expect(looksLikeTransactionSubject("OTP for your transaction")).toBe(false);
    expect(looksLikeTransactionSubject("Monthly newsletter")).toBe(false);
  });

  it("cuts the disclaimer so 'never share your OTP' doesn't make it look like an OTP", () => {
    const text = alertText("You have done a UPI txn", htmlToText(HDFC_UPI_HTML));
    expect(text).toContain("Rs.640.00 has been debited");
    expect(text).not.toMatch(/OTP/);
    expect(text).not.toMatch(/Warm Regards/);
  });
});

describe("email phrasing the rule parser understands", () => {
  it("HDFC card email: 'thank you for using your card … at MERCHANT'", () => {
    const text = "Alert : Update on your HDFC Bank Credit Card\nThank you for using your HDFC Bank Credit Card ending 0271 for Rs 1,299.00 at MYNTRA on 21-10-2026 18:22:10.";
    expect(parseSms("alerts@hdfcbank.net", text, new Date("2026-10-21T13:00:00Z"), TZ)).toMatchObject({
      kind: "transaction", parser: "hdfc/v1", txn: { direction: "debit", amountMinor: 129900, counterparty: "MYNTRA", last4: "0271", occurredAt: new Date("2026-10-21T12:52:10.000Z") },
    });
  });

  it("HDFC card email: 'we wish to inform you that Rs …' names the merchant, not the sentence", () => {
    const text = "Alert : Update on your HDFC Bank Credit Card\nDear Card Member, We wish to inform you that Rs. 3283.36 has been debited from your HDFC Bank Credit Card ending 0271 towards MAKEMYTRIP INDIA PVT LTD on 12 Oct, 2026 at 06:13:10.";
    const r = parseSms("alerts@hdfcbank.net", text, new Date("2026-10-12T01:00:00Z"), TZ);
    expect(r).toMatchObject({ kind: "transaction", txn: { direction: "debit", amountMinor: 328336, counterparty: "MAKEMYTRIP INDIA PVT LTD", last4: "0271" } });
  });

  it("ICICI email: 'has been used for INR … towards MERCHANT'", () => {
    const text = "Transaction alert for your ICICI Bank account\nYour ICICI Bank Account XX5512 has been used for INR 2,150.00 on 21-Oct-26 towards Zomato Ltd.";
    expect(parseSms("customercare@icicibank.com", text, new Date("2026-10-21T16:00:00Z"), TZ)).toMatchObject({
      kind: "transaction", txn: { direction: "debit", amountMinor: 215000, counterparty: "Zomato Ltd", last4: "5512" },
    });
  });
});

describe("parseEmail", () => {
  it("reads an HTML alert into subject + alert text", async () => {
    const e = await parseEmail(mime({ from: "HDFC Bank InstaAlerts <alerts@hdfcbank.net>", subject: "You have done a UPI txn. Check details!", html: HDFC_UPI_HTML, id: "a1@hdfc" }));
    expect(e.from).toBe("alerts@hdfcbank.net");
    expect(e.messageId).toBe("<a1@hdfc>");
    expect(e.date?.toISOString()).toBe("2026-10-22T09:40:40.000Z");
    expect(e.text.split("\n")[0]).toBe("You have done a UPI txn. Check details!");
    expect(e.text).toContain("to VPA swiggy@icici");
  });
});

class FakeMailbox implements MailSource {
  messages: { uid: number; source: Buffer }[] = [];
  uidValidity = 7n;
  fail: Error | null = null;
  calls: MailCursor[] = [];
  async verify(c: MailCredentials) {
    if (c.pass !== "abcdefghijklmnop") throw new MailAuthError("authentication failed");
  }
  async fetchNew(_c: MailCredentials, cursor: MailCursor): Promise<MailBatch> {
    this.calls.push(cursor);
    if (this.fail) throw this.fail;
    const fresh = cursor.uidValidity !== this.uidValidity;
    const msgs = this.messages.filter((m) => fresh || m.uid > cursor.lastUid);
    return { uidValidity: this.uidValidity, lastUid: Math.max(cursor.lastUid, ...this.messages.map((m) => m.uid)), messages: msgs };
  }
}

async function addAccount() {
  const [a] = await sql`
    insert into mail_accounts (user_id, address, host, port, password_enc)
    values (${userId}, 'kage@gmail.com', 'imap.gmail.com', 993, ${sealer.seal("abcdefghijklmnop")}) returning id`;
  return a!.id as string;
}

describe("syncMailbox", () => {
  it("ingests bank alerts, skips the rest, saves the cursor and never re-reads", async () => {
    const box = new FakeMailbox();
    box.messages = [
      { uid: 10, source: mime({ from: "alerts@hdfcbank.net", subject: "You have done a UPI txn. Check details!", html: HDFC_UPI_HTML, id: "a1@hdfc" }) },
      { uid: 11, source: mime({ from: "alerts@hdfcbank.net", subject: "Exclusive festive offer", text: "Get 10% cashback on Rs.5000 spend", id: "a2@hdfc" }) },
    ];
    const id = await addAccount();
    expect(await syncMailbox(sql, sealer, TZ, box, id)).toEqual({ checked: 2, bankEmails: 1, transactions: 1, unverified: 0 });

    const [t] = await sql`select amount_minor, direction, source, counterparty_vpa, reference from transactions`;
    expect(t).toMatchObject({ amount_minor: "64000", direction: "debit", source: "email", counterparty_vpa: "swiggy@icici" });
    const [acc] = await sql`select status, last_uid, uid_validity, emails_found from mail_accounts`;
    expect(acc).toMatchObject({ status: "ok", last_uid: "11", uid_validity: "7", emails_found: 1 });

    await syncMailbox(sql, sealer, TZ, box, id);
    expect(box.calls.at(-1)).toEqual({ uidValidity: 7n, lastUid: 11 });
    expect((await sql`select count(*)::int as n from evidence`)[0]!.n).toBe(1);
  });

  it("re-reading the same email after a UIDVALIDITY reset is a no-op", async () => {
    const box = new FakeMailbox();
    box.messages = [{ uid: 10, source: mime({ from: "alerts@hdfcbank.net", subject: "You have done a UPI txn", html: HDFC_UPI_HTML, id: "a1@hdfc" }) }];
    const id = await addAccount();
    await syncMailbox(sql, sealer, TZ, box, id);
    box.uidValidity = 8n;
    expect(await syncMailbox(sql, sealer, TZ, box, id)).toMatchObject({ transactions: 0 });
    expect((await sql`select count(*)::int as n from transactions`)[0]!.n).toBe(1);
  });

  it("skips forged bank mail: no provider verdict, or a fake 'pass' below the provider's 'fail'", async () => {
    const box = new FakeMailbox();
    const forged = (id: string, auth: string | null) =>
      mime({ from: "HDFC Bank <alerts@hdfcbank.net>", subject: "You have done a UPI txn", html: HDFC_UPI_HTML, id, auth });
    box.messages = [
      { uid: 1, source: forged("f1@x", null) },
      { uid: 2, source: forged("f2@x", "mx.google.com; dkim=fail header.i=@hdfcbank.net; spf=fail; dmarc=fail header.from=hdfcbank.net\r\nAuthentication-Results: evil; dkim=pass header.i=@hdfcbank.net; dmarc=pass header.from=hdfcbank.net") },
      { uid: 3, source: forged("f3@x", "mx.google.com; dkim=pass header.i=@evil-mailer.com; dmarc=fail header.from=hdfcbank.net") },
    ];
    expect(await syncMailbox(sql, sealer, TZ, box, await addAccount())).toMatchObject({ bankEmails: 0, transactions: 0, unverified: 3 });
    expect((await sql`select count(*)::int as n from evidence`)[0]!.n).toBe(0);
  });

  it("marks a revoked app password as auth_failed", async () => {
    const box = new FakeMailbox();
    box.fail = new MailAuthError("authentication failed");
    const id = await addAccount();
    await expect(syncMailbox(sql, sealer, TZ, box, id)).rejects.toThrow(MailAuthError);
    expect((await sql`select status, last_error from mail_accounts`)[0]).toMatchObject({ status: "auth_failed", last_error: "authentication failed" });
  });
});

describe("SMS and email for the same payment", () => {
  const email = (html: string, id: string, date?: string) =>
    mime({ from: "alerts@hdfcbank.net", subject: "You have done a UPI txn. Check details!", html, id, date });

  it("joins an email to the SMS transaction and fills in what the SMS lacked", async () => {
    // The SMS has no UPI ID; the email has one. Same amount, bank, direction and time.
    const sms = SWIGGY_SMS.replace("Ref 629512340101\n", "");
    const s = await ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "HDFCBK-S", body: sms, receivedAt: new Date("2026-10-22T09:40:30Z"), sourceId: null });
    const box = new FakeMailbox();
    box.messages = [{ uid: 1, source: email(HDFC_UPI_HTML, "j1@hdfc") }];
    await syncMailbox(sql, sealer, TZ, box, await addAccount());

    const txns = await sql`select id, counterparty_vpa, reference, source from transactions`;
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ id: s.transactionId, counterparty_vpa: "swiggy@icici", reference: "629512340101", source: "sms" });
    const links = await sql`select e.source_type, te.match_method from transaction_evidence te join evidence e on e.id = te.evidence_id order by e.source_type desc`;
    expect(links).toEqual([{ source_type: "sms", match_method: "created" }, { source_type: "email", match_method: "heuristic" }]);
  });

  it("joins on the shared UPI reference when both messages carry it", async () => {
    const s = await ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "HDFCBK-S", body: SWIGGY_SMS, receivedAt: new Date("2026-10-22T09:40:30Z"), sourceId: null });
    const box = new FakeMailbox();
    // Even a day later, the reference ties them together.
    box.messages = [{ uid: 1, source: email(HDFC_UPI_HTML, "r1@hdfc", "Fri, 23 Oct 2026 15:10:40 +0530") }];
    await syncMailbox(sql, sealer, TZ, box, await addAccount());
    const links = await sql`select te.transaction_id, te.match_method from transaction_evidence te join evidence e on e.id = te.evidence_id where e.source_type = 'email'`;
    expect(links).toEqual([{ transaction_id: s.transactionId, match_method: "reference" }]);
  });

  it("does not join payments that differ in amount, or are far apart in time", async () => {
    await ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "HDFCBK-S", body: SWIGGY_SMS.replace("Ref 629512340101\n", "").replace("640.00", "650.00"), receivedAt: new Date("2026-10-22T09:40:30Z"), sourceId: null });
    const box = new FakeMailbox();
    box.messages = [{ uid: 1, source: email(HDFC_UPI_HTML.replace("629512340101", "629512340999"), "j2@hdfc") }];
    await syncMailbox(sql, sealer, TZ, box, await addAccount());
    expect((await sql`select count(*)::int as n from transactions`)[0]!.n).toBe(2);
  });

  it("never merges two SMS for identical purchases", async () => {
    const body = SWIGGY_SMS.replace("Ref 629512340101\n", "");
    await ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "HDFCBK-S", body, receivedAt: new Date("2026-10-22T09:40:30Z"), sourceId: null });
    await ingestSms(sql, sealer, TZ, { userId, deviceId: null, sender: "HDFCBK-S", body: `${body} `.replace("Not You?", "Not you?"), receivedAt: new Date("2026-10-22T09:42:00Z"), sourceId: null });
    expect((await sql`select count(*)::int as n from transactions`)[0]!.n).toBe(2);
  });
});

describe("MailPoller", () => {
  it("survives the database being unreachable (it runs from a timer)", async () => {
    const broken = (() => Promise.reject(Object.assign(new Error("write CONNECT_TIMEOUT"), { code: "CONNECT_TIMEOUT" }))) as unknown as typeof sql;
    const poller = new MailPoller(broken, sealer, TZ, new FakeMailbox());
    await expect(poller.syncDue()).resolves.toBeUndefined();
  });
});

describe("mail server addresses", () => {
  it.each(["127.0.0.1", "10.0.0.5", "172.20.0.3", "192.168.1.34", "169.254.169.254", "100.64.1.1", "::1", "::ffff:127.0.0.1", "fe80::1", "0.0.0.0"])(
    "refuses %s before connecting",
    async (host) => {
      await expect(resolvePublicHost(host)).rejects.toThrow(MailHostError);
      await expect(new ImapMailSource().verify({ host, port: 993, user: "a@b.c", pass: "x" })).rejects.toThrow(MailHostError);
    },
  );
  it("accepts a public address", async () => {
    expect(await resolvePublicHost("142.250.4.108")).toBe("142.250.4.108");
  });
});

describe("alerts", () => {
  it("doesn't alert for old payments found by a first mailbox sync", async () => {
    const box = new FakeMailbox();
    box.messages = [{ uid: 1, source: mime({ from: "alerts@hdfcbank.net", subject: "You have done a UPI txn", html: HDFC_UPI_HTML, id: "old@hdfc", date: "Mon, 05 Oct 2026 10:00:00 +0530" }) }];
    await syncMailbox(sql, sealer, TZ, box, await addAccount());
    const notifier = new Notifier(sql, null, null, () => new Date("2026-10-22T10:00:00Z"));
    await notifier.transactionAlerts();
    expect((await sql`select count(*)::int as n from notifications`)[0]!.n).toBe(0);
    expect((await sql`select notified_at is not null as done from transactions`)[0]!.done).toBe(true);
  });
});

describe("mail API", () => {
  let app: Awaited<ReturnType<typeof buildApi>>;
  const box = new FakeMailbox();
  const kicked: string[] = [];
  beforeEach(async () => {
    kicked.length = 0;
    app = await buildApi({ sql, sealer, timeZone: TZ, logger: false, mail: { source: box, poller: { kick: (id) => kicked.push(id) } } });
  });
  afterEach(() => app.close());
  const auth = () => ({ authorization: `Bearer ${token}` });

  const put = (address: string, extra: object = {}) =>
    app.inject({ method: "PUT", url: "/v1/mail", headers: auth(), payload: { address, app_password: "abcd efgh ijkl mnop", ...extra } });

  it("connects after checking the password, never returns it, and syncs at once", async () => {
    expect((await app.inject({ url: "/v1/mail", headers: auth() })).json()).toEqual({ available: true, max: 5, mailboxes: [] });
    const bad = await app.inject({ method: "PUT", url: "/v1/mail", headers: auth(), payload: { address: "kage@gmail.com", app_password: "wrong" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: "auth_failed" });

    const ok = await put("Kage@Gmail.com");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mailboxes).toEqual([expect.objectContaining({ address: "kage@gmail.com", host: "imap.gmail.com", status: "pending" })]);
    expect(JSON.stringify(ok.json())).not.toContain("abcd");
    expect(kicked).toHaveLength(1);
    const [row] = await sql`select password_enc from mail_accounts`;
    expect(sealer.open(row!.password_enc)).toBe("abcdefghijklmnop");
  });

  it("holds several mailboxes, updates one re-added, and caps the count", async () => {
    await put("kage@gmail.com");
    await put("kage.work@outlook.com");
    const again = await put("kage@gmail.com");
    expect(again.json().mailboxes.map((m: { address: string }) => m.address)).toEqual(["kage@gmail.com", "kage.work@outlook.com"]);
    for (const n of [1, 2, 3]) expect((await put(`k${n}@gmail.com`)).statusCode).toBe(200);
    const sixth = await put("k4@gmail.com");
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json()).toEqual({ error: "too_many_mailboxes" });
    // Re-adding one that exists is still allowed at the cap.
    expect((await put("kage@gmail.com")).statusCode).toBe(200);
  });

  it("syncs and removes one mailbox by id, only the user's own", async () => {
    const list = (await put("kage@gmail.com")).json().mailboxes;
    await put("kage.work@outlook.com");
    kicked.length = 0;
    expect((await app.inject({ method: "POST", url: "/v1/mail/sync", headers: auth() })).statusCode).toBe(202);
    expect(kicked).toHaveLength(2);
    kicked.length = 0;
    await app.inject({ method: "POST", url: `/v1/mail/sync?id=${list[0].id}`, headers: auth() });
    expect(kicked).toEqual([list[0].id]);

    // Another user can't delete it.
    const [other] = await sql`insert into users (name) values ('other') returning id`;
    const t2 = newDeviceToken();
    await sql`insert into devices (user_id, name, platform, token_hash) values (${other!.id}, 'p', 'ios', ${t2.hash})`;
    expect((await app.inject({ method: "DELETE", url: `/v1/mail/${list[0].id}`, headers: { authorization: `Bearer ${t2.token}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/mail/${list[0].id}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ url: "/v1/mail", headers: auth() })).json().mailboxes.map((m: { address: string }) => m.address)).toEqual(["kage.work@outlook.com"]);
  });

  it("nudges to connect a mailbox: again after 1 day, then 7 days, then never; the dot stays until connected", async () => {
    const nudges = async () => (await app.inject({ url: "/v1/nudges", headers: auth() })).json().mail;
    const dismiss = () => app.inject({ method: "POST", url: "/v1/nudges/mail/dismiss", headers: auth() });
    const nextAt = async () => (await sql`select mail_nudge_next_at as at from users where id = ${userId}`)[0]!.at as Date | null;
    const passTime = () => sql`update users set mail_nudge_next_at = now() - interval '1 second' where id = ${userId}`;

    expect(await nudges()).toEqual({ pending: true, show: true });

    await dismiss();
    expect(await nudges()).toEqual({ pending: true, show: false });
    expect(Math.round(((await nextAt())!.getTime() - Date.now()) / 3_600_000)).toBe(24);
    await passTime();
    expect(await nudges()).toEqual({ pending: true, show: true });

    await dismiss();
    expect(Math.round(((await nextAt())!.getTime() - Date.now()) / 86_400_000)).toBe(7);
    expect((await nudges()).show).toBe(false);
    await passTime();
    expect((await nudges()).show).toBe(true);

    await dismiss();
    expect(await nextAt()).toBeNull();
    expect(await nudges()).toEqual({ pending: true, show: false }); // never again, but the dot stays

    await put("kage@gmail.com");
    expect(await nudges()).toEqual({ pending: false, show: false });
  });

  it("a connected mailbox hides the banner and the dot from the start", async () => {
    await put("kage@gmail.com");
    expect((await app.inject({ url: "/v1/nudges", headers: auth() })).json()).toEqual({ mail: { pending: false, show: false } });
  });

  it("only allows TLS on port 993 and plain host names", async () => {
    const plain = await app.inject({ method: "PUT", url: "/v1/mail", headers: auth(), payload: { address: "me@mycompany.in", app_password: "abcdefghijklmnop", host: "imap.mycompany.in", port: 143 } });
    expect(plain.statusCode).toBe(400);
    const odd = await app.inject({ method: "PUT", url: "/v1/mail", headers: auth(), payload: { address: "me@mycompany.in", app_password: "abcdefghijklmnop", host: "imap.mycompany.in/../x" } });
    expect(odd.statusCode).toBe(400);
  });

  it("asks for a server for unknown providers, and disconnects", async () => {
    const r = await app.inject({ method: "PUT", url: "/v1/mail", headers: auth(), payload: { address: "me@mycompany.in", app_password: "abcdefghijklmnop" } });
    expect(r.json()).toEqual({ error: "unknown_provider" });
    await app.inject({ method: "PUT", url: "/v1/mail", headers: auth(), payload: { address: "me@mycompany.in", app_password: "abcdefghijklmnop", host: "imap.mycompany.in" } });
    const [box] = (await app.inject({ url: "/v1/mail", headers: auth() })).json().mailboxes;
    expect(box).toMatchObject({ address: "me@mycompany.in", host: "imap.mycompany.in" });
    expect((await app.inject({ method: "DELETE", url: `/v1/mail/${box.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await sql`select count(*)::int as n from mail_accounts`)[0]!.n).toBe(0);
  });
});
