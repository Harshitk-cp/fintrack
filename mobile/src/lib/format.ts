import type { Transaction } from "./api";

export const TZ = "Asia/Kolkata";

/** The user's label, else the merchant/person from the SMS, else the UPI ID. */
export function payeeName(t: Pick<Transaction, "label" | "counterparty" | "counterparty_vpa" | "direction">): string {
  if (t.label) return t.label;
  const name = t.counterparty?.replace(/^\*+/, "").trim();
  if (name) return name;
  if (t.counterparty_vpa) return t.counterparty_vpa;
  return t.direction === "credit" ? "Money received" : "Payment";
}

export function kindLabel(t: Pick<Transaction, "event_type" | "channel" | "source">): string | null {
  switch (t.event_type) {
    case "refund": return "Refund";
    case "card_payment": return "Card bill paid";
    case "cash_withdrawal": return "ATM";
    case "transfer": return "Own transfer";
  }
  if (t.source === "manual") return "Added by you";
  return t.channel === "upi" ? "UPI" : t.channel === "card" ? "Card" : t.channel === "bank_transfer" ? "Transfer" : null;
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ });

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: TZ });

export const REVIEW_PROMPT: Record<string, string> = {
  unknown_payee: "Who was this paid to?",
  uncategorized: "What was this for?",
  llm_parsed: "Read by AI from an unfamiliar SMS. Is it right?",
};
