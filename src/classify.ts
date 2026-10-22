// Decides a new transaction's category, display label and whether to ask the
// user about it. User payee rules win over the built-in keyword list.
import { builtinCategory, type Category } from "./categories.ts";

export interface PayeeRule {
  match_kind: "vpa" | "name";
  match_value: string;
  label: string | null;
  category: string | null;
  event_type: string | null;
}

export interface ClassifyInput {
  direction: "debit" | "credit";
  eventType: string;
  counterparty: string | null;
  vpa: string | null;
  fromLlm: boolean;
}

export type ReviewReason = "unknown_payee" | "uncategorized" | "llm_parsed";

export interface Classification {
  category: string | null;
  categorySource: "rule" | "builtin" | null;
  label: string | null;
  eventType: string;
  reviewReason: ReviewReason | null;
}

/** Lookup keys for payee rules: the UPI ID, and the merchant name without trailing terminal/order digits. */
export function payeeKeys(counterparty: string | null, vpa: string | null): { vpa: string | null; name: string | null } {
  const name = counterparty
    ?.toLowerCase()
    .replace(/^\*+/, "")
    .replace(/\s+/g, " ")
    .replace(/\d{4,}$/, "")
    .trim();
  return { vpa: vpa?.trim().toLowerCase() || null, name: name || null };
}

export function findRule(rules: PayeeRule[], counterparty: string | null, vpa: string | null): PayeeRule | null {
  const keys = payeeKeys(counterparty, vpa);
  return (
    (keys.vpa && rules.find((r) => r.match_kind === "vpa" && r.match_value === keys.vpa)) ||
    (keys.name && rules.find((r) => r.match_kind === "name" && r.match_value === keys.name)) ||
    null
  );
}

// Settlements and cash movements aren't spending, so there is nothing to categorise.
const NOT_SPENDING = new Set(["card_payment", "cash_withdrawal", "transfer", "refund"]);

/** True when we only have a UPI ID or phone number, not a name a person would recognise. */
function isAnonymous(counterparty: string | null, vpa: string | null): boolean {
  if (!counterparty) return true;
  const c = counterparty.trim().toLowerCase();
  return c.includes("@") || c === vpa?.toLowerCase() || /^\+?\d[\d\s-]{6,}$/.test(c);
}

export function classify(t: ClassifyInput, rules: PayeeRule[]): Classification {
  const rule = findRule(rules, t.counterparty, t.vpa);
  if (rule) {
    return {
      category: rule.category,
      categorySource: rule.category ? "rule" : null,
      label: rule.label,
      eventType: rule.event_type ?? t.eventType,
      reviewReason: null,
    };
  }

  const base = { label: null, eventType: t.eventType };
  if (NOT_SPENDING.has(t.eventType)) {
    return { ...base, category: null, categorySource: null, reviewReason: t.fromLlm ? "llm_parsed" : null };
  }

  const builtin: Category | null = builtinCategory(t.counterparty, t.vpa);
  if (t.direction === "credit") {
    return {
      ...base,
      category: builtin === "investments" ? builtin : "income",
      categorySource: "builtin",
      reviewReason: t.fromLlm ? "llm_parsed" : null,
    };
  }

  if (builtin) return { ...base, category: builtin, categorySource: "builtin", reviewReason: t.fromLlm ? "llm_parsed" : null };
  return {
    ...base,
    category: null,
    categorySource: null,
    reviewReason: isAnonymous(t.counterparty, t.vpa) ? "unknown_payee" : t.fromLlm ? "llm_parsed" : "uncategorized",
  };
}
