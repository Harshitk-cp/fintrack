// Turns bank transaction SMS text into structured evidence.
//
// Parsing is deliberately conservative: if the amount or direction cannot be
// determined, the message is reported as unrecognized rather than guessed.
import { findDate } from "./dates.ts";

export type Direction = "debit" | "credit";
export type AccountKind = "bank_account" | "credit_card" | "debit_card" | "unknown";
export type Channel = "upi" | "card" | "bank_transfer" | "atm" | "unknown";
export type EventType = "card_payment" | "refund" | "cash_withdrawal" | "unknown";

export interface ParsedTxn {
  institution: string; // stable slug, e.g. "hdfc"
  institutionName: string; // display name, e.g. "HDFC Bank"
  accountKind: AccountKind;
  last4: string | null;
  direction: Direction;
  amountMinor: number; // paise; always an integer
  currency: "INR";
  eventType: EventType;
  channel: Channel;
  counterparty: string | null;
  vpa: string | null;
  reference: string | null;
  occurredAt: Date | null;
  timeKnown: boolean; // false when the SMS only had a date
  balanceMinor: number | null;
  confidence: number;
}

export type ParseResult =
  | { kind: "transaction"; parser: string; txn: ParsedTxn }
  // financial-looking but not a completed transaction (OTP, due reminder, failed txn)
  | { kind: "ignored"; parser: string | null; reason: string }
  // unknown bank or format; kept for review so a parser can be added
  | { kind: "unrecognized"; parser: string | null; reason: string };

interface Bank {
  id: string;
  name: string;
  detect: RegExp; // matched against the sender ID, then the body with VPAs removed
  tuned?: boolean; // has fixtures from real messages; others use generic extraction
  accountKind?: (body: string) => AccountKind | null;
  direction?: (body: string) => Direction | null; // for formats without a debit/credit verb
}

// Order matters where names overlap (e.g. "State Bank of India" before "Bank of India").
// Sender IDs look like "AX-HDFCBK" or "VM-ICICIT-S"; codes vary, so names are matched too.
export const BANKS: Bank[] = [
  {
    id: "hdfc",
    name: "HDFC Bank",
    tuned: true,
    detect: /HDFC/i,
    // HDFC card alerts: "Spent ... On HDFC Bank Card" (credit) vs "From HDFC Bank Card" (debit).
    accountKind: (body) => {
      if (/\bon\s+HDFC\s+Bank\s+Card\b/i.test(body)) return "credit_card";
      if (/\bfrom\s+HDFC\s+Bank\s+Card\b/i.test(body)) return "debit_card";
      return null;
    },
    // RuPay credit card on UPI: "Txn Rs.357.44\nOn HDFC Bank Card 8204\nAt *payu@hd\nby UPI ..."
    direction: (body) => (/^\s*Txn\s+(rs\.?|inr)/i.test(body) ? "debit" : null),
  },
  { id: "bob", name: "Bank of Baroda", tuned: true, detect: /Bank of Baroda|\bBOB\b|-BOB|BOB[A-Z]{2,}/i },
  { id: "sbi", name: "State Bank of India", detect: /State Bank of India|\bSBI\b|SBIINB|SBIPSG|ATMSBI|CBSSBI|SBICRD/i },
  { id: "icici", name: "ICICI Bank", detect: /ICICI/i },
  { id: "axis", name: "Axis Bank", detect: /\bAxis\s*Bank\b|AXISBK/i },
  { id: "kotak", name: "Kotak Mahindra Bank", detect: /\bKotak\b|KOTAKB/i },
  { id: "yes", name: "Yes Bank", detect: /\bYes\s*Bank\b|YESBNK/i },
  { id: "idfc", name: "IDFC FIRST Bank", detect: /IDFC\s*FIRST|IDFCFB/i },
  { id: "indusind", name: "IndusInd Bank", detect: /IndusInd|INDUSB/i },
  { id: "pnb", name: "Punjab National Bank", detect: /Punjab National Bank|\bPNB\b|PNBSMS/i },
  { id: "canara", name: "Canara Bank", detect: /Canara\s*Bank|CANBNK/i },
  { id: "union", name: "Union Bank of India", detect: /Union Bank of India|UNIONB/i },
  { id: "central", name: "Central Bank of India", detect: /Central Bank of India/i },
  { id: "boi", name: "Bank of India", detect: /Bank of India|BOIIND/i },
  { id: "indian", name: "Indian Bank", detect: /\bIndian Bank\b|INDBNK/i },
  { id: "federal", name: "Federal Bank", detect: /Federal\s*Bank|FEDBNK/i },
  { id: "idbi", name: "IDBI Bank", detect: /\bIDBI\b/i },
  { id: "rbl", name: "RBL Bank", detect: /\bRBL\b/i },
  { id: "au", name: "AU Small Finance Bank", detect: /\bAU\s+(Small Finance\s+)?Bank\b|AUBANK/i },
  { id: "sc", name: "Standard Chartered", detect: /Standard Chartered|SCBANK/i },
  { id: "hsbc", name: "HSBC", detect: /HSBC/i },
  { id: "amex", name: "American Express", detect: /American Express|\bAmex\b/i },
];

type DetectedBank = Omit<Bank, "detect">;

// Last resort for banks not listed above: "<Name> Bank" written in the message.
const UNLISTED_BANK = /\b([A-Z][A-Za-z]*(?:-[A-Za-z]+)*(?:\s+[A-Z][A-Za-z]*(?:-[A-Za-z]+)*){0,2})\s+(?:Bank|BANK)\b/;
const NOT_BANK_NAME = /^(your|the|dear|not|call|via|to|from|by|at|any|our)\b/i;

/** Identifies the institution. VPAs are removed first so "x@hdfcbank" doesn't make a BoB message look like HDFC. */
export function detectBank(sender: string | null, text: string): DetectedBank | null {
  if (sender) {
    const bySender = BANKS.find((b) => b.detect.test(sender));
    if (bySender) return bySender;
  }
  const body = text.replace(new RegExp(VPA.source, "gi"), " ");
  const known = BANKS.find((b) => b.detect.test(body));
  if (known) return known;
  const m = UNLISTED_BANK.exec(body);
  if (!m || NOT_BANK_NAME.test(m[1]!)) return null;
  const name = `${m[1]} Bank`;
  return { id: slugify(m[1]!), name };
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const OTP = /\b(otp|one[\s-]?time[\s-]?password|verification code|passcode)\b/i;

// TRAI sender headers end in -P for promotional, -S service, -T transactional, -G government.
const PROMO_SENDER = /-P$/i;
// Bank marketing sent from service headers: EMI conversion, loan and card offers.
const PROMO = /\bt&c\b|\bconvert\b.*\b(smart\s*)?emi\b|\bpre[\s-]?approved\b|\bapply now\b|\binterest rates? (starts?|from|as low)\b|\blimited[\s-]period\b|\b(loan|card) offer\b/i;

const IGNORE: { re: RegExp; reason: string }[] = [
  { re: /\b(failed|declined|unsuccessful|could not be processed)\b/i, reason: "failed_transaction" },
  { re: /\bwill be (auto[\s-]?)?debited\b|\bpre[\s-]?debit\b|\bupcoming\b/i, reason: "future_debit_notice" },
  { re: /\b(minimum|total) (amount )?due\b|\bis due\b|\bdue (date|on)\b|\bstatement\b/i, reason: "statement_or_due_reminder" },
  { re: /\b(has )?requested (money|rs|inr)|\bcollect request\b/i, reason: "payment_request" },
  { re: /\bmandate\b.*\b(created|registered|set up|revoked)\b/i, reason: "mandate_notice" },
];

const AMOUNT = /(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
const BALANCE = /(?:avl\.?\s*bal(?:ance)?|avlbal|available\s+bal(?:ance)?|total\s+bal|\bbal)[\s:.-]*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const LAST4 = /(?:a\/c|acct|account|card)(?:\s+(?:no\.?|number|ending(?:\s+with)?))?[\s:.]*[x*#]*\s*\d*?(\d{4})\b/i;
// Also the email phrasing "UPI transaction reference number is 629512340101".
const REF = /\b(?:ref(?:erence)?|rrn|upi|txn|transaction)\b(?:\s*(?:ref(?:erence)?|no|id|number)\.?)*(?:\s+is)?[\s:.#/-]*([0-9]{6,})/i;
// NEFT/RTGS UTRs are alphanumeric, e.g. "UTR IN12628259448363".
const UTR = /\butr\b(?:\s*(?:no|number)\.?)?[\s:.#/-]*([a-z0-9]{10,22})\b/i;
// A VPA handle has no dot-separated TLD, which is how it differs from an email address.
const VPA = /[a-z0-9][a-z0-9.\-_]+@[a-z][a-z0-9]+(?!\.?[a-z])/i;

// "for using your … card for Rs" (HDFC card emails) and "has been used for INR" (ICICI) are spends too.
const DEBIT_WORD = /\b(sent|spent|debited|dr\.?|withdrawn|paid|purchase|money sent|for using your|used for)\b/i;
const CREDIT_WORD = /\b(credited|received|cr\.?|deposited|refund(?:ed)?|reversed|credit alert)\b/i;

const CP_END = String.raw`(?:\s+on\b|\s*\n|\.\s|\.$|\s+ref\b|\s*\(|\s+avl|\s+info\b|\s+via\b|\s+(?:credited|debited)\b|$)`;
const COUNTERPARTY_DEBIT = new RegExp(String.raw`\b(?:to|at|towards)\s+(?:vpa\s+)?(.+?)` + CP_END, "gi");
const COUNTERPARTY_CREDIT = new RegExp(String.raw`\b(?:from|by)\s+(?:vpa\s+)?(.+?)` + CP_END, "gi");
// Bank names/accounts, and bare phone numbers (helplines like "SMS BLOCK 789 to 9215676766").
const NOT_COUNTERPARTY = /\b(a\/c|acct|account|card|bank|your)\b|^x+\d+|^\+?\d[\d\s-]{6,}$/i;
// Sentence fragments, not names: "We wish to inform you that Rs. 3283 …" must not make "inform you that Rs" a payee,
// and "… on 12 Oct at 06:13:10" must not make a time one.
const PROSE = /\b(you|we|that|this|inform|informed|wish|has|have|been|is|are|was|our|please|kindly)\b|(?:^|\s)(rs\.?|inr|₹)(?:\s|$)|^[\d:.\s/-]+$/i;

/** True when a stored payee name is really a parsing mistake (used to repair old rows). */
export function looksLikeProse(name: string): boolean {
  return PROSE.test(name);
}

/** Lets the API refuse authentication messages before anything is stored. */
export function looksLikeOtp(body: string): boolean {
  return OTP.test(body);
}

/**
 * Classify and extract a bank SMS. `received` is when the device got the
 * message; it anchors dates without a time and acts as a fallback.
 */
export function parseSms(sender: string | null, body: string, received: Date, timeZone: string): ParseResult {
  const text = body.trim();
  if (OTP.test(text)) return { kind: "ignored", parser: null, reason: "otp" };
  if ((sender && PROMO_SENDER.test(sender.trim())) || PROMO.test(text)) return { kind: "ignored", parser: null, reason: "promotional" };

  const bank = detectBank(sender, text);
  if (!bank) return { kind: "unrecognized", parser: null, reason: "unknown_institution" };
  const parser = bank.tuned ? `${bank.id}/v1` : "generic/v1";

  for (const ig of IGNORE) {
    if (ig.re.test(text)) return { kind: "ignored", parser, reason: ig.reason };
  }

  const amountMinor = firstAmount(text);
  if (amountMinor === null) return { kind: "unrecognized", parser, reason: "no_amount" };
  const direction = bank.direction?.(text) ?? detectDirection(text);
  if (!direction) return { kind: "unrecognized", parser, reason: "no_direction" };

  let confidence = bank.tuned ? 0.6 : 0.5;
  const last4 = LAST4.exec(text)?.[1] ?? null;
  if (last4) confidence += 0.15;
  const reference = REF.exec(text)?.[1] ?? UTR.exec(text)?.[1]?.toUpperCase() ?? null;
  if (reference) confidence += 0.15;
  const vpa = VPA.exec(text)?.[0] ?? null;
  const balance = BALANCE.exec(text)?.[1];
  const date = findDate(text, received, timeZone);
  if (date) confidence += 0.05;

  const accountKind = detectAccountKind(bank, text);
  const channel = detectChannel(text, vpa, accountKind);
  const txn: ParsedTxn = {
    institution: bank.id,
    institutionName: bank.name,
    accountKind,
    last4,
    direction,
    amountMinor,
    currency: "INR",
    channel,
    eventType: detectEventType(text, direction, accountKind, channel),
    counterparty: findCounterparty(text, direction) ?? vpa,
    vpa,
    reference,
    occurredAt: date?.at ?? null,
    timeKnown: date?.timeKnown ?? false,
    balanceMinor: balance ? toMinor(balance) : null,
    confidence: Math.min(confidence, 0.95),
  };
  return { kind: "transaction", parser, txn };
}

/** Every currency amount written in the message, in paise. */
export function allAmounts(text: string): number[] {
  return [...text.matchAll(AMOUNT)].map((m) => toMinor(m[1]!)).filter((v): v is number => v !== null);
}

function firstAmount(text: string): number | null {
  for (const m of text.matchAll(AMOUNT)) {
    const prefix = text.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
    if (prefix.includes("bal") || prefix.includes("limit")) continue;
    const v = toMinor(m[1]!);
    if (v !== null && v > 0) return v;
  }
  return null;
}

/** Converts "1,234.5" to 123450 paise without floating point. */
export function toMinor(s: string): number | null {
  const [whole = "", frac = ""] = s.replaceAll(",", "").split(".");
  if (!/^\d+$/.test(whole) || frac.length > 2 || !/^\d*$/.test(frac)) return null;
  const v = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(v) ? v : null;
}

/**
 * Uses whichever debit/credit keyword appears first, because messages like
 * BoB's "Rs.X Dr. from A/C .. and Cr. to vpa" contain both.
 */
function detectDirection(text: string): Direction | null {
  const d = DEBIT_WORD.exec(text)?.index;
  const c = CREDIT_WORD.exec(text)?.index;
  if (d === undefined && c === undefined) return null;
  if (c === undefined) return "debit";
  if (d === undefined) return "credit";
  return d < c ? "debit" : "credit";
}

function detectAccountKind(bank: DetectedBank, text: string): AccountKind {
  const hint = bank.accountKind?.(text);
  if (hint) return hint;
  if (/credit card/i.test(text)) return "credit_card";
  if (/debit card/i.test(text)) return "debit_card";
  if (/\b(a\/c|acct|account)\b/i.test(text)) return "bank_account";
  return "unknown";
}

function findCounterparty(text: string, direction: Direction): string | null {
  const re = direction === "credit" ? COUNTERPARTY_CREDIT : COUNTERPARTY_DEBIT;
  for (const m of text.matchAll(re)) {
    let c = m[1]!.trim().replace(/\.+$/, "").trim();
    // "to VPA swiggy@icici SWIGGY": the UPI ID is kept separately, so the payee is the name after it.
    const named = /^\S+@\S+\s+(.+)$/.exec(c);
    if (named) c = named[1]!.trim();
    if (c && c.length <= 80 && !NOT_COUNTERPARTY.test(c) && !PROSE.test(c)) return c;
  }
  return null;
}

function detectChannel(text: string, vpa: string | null, kind: AccountKind): Channel {
  if (vpa || /upi/i.test(text)) return "upi";
  if (/\batm\b/i.test(text)) return "atm";
  if (/\b(neft|imps|rtgs)\b/i.test(text)) return "bank_transfer";
  if (kind === "credit_card" || kind === "debit_card" || /card/i.test(text)) return "card";
  return "unknown";
}

/**
 * Only labels cases that are unambiguous from the SMS alone; purchase vs
 * transfer is decided later during categorization.
 */
function detectEventType(text: string, direction: Direction, kind: AccountKind, channel: Channel): EventType {
  if (direction === "credit" && kind === "credit_card" && /payment|received towards/i.test(text)) return "card_payment";
  if (direction === "credit" && /\b(refund(ed)?|revers(ed|al))\b/i.test(text)) return "refund";
  if (direction === "debit" && channel === "atm") return "cash_withdrawal";
  return "unknown";
}
