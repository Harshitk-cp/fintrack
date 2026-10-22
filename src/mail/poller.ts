import type { FastifyBaseLogger } from "fastify";
import type { Sealer } from "../crypto.ts";
import type { Sql } from "../db.ts";
import { ingestEmail } from "../ingest.ts";
import { looksLikeTransactionSubject, parseEmail } from "./filter.ts";
import { MailAuthError, MailHostError, type MailSource } from "./source.ts";

const FIRST_RUN_DAYS = 30;
const INTERVAL_MS = 5 * 60_000;

export interface MailSyncResult {
  checked: number;
  bankEmails: number;
  transactions: number;
  /** Bank-looking mail skipped because the sender wasn't authenticated (possible forgery). */
  unverified: number;
}

export interface MailHooks {
  onUnrecognized?: () => void; // wakes the LLM fallback
  onTransaction?: () => void; // wakes the notifier
}

/**
 * Reads one user's mailbox from where the last run stopped and ingests its
 * bank alert emails. Saves the cursor and status whatever happens.
 */
export async function syncMailbox(sql: Sql, sealer: Sealer, timeZone: string, source: MailSource, accountId: string, hooks: MailHooks = {}): Promise<MailSyncResult> {
  const [acc] = await sql`
    select id, user_id, address, host, port, password_enc, uid_validity, last_uid from mail_accounts where id = ${accountId}`;
  if (!acc) return { checked: 0, bankEmails: 0, transactions: 0, unverified: 0 };

  const creds = { host: acc.host, port: acc.port, user: acc.address, pass: sealer.open(acc.password_enc) };
  try {
    const batch = await source.fetchNew(creds, { uidValidity: acc.uid_validity === null ? null : BigInt(acc.uid_validity), lastUid: Number(acc.last_uid) }, FIRST_RUN_DAYS);
    let bankEmails = 0;
    let transactions = 0;
    let unrecognized = false;
    let unverified = 0;
    for (const m of batch.messages) {
      const email = await parseEmail(m.source);
      if (!looksLikeTransactionSubject(email.subject)) continue;
      // Anyone can put a bank's address in From; only mail the provider authenticated is trusted.
      if (!email.verified) {
        unverified++;
        continue;
      }
      bankEmails++;
      const r = await ingestEmail(sql, sealer, timeZone, {
        userId: acc.user_id, from: email.from, text: email.text, receivedAt: email.date ?? new Date(), messageId: email.messageId,
      });
      if (r.duplicate) continue;
      if (r.transactionId) transactions++;
      if (r.status === "unrecognized") unrecognized = true;
    }
    await sql`
      update mail_accounts set uid_validity = ${batch.uidValidity.toString()}, last_uid = ${batch.lastUid},
        status = 'ok', last_error = null, last_checked_at = now(), emails_found = emails_found + ${bankEmails}
      where id = ${accountId}`;
    if (unrecognized) hooks.onUnrecognized?.();
    if (transactions) hooks.onTransaction?.();
    return { checked: batch.messages.length, bankEmails, transactions, unverified };
  } catch (err) {
    const auth = err instanceof MailAuthError;
    // The app sees a generic reason; the raw error (which can describe the network) stays in the server log.
    const shown = auth ? "authentication failed" : err instanceof MailHostError ? "mail server address not allowed" : "could not read the mailbox";
    await sql`
      update mail_accounts set status = ${auth ? "auth_failed" : "error"}, last_error = ${shown}, last_checked_at = now()
      where id = ${accountId}`;
    throw err;
  }
}

/**
 * Syncs every connected mailbox every few minutes. `kick()` syncs one account
 * now (after connecting, or "Check now"). Mailboxes whose password stopped
 * working are skipped until the user reconnects.
 */
export class MailPoller {
  #sql: Sql;
  #sealer: Sealer;
  #tz: string;
  #source: MailSource;
  #hooks: MailHooks;
  #log: FastifyBaseLogger | null = null;
  #busy = new Set<string>();
  #interval = INTERVAL_MS;

  constructor(sql: Sql, sealer: Sealer, timeZone: string, source: MailSource, hooks: MailHooks = {}) {
    this.#sql = sql;
    this.#sealer = sealer;
    this.#tz = timeZone;
    this.#source = source;
    this.#hooks = hooks;
  }

  setLogger(log: FastifyBaseLogger) {
    this.#log = log;
  }

  start(intervalMs = INTERVAL_MS) {
    this.#interval = intervalMs;
    setInterval(() => void this.syncDue(), 60_000).unref();
    void this.syncDue();
  }

  /** Syncs one account now, unless it is already syncing. */
  kick(accountId: string) {
    void this.#sync(accountId);
  }

  async syncDue() {
    const due = await this.#sql`
      select id from mail_accounts
      where status <> 'auth_failed'
        and (last_checked_at is null or last_checked_at < now() - ${`${Math.round(this.#interval / 1000)} seconds`}::interval)`;
    for (const a of due) await this.#sync(a.id);
  }

  async #sync(accountId: string) {
    if (this.#busy.has(accountId)) return;
    this.#busy.add(accountId);
    try {
      const r = await syncMailbox(this.#sql, this.#sealer, this.#tz, this.#source, accountId, this.#hooks);
      if (r.bankEmails || r.unverified) this.#log?.info({ accountId, ...r }, "mail sync");
    } catch (err) {
      this.#log?.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, "mail sync failed");
    } finally {
      this.#busy.delete(accountId);
    }
  }
}
