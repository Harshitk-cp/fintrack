// Phone + PIN accounts: sign-up, sign-in, lockouts, the unlock check, PIN change and sign-out.
// Needs Postgres: `docker compose up -d` (uses fintrack_test on the dev container).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.ts";
import { isWeakPin, lockMs, normalizePhone } from "../src/auth.ts";
import { newDataKey, Sealer } from "../src/crypto.ts";
import { connect, migrate } from "../src/db.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://fintrack:fintrack@127.0.0.1:54329/fintrack_test";
const sql = connect(url);
let app: Awaited<ReturnType<typeof buildApi>>;

beforeAll(async () => {
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql);
});
afterAll(() => sql.end());
beforeEach(async () => {
  await sql`truncate users cascade`;
  // A fresh app per test so the per-IP rate limit starts empty.
  app = await buildApi({ sql, sealer: new Sealer(newDataKey()), timeZone: "Asia/Kolkata", logger: false });
});
afterEach(() => app.close());

const post = (path: string, payload: object, token?: string) =>
  app.inject({ method: "POST", url: path, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
const register = (phone = "98765 43210", pin = "4821", name = "Kage") =>
  post("/v1/auth/register", { phone, pin, name, platform: "ios", device_name: "iPhone" });
const login = (phone = "9876543210", pin = "4821") => post("/v1/auth/login", { phone, pin, platform: "android" });

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["+1 415 555 0100", "+14155550100"],
  ])("%s -> %s", (input, out) => expect(normalizePhone(input)).toBe(out));
  it.each(["12345", "1234567890", "+12", "hello"])("rejects %s", (input) => expect(normalizePhone(input)).toBeNull());
});

describe("isWeakPin", () => {
  it.each(["0000", "7777", "1234", "9876", "0123", "1212", "1999", "2026"])("refuses %s", (p) => expect(isWeakPin(p)).toBe(true));
  it.each(["4821", "3907", "8164", "0473"])("accepts %s", (p) => expect(isWeakPin(p)).toBe(false));
});

describe("lockMs", () => {
  it("locks on every 5th failure, doubling up to a day", () => {
    expect([1, 4, 6, 9].map(lockMs)).toEqual([0, 0, 0, 0]);
    expect(lockMs(5)).toBe(15 * 60_000);
    expect(lockMs(10)).toBe(30 * 60_000);
    expect(lockMs(100)).toBe(24 * 3_600_000);
  });
});

describe("register and login", () => {
  it("creates an account and signs in on another phone with the same data", async () => {
    const r = await register();
    expect(r.statusCode).toBe(201);
    const first = r.json();
    expect(first.user).toMatchObject({ name: "Kage", phone: "+919876543210" });

    const second = await login("+91 98765 43210");
    expect(second.statusCode).toBe(200);
    expect(second.json().user.id).toBe(first.user.id);
    expect(second.json().token).not.toBe(first.token);

    const me = await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${second.json().token}` } });
    expect(me.json().user).toMatchObject({ id: first.user.id, phone: "+919876543210" });
    const [devices] = await sql`select count(*)::int as n from devices where user_id = ${first.user.id}`;
    expect(devices!.n).toBe(2);
  });

  it("refuses a number that already has an account", async () => {
    await register();
    expect((await register("+919876543210", "3907", "Someone")).json()).toEqual({ error: "phone_taken" });
  });

  it("validates the phone and PIN", async () => {
    expect((await register("12345")).json()).toEqual({ error: "invalid_phone" });
    expect((await register(undefined, "12345")).json()).toEqual({ error: "invalid_body" });
    expect((await register(undefined, "abcd")).statusCode).toBe(400);
    expect((await register(undefined, "1234")).json()).toEqual({ error: "weak_pin" });
  });

  it("answers the same for an unknown number and a wrong PIN, and never stores the PIN", async () => {
    await register();
    expect((await login("9123456789")).json()).toEqual({ error: "invalid_credentials" });
    expect((await login(undefined, "0000")).json()).toEqual({ error: "invalid_credentials" });
    const [u] = await sql`select pin_hash from users`;
    expect(u!.pin_hash).toMatch(/^scrypt\$/);
    expect(u!.pin_hash).not.toContain("4821");
  });

  it("locks the account after 5 wrong PINs, even for the right PIN", async () => {
    await register();
    for (let i = 0; i < 4; i++) expect((await login(undefined, "0000")).statusCode).toBe(401);
    const fifth = await login(undefined, "0000");
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ error: "locked", retry_after_s: 900 });
    expect((await login()).statusCode).toBe(429);

    // Once the lock has passed, the right PIN works and the count resets.
    await sql`update users set pin_locked_until = now() - interval '1 second'`;
    expect((await login()).statusCode).toBe(200);
    expect((await sql`select pin_failures from users`)[0]!.pin_failures).toBe(0);
  });
});

describe("signed-in PIN actions", () => {
  it("verifies the PIN for the lock screen", async () => {
    const { token } = (await register()).json();
    expect((await post("/v1/auth/verify-pin", { pin: "4821" }, token)).json()).toEqual({ ok: true });
    expect((await post("/v1/auth/verify-pin", { pin: "1111" }, token)).statusCode).toBe(401);
    expect((await post("/v1/auth/verify-pin", { pin: "4821" })).statusCode).toBe(401); // no token
  });

  it("changes the PIN only with the current one", async () => {
    const { token } = (await register()).json();
    expect((await post("/v1/auth/pin", { current_pin: "0000", new_pin: "3907" }, token)).statusCode).toBe(401);
    expect((await post("/v1/auth/pin", { current_pin: "4821", new_pin: "5555" }, token)).json()).toEqual({ error: "weak_pin" });
    expect((await post("/v1/auth/pin", { current_pin: "4821", new_pin: "3907" }, token)).statusCode).toBe(204);
    expect((await login(undefined, "4821")).statusCode).toBe(401);
    expect((await login(undefined, "3907")).statusCode).toBe(200);
  });

  it("signing out revokes only that phone", async () => {
    const a = (await register()).json().token;
    const b = (await login()).json().token;
    expect((await post("/v1/auth/logout", {}, a)).statusCode).toBe(204);
    expect((await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${a}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${b}` } })).statusCode).toBe(200);
  });
});
