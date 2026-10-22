// Which mailbox server to use, which emails are bank alerts, and how to turn
// one into the short text the SMS parser understands.
import { simpleParser } from "mailparser";

const PROVIDERS: { domains: RegExp; host: string; port: number }[] = [
  { domains: /^(gmail|googlemail)\.com$/, host: "imap.gmail.com", port: 993 },
  { domains: /^(outlook|hotmail|live|msn)\.(com|in|co\.uk)$/, host: "outlook.office365.com", port: 993 },
  { domains: /^(yahoo|ymail|rocketmail)\.(com|in|co\.in)$/, host: "imap.mail.yahoo.com", port: 993 },
  { domains: /^(icloud|me|mac)\.com$/, host: "imap.mail.me.com", port: 993 },
  { domains: /^zoho(mail)?\.(com|in)$/, host: "imap.zoho.in", port: 993 },
  { domains: /^rediffmail\.com$/, host: "imap.rediffmail.com", port: 993 },
];

/** The IMAP server for a common provider, or null when the user has to give one. */
export function imapServerFor(address: string): { host: string; port: number } | null {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  const p = PROVIDERS.find((x) => x.domains.test(domain));
  return p ? { host: p.host, port: p.port } : null;
}

// Banks and card issuers that send alert emails. Indian banks are moving to
// RBI's ".bank.in" domains, which are accepted for any bank.
const BANK_DOMAINS = [
  "hdfcbank.net", "hdfcbank.com", "bankofbaroda.co.in", "bankofbaroda.com", "icicibank.com", "sbi.co.in", "onlinesbi.com",
  "axisbank.com", "kotak.com", "yesbank.in", "idfcfirstbank.com", "indusind.com", "pnb.co.in", "canarabank.com",
  "unionbankofindia.co.in", "federalbank.co.in", "aubank.in", "rblbank.com", "sc.com", "citi.com", "aexp.com",
  "bankofindia.co.in", "centralbankofindia.co.in", "iob.in", "ucobank.com", "dbs.com", "hsbc.co.in", "jupiter.money", "fi.money",
];

/** True when the From address belongs to a bank's domain (or any subdomain of one). */
export function isBankSender(from: string): boolean {
  const domain = from.trim().toLowerCase().split("@")[1]?.replace(/>$/, "") ?? "";
  if (!domain) return false;
  if (domain.endsWith(".bank.in")) return true;
  return BANK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// Subjects that name a money movement. Anything else from a bank (offers,
// newsletters, statements) is skipped without spending a parse or a model call.
const TXN_SUBJECT = /\b(debit(ed)?|credit(ed)?|spent|spend|transaction|txn|payment|paid|transfer(red)?|withdraw(n|al)|refund(ed)?|received|upi|alert|imps|neft|rtgs)\b/i;
const NOT_TXN_SUBJECT = /\b(offer|cashback offer|pre-?approved|loan|upgrade|webinar|newsletter|statement|e-?statement|reward points? summary|kyc|otp|one time password|password|login|update your|survey|festive|exclusive)\b/i;

export function looksLikeTransactionSubject(subject: string): boolean {
  return TXN_SUBJECT.test(subject) && !NOT_TXN_SUBJECT.test(subject);
}

// Footers that hold disclaimers ("never share your OTP…") the SMS parser would
// misread; the alert itself always comes before them.
const BOILERPLATE = /\b(never share|do not share|don't share|disclaimer|this is (a|an) (system|auto(matically)?)[ -]generated|please do not reply|for any (queries|query|assistance|clarification)|in case you have not|if you have not (done|authori[sz]ed)|to report|call our|customer care|warm regards|regards,|thank you for banking)\b/i;

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", rsquo: "'", lsquo: "'", rupee: "₹", "#8377": "₹" };

/** Rough HTML to text: enough for alert emails, which are mostly tables of short lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#\d+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m);
}

/** The alert part of an email body: boilerplate cut off, whitespace collapsed, capped in length. */
export function alertText(subject: string, body: string): string {
  const cut = body.search(BOILERPLATE);
  const main = (cut > 40 ? body.slice(0, cut) : body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1500);
  return `${subject.trim()}\n${main}`.trim();
}

const domainOf = (address: string) => address.trim().toLowerCase().split("@")[1]?.replace(/>$/, "") ?? "";
/** Same domain, or one is a subdomain of the other (relaxed DMARC alignment). */
const aligned = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * Whether the user's mail provider verified that the email really comes from
 * the From domain: DMARC passed, or a DKIM signature from that domain passed.
 * Only the topmost Authentication-Results header counts: the receiving provider
 * adds it, and anything below it could have been written by the sender.
 */
export function senderVerified(authResults: string | null, from: string): boolean {
  const domain = domainOf(from);
  if (!authResults || !domain) return false;
  const ar = authResults.toLowerCase();
  const dmarc = /\bdmarc=pass\b[^;]*?(?:header\.from=([a-z0-9.-]+))?/.exec(ar);
  if (dmarc && (!dmarc[1] || aligned(dmarc[1], domain))) return true;
  for (const m of ar.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)) {
    if (aligned(m[1]!, domain)) return true;
  }
  return false;
}

export interface ParsedEmail {
  from: string;
  subject: string;
  date: Date | null;
  messageId: string | null;
  text: string;
  /** The provider checked DKIM/DMARC for the From domain and it passed. */
  verified: boolean;
}

export async function parseEmail(source: Buffer): Promise<ParsedEmail> {
  const m = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = m.from?.value[0]?.address ?? "";
  const subject = m.subject ?? "";
  // Prefer the HTML: mailparser's generated plain text wraps at 80 columns, splitting
  // sentences like "to VPA⏎swiggy@icici" that the parser reads line by line.
  const body = m.html ? htmlToText(m.html) : (m.text ?? "");
  // headerLines keeps the original order; the first Authentication-Results is the provider's.
  const ar = m.headerLines.find((h) => h.key === "authentication-results")?.line.replace(/^authentication-results:\s*/i, "") ?? null;
  return { from, subject, date: m.date ?? null, messageId: m.messageId ?? null, text: alertText(subject, body), verified: senderVerified(ar, from) };
}
