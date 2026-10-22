// Phone + PIN accounts. A 4-digit PIN has only 10,000 values, so the hash is
// slow (scrypt) and every account locks after a few wrong tries, for longer
// each time. Phone numbers are not verified; they only name the account.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Sql } from "./db.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const PIN_RE = /^\d{4}$/;
export const MAX_PIN_FAILURES = 5;
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 3_600_000;

/**
 * Normalises to E.164. Bare 10-digit numbers are Indian mobiles (+91);
 * anything else must carry its country code. Returns null if it can't be a phone number.
 */
export function normalizePhone(input: string): string | null {
  const s = input.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0") && /^[6-9]/.test(digits.slice(1))) return `+91${digits.slice(1)}`;
  return null;
}

// The PINs people pick most. Refusing them is what makes guessing one PIN
// across many phone numbers (spraying) unproductive.
const COMMON_PINS = new Set(["1212", "1122", "1313", "2121", "1004", "2000", "2001", "1010", "6969", "4321", "1984", "2580", "0852", "1999", "1998"]);

/** Same digit four times, straight runs (1234, 9876, 0123), years 1950–2030 and other very common choices. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{3}$/.test(pin) || COMMON_PINS.has(pin)) return true;
  const d = [...pin].map(Number);
  const steps = new Set(d.slice(1).map((x, i) => x - d[i]!));
  if (steps.size === 1 && (steps.has(1) || steps.has(-1))) return true;
  const year = Number(pin);
  return year >= 1950 && year <= 2030;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const DUMMY_SALT = randomBytes(16).toString("base64");
const DUMMY_HASH = randomBytes(32).toString("base64");

export async function pinMatches(pin: string, stored: string | null): Promise<boolean> {
  // Unknown accounts still pay for a hash so response time doesn't reveal which numbers exist.
  const [, saltB64, hashB64] = stored?.split("$") ?? ["", DUMMY_SALT, DUMMY_HASH];
  const expected = Buffer.from(hashB64!, "base64");
  const actual = await scryptAsync(pin, Buffer.from(saltB64!, "base64"), 32);
  return !!stored && expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 15 min after the 5th wrong PIN, doubling every further 5, capped at a day. */
export function lockMs(failures: number): number {
  if (failures < MAX_PIN_FAILURES || failures % MAX_PIN_FAILURES !== 0) return 0;
  return Math.min(BASE_LOCK_MS * 2 ** (failures / MAX_PIN_FAILURES - 1), MAX_LOCK_MS);
}

export type PinCheck = { ok: true } | { ok: false; reason: "wrong_pin" | "locked"; retryAfterS?: number };

/** Checks a user's PIN and updates their failure count and lock in one place. */
export async function checkPin(sql: Sql, userId: string, pin: string, now = new Date()): Promise<PinCheck> {
  const [u] = await sql`select pin_hash, pin_failures, pin_locked_until from users where id = ${userId}`;
  if (!u?.pin_hash) {
    await pinMatches(pin, null);
    return { ok: false, reason: "wrong_pin" };
  }
  const lockedUntil: Date | null = u.pin_locked_until;
  if (lockedUntil && lockedUntil > now) {
    return { ok: false, reason: "locked", retryAfterS: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) };
  }
  if (await pinMatches(pin, u.pin_hash)) {
    if (u.pin_failures) await sql`update users set pin_failures = 0, pin_locked_until = null where id = ${userId}`;
    return { ok: true };
  }
  // Incremented in the database so parallel guesses can't share one count.
  const [{ pin_failures: failures }] = (await sql`
    update users set pin_failures = pin_failures + 1 where id = ${userId} returning pin_failures`) as unknown as [{ pin_failures: number }];
  const lock = lockMs(failures);
  if (lock) await sql`update users set pin_locked_until = ${new Date(now.getTime() + lock)} where id = ${userId}`;
  return lock ? { ok: false, reason: "locked", retryAfterS: Math.ceil(lock / 1000) } : { ok: false, reason: "wrong_pin" };
}
