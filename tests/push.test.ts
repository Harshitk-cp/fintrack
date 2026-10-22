// Android push through FCM alongside ntfy: payload style, key loading, delivery and token routes.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { newDataKey, newDeviceToken, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";
import { FcmSender, fcmPayload, loadServiceAccount, type FcmMessage, type FcmResult } from "../src/fcm.ts";
import { Notifier, type FcmLike, type PushMessage, type PushSender } from "../src/notify.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://fintrack:fintrack@127.0.0.1:54329/fintrack_test";
const sql = connect(url);
const sealer = new Sealer(newDataKey());
let userId: string;
let deviceId: string;
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
  [{ id: deviceId }] = (await sql`insert into devices (user_id, name, platform, token_hash) values (${userId}, 'pixel', 'android', ${t.hash}) returning id`) as unknown as [{ id: string }];
});

class FakeFcm implements FcmLike {
  sent: { token: string; m: FcmMessage }[] = [];
  dead = new Set<string>();
  async send(t: string, m: FcmMessage): Promise<FcmResult> {
    if (this.dead.has(t)) return "unregistered";
    this.sent.push({ token: t, m });
    return "sent";
  }
}
class FakeNtfy implements PushSender {
  server = "https://ntfy.test";
  sent: { topic: string; m: PushMessage }[] = [];
  async send(topic: string, m: PushMessage) {
    this.sent.push({ topic, m });
  }
}

describe("fcm payload", () => {
  it("is an Android notification in the app style, on the right channel, opening the deep link", () => {
    const p = fcmPayload("tok", { title: "₹640 spent · HDFC Bank", body: "SWIGGY · Food & dining", url: "fintrack://transaction/1", channel: "payments", tag: "txn:1", high: true });
    expect(p).toEqual({
      token: "tok",
      notification: { title: "₹640 spent · HDFC Bank", body: "SWIGGY · Food & dining" },
      data: { url: "fintrack://transaction/1" },
      android: { priority: "HIGH", notification: { channel_id: "payments", icon: "notification_icon", color: "#FF8400", tag: "txn:1", default_sound: true } },
    });
  });
});

describe("loadServiceAccount", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const json = JSON.stringify({ type: "service_account", project_id: "fintrack-d5d82", client_email: "x@fintrack-d5d82.iam.gserviceaccount.com", private_key: privateKey });
  it("accepts JSON or base64, and refuses something else", () => {
    expect(loadServiceAccount(json)?.project_id).toBe("fintrack-d5d82");
    expect(loadServiceAccount(Buffer.from(json).toString("base64"))?.project_id).toBe("fintrack-d5d82");
    expect(loadServiceAccount("")).toBeNull();
    expect(() => loadServiceAccount(JSON.stringify({ project_info: {} }))).toThrow(/service account/);
  });
});

describe("FcmSender", () => {
  it("signs its own OAuth token, caches it, and reports dead tokens", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const sender = new FcmSender({ project_id: "fintrack-d5d82", client_email: "svc@fintrack-d5d82.iam.gserviceaccount.com", private_key: privateKey });
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        const jwt = new URLSearchParams(String(init!.body)).get("assertion")!;
        const [h, c, s] = jwt.split(".");
        expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
        expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ iss: "svc@fintrack-d5d82.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging" });
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
      }
      expect(url).toBe("https://fcm.googleapis.com/v1/projects/fintrack-d5d82/messages:send");
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer ya29.test");
      const body = JSON.parse(String(init!.body));
      return body.message.token === "dead"
        ? new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 })
        : new Response("{}");
    }) as typeof fetch;
    try {
      const m = { title: "t", body: "b", url: "fintrack://inbox", channel: "payments" } as const;
      expect(await sender.send("live", m)).toBe("sent");
      expect(await sender.send("dead", m)).toBe("unregistered");
      expect(calls.filter((u) => u.includes("oauth2")).length).toBe(1); // token reused
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("delivery", () => {
  const notify = (title = "₹640 spent · HDFC Bank") =>
    sql`insert into notifications (user_id, kind, title, body, dedupe_key) values (${userId}, 'transaction', ${title}, 'SWIGGY', ${`k:${title}`}) returning id`;

  it("sends to every Android phone and to ntfy, and marks it pushed", async () => {
    await sql`update users set push_topic = 'fintrack-abc' where id = ${userId}`;
    await sql`insert into push_tokens (token, user_id, device_id) values ('tok-a', ${userId}, ${deviceId})`;
    const fcm = new FakeFcm();
    const ntfy = new FakeNtfy();
    const n = new Notifier(sql, ntfy);
    n.setFcm(fcm);
    await notify();
    await n.deliver();
    expect(ntfy.sent).toHaveLength(1);
    expect(fcm.sent).toEqual([{ token: "tok-a", m: expect.objectContaining({ channel: "payments", url: "fintrack://inbox", high: true }) }]);
    expect((await sql`select pushed_at is not null as done from notifications`)[0]!.done).toBe(true);
  });

  it("works with FCM alone, and forgets tokens Firebase says are dead", async () => {
    await sql`insert into push_tokens (token, user_id, device_id) values ('tok-dead', ${userId}, ${deviceId})`;
    const fcm = new FakeFcm();
    fcm.dead.add("tok-dead");
    const n = new Notifier(sql, null);
    n.setFcm(fcm);
    await notify();
    await n.deliver();
    expect((await sql`select count(*)::int as c from push_tokens`)[0]!.c).toBe(0);
    expect((await sql`select pushed_at, push_error from notifications`)[0]).toMatchObject({ pushed_at: null, push_error: "no target" });
  });
});

describe("token routes", () => {
  let app: Awaited<ReturnType<typeof buildApi>>;
  afterEach(() => app?.close());
  const auth = () => ({ authorization: `Bearer ${token}` });
  const put = (t: string) => app.inject({ method: "PUT", url: "/v1/push/fcm", headers: auth(), payload: { token: t } });

  it("is off without a service account", async () => {
    app = await buildApi({ sql, sealer, timeZone: "Asia/Kolkata", logger: false });
    expect((await put("x".repeat(40))).json()).toEqual({ error: "fcm_disabled" });
  });

  it("keeps one token per phone, reports it in settings, and drops it on sign-out", async () => {
    app = await buildApi({ sql, sealer, timeZone: "Asia/Kolkata", logger: false, fcm: true });
    expect((await put("a".repeat(40))).statusCode).toBe(204);
    expect((await put("b".repeat(40))).statusCode).toBe(204); // token rotated on the same phone
    expect((await sql`select token from push_tokens`).map((r) => r.token)).toEqual(["b".repeat(40)]);
    expect((await app.inject({ url: "/v1/settings", headers: auth() })).json().fcm).toEqual({ available: true, devices: 1 });

    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: auth(), payload: {} })).statusCode).toBe(204);
    expect((await sql`select count(*)::int as c from push_tokens`)[0]!.c).toBe(0);
  });
});
