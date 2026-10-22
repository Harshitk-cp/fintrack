// Reading a mailbox. Everything here is read-only: INBOX is opened with
// EXAMINE, so nothing is marked as read, moved or deleted.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ImapFlow } from "imapflow";
import { isBankSender } from "./filter.ts";

export interface MailCredentials {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface MailCursor {
  uidValidity: bigint | null;
  lastUid: number;
}

export interface FetchedMail {
  uid: number;
  source: Buffer;
}

export interface MailBatch {
  uidValidity: bigint;
  /** Highest UID looked at, bank mail or not; the next run starts after it. */
  lastUid: number;
  /** Raw messages from bank senders only. */
  messages: FetchedMail[];
}

export class MailAuthError extends Error {}
/** The server name resolves to an address the server must never connect to. */
export class MailHostError extends Error {}

// Users can type any mail server, so the VPS must not be steered at itself, its
// private network or the cloud metadata service (169.254.169.254).
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) BLOCKED.addSubnet(net, bits, "ipv6");

function isPublic(address: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (v4mapped) return !BLOCKED.check(v4mapped, "ipv4");
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  return !BLOCKED.check(address, family);
}

/**
 * Resolves a mail server name to one public address. Every address it resolves
 * to must be public, so a name can't mix a public and a private record.
 */
export async function resolvePublicHost(host: string): Promise<string> {
  const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!records.length) throw new MailHostError("mail server name does not resolve");
  if (!records.every((r) => isPublic(r.address))) throw new MailHostError("mail server address is not public");
  return records[0]!.address;
}

export interface MailSource {
  /** Logs in and out, to check credentials before saving them. */
  verify(creds: MailCredentials): Promise<void>;
  /** Bank emails newer than the cursor; the first run looks back `firstRunDays`. */
  fetchNew(creds: MailCredentials, cursor: MailCursor, firstRunDays: number): Promise<MailBatch>;
}

const MAX_PER_RUN = 300;

export class ImapMailSource implements MailSource {
  #allowPrivateHosts: boolean;

  /** Pass `allowPrivateHosts` only for local testing against a mail server on this machine. */
  constructor(options: { allowPrivateHosts?: boolean } = {}) {
    this.#allowPrivateHosts = options.allowPrivateHosts ?? false;
  }

  #client(c: MailCredentials, address: string) {
    // Connect to the vetted address (no second DNS lookup to rebind), verifying TLS for the real name.
    return new ImapFlow({
      host: address, servername: isIP(c.host) ? undefined : c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.pass },
      logger: false, disableAutoIdle: true, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000,
    });
  }

  async #connect(c: MailCredentials) {
    const address = this.#allowPrivateHosts ? c.host : await resolvePublicHost(c.host);
    const client = this.#client(c, address);
    try {
      await client.connect();
    } catch (err) {
      if ((err as { authenticationFailed?: boolean }).authenticationFailed) throw new MailAuthError("authentication failed");
      throw err;
    }
    return client;
  }

  async verify(creds: MailCredentials) {
    const client = await this.#connect(creds);
    await client.logout();
  }

  async fetchNew(creds: MailCredentials, cursor: MailCursor, firstRunDays: number): Promise<MailBatch> {
    const client = await this.#connect(creds);
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const box = client.mailbox;
        if (!box) throw new Error("INBOX not open");
        // A new UIDVALIDITY means the server renumbered the mailbox: start over by date.
        const fresh = cursor.uidValidity === null || cursor.uidValidity !== box.uidValidity;
        const found = fresh
          ? await client.search({ since: new Date(Date.now() - firstRunDays * 86_400_000) }, { uid: true })
          : await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
        // "N:*" always matches the newest message, even when it is older than N.
        const uids = (found || []).filter((u) => fresh || u > cursor.lastUid).sort((a, b) => a - b).slice(0, MAX_PER_RUN);
        const lastUid = uids.length ? uids.at(-1)! : fresh ? Math.max(0, box.uidNext - 1) : cursor.lastUid;
        if (!uids.length) return { uidValidity: box.uidValidity, lastUid, messages: [] };

        // Envelopes first, then full sources only for bank senders.
        const envelopes = await client.fetchAll(uids, { uid: true, envelope: true }, { uid: true });
        const bank = envelopes.filter((m) => isBankSender(m.envelope?.from?.[0]?.address ?? "")).map((m) => m.uid);
        const messages: FetchedMail[] = [];
        if (bank.length) {
          for await (const m of client.fetch(bank, { uid: true, source: true }, { uid: true })) {
            if (m.source) messages.push({ uid: m.uid, source: m.source });
          }
        }
        return { uidValidity: box.uidValidity, lastUid, messages };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}
