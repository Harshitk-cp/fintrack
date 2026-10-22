// LLM fallback for SMS the rule-based parser could not handle.
//
// The model only proposes fields; nothing it says is trusted unless it can be
// found in the original text. In particular the amount must be one that is
// literally written in the SMS, so a hallucinated amount can never reach the ledger.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { findDate } from "./sms/dates.ts";
import { allAmounts, BANKS, slugify, toMinor, type ParseResult, type ParsedTxn } from "./sms/parser.ts";

export const Extraction = z.object({
  is_completed_transaction: z.boolean(),
  not_transaction_reason: z.enum(["otp", "promotional", "reminder_or_due", "failed", "payment_request", "balance_or_info", "other"]).nullable(),
  bank_name: z.string().nullable(),
  direction: z.enum(["debit", "credit"]).nullable(),
  amount: z.string().nullable(),
  account_last4: z.string().nullable(),
  account_kind: z.enum(["bank_account", "credit_card", "debit_card", "unknown"]),
  channel: z.enum(["upi", "card", "bank_transfer", "atm", "unknown"]),
  counterparty: z.string().nullable(),
  vpa: z.string().nullable(),
  reference: z.string().nullable(),
  date_text: z.string().nullable(),
});
export type Extraction = z.infer<typeof Extraction>;

export const DEFAULT_LLM_MODEL = "claude-haiku-5-5";

export interface SmsExtractor {
  readonly name: string;
  extract(sender: string | null, body: string): Promise<Extraction>;
}

const SYSTEM = `You extract structured data from Indian bank and card SMS alerts.

Decide whether the message reports a completed money movement on the recipient's own account or card (a debit, spend, withdrawal, credit, refund or reversal). OTPs, promotions, payment reminders, statement/due notices, failed or declined transactions, collect requests, future autopay notices and balance-only messages are not completed transactions.

Copy values exactly as they appear in the message. Never compute, convert or guess:
- amount: the transaction amount as written, without currency symbol (e.g. "1,234.50"). Not the balance or limit.
- account_last4: the last 4 digits of the user's own account or card, if shown.
- reference: the UPI ref / RRN / UTR / transaction id, if shown.
- vpa: the counterparty UPI ID (e.g. name@okaxis), if shown.
- counterparty: the merchant or person paid (for debits) or the sender (for credits).
- date_text: the transaction date/time text as written.
- bank_name: the bank or card issuer that sent the alert.
Use null for anything not present.`;

export class ClaudeExtractor implements SmsExtractor {
  readonly name: string;
  #client: Anthropic;

  constructor(model: string, client = new Anthropic()) {
    this.name = model;
    this.#client = client;
  }

  async extract(sender: string | null, body: string): Promise<Extraction> {
    const res = await this.#client.messages.parse({
      model: this.name,
      max_tokens: 4096,
      output_config: { effort: "low", format: zodOutputFormat(Extraction) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Sender: ${sender ?? "unknown"}\n\nSMS:\n${body}` }],
    });
    if (res.stop_reason === "refusal") throw new Error("model refused");
    if (!res.parsed_output) throw new Error(`no structured output (stop_reason=${res.stop_reason})`);
    return res.parsed_output;
  }
}

const REASON_TO_IGNORE: Record<string, string> = {
  otp: "otp", promotional: "promotional", reminder_or_due: "statement_or_due_reminder", failed: "failed_transaction",
  payment_request: "payment_request", balance_or_info: "informational", other: "not_a_transaction",
};

/**
 * Turns a model extraction into a ParseResult, keeping only what is grounded
 * in the SMS text. Ungrounded optional fields are dropped; an ungrounded
 * amount or a missing direction makes the whole result unrecognized.
 */
export function groundExtraction(e: Extraction, body: string, received: Date, timeZone: string, model: string): ParseResult {
  const parser = `llm/${model}`;
  if (!e.is_completed_transaction) {
    return { kind: "ignored", parser, reason: REASON_TO_IGNORE[e.not_transaction_reason ?? "other"] ?? "not_a_transaction" };
  }

  const amountMinor = e.amount ? toMinor(e.amount.replace(/^(rs\.?|inr|₹)\s*/i, "").trim()) : null;
  if (amountMinor === null || amountMinor <= 0) return { kind: "unrecognized", parser, reason: "llm_no_amount" };
  if (!allAmounts(body).includes(amountMinor) && !containsNumber(body, amountMinor)) {
    return { kind: "unrecognized", parser, reason: "llm_amount_not_in_text" };
  }
  if (!e.direction) return { kind: "unrecognized", parser, reason: "llm_no_direction" };

  const lower = body.toLowerCase();
  const grounded = (v: string | null) => (v && lower.includes(v.toLowerCase()) ? v : null);
  const last4 = e.account_last4 && /^\d{4}$/.test(e.account_last4) && body.includes(e.account_last4) ? e.account_last4 : null;
  const date = e.date_text && body.includes(e.date_text) ? findDate(e.date_text, received, timeZone) : null;
  const bankName = grounded(e.bank_name);
  const known = bankName ? BANKS.find((b) => b.detect.test(bankName)) : undefined;

  const txn: ParsedTxn = {
    institution: known?.id ?? (bankName ? slugify(bankName.replace(/\s+bank$/i, "")) : "unknown"),
    institutionName: known?.name ?? bankName ?? "Unknown bank",
    accountKind: e.account_kind,
    last4,
    direction: e.direction,
    amountMinor,
    currency: "INR",
    eventType: "unknown",
    channel: e.channel,
    counterparty: grounded(e.counterparty),
    vpa: grounded(e.vpa),
    reference: grounded(e.reference),
    occurredAt: date?.at ?? null,
    timeKnown: date?.timeKnown ?? false,
    balanceMinor: null,
    confidence: 0.5,
  };
  return { kind: "transaction", parser, txn };
}

/**
 * Matches amounts written without a currency marker, e.g. "debited for 250.00".
 * Requires two decimals so card digits or reference numbers can't vouch for an amount.
 */
function containsNumber(body: string, minor: number): boolean {
  for (const m of body.matchAll(/\d[\d,]*\.\d{2}\b/g)) {
    if (toMinor(m[0]) === minor) return true;
  }
  return false;
}
