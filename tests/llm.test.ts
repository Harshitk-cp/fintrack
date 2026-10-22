import { describe, expect, it } from "vitest";
import { groundExtraction, type Extraction } from "../src/llm.ts";

const TZ = "Asia/Kolkata";
const received = new Date("2026-10-21T15:00:00+05:30");
const BODY = "Paid INR 640.50 via Jupiter card ending 7788 at BLINKIT on 21/10/2026 14:05. Txn id 600000000020";

const base: Extraction = {
  is_completed_transaction: true, not_transaction_reason: null, bank_name: "Jupiter", direction: "debit",
  amount: "640.50", account_last4: "7788", account_kind: "debit_card", channel: "card", counterparty: "BLINKIT",
  vpa: null, reference: "600000000020", date_text: "21/10/2026 14:05",
};
const ground = (e: Partial<Extraction>, body = BODY) => groundExtraction({ ...base, ...e }, body, received, TZ, "test-model");

describe("groundExtraction", () => {
  it("accepts fields that appear in the text", () => {
    const r = ground({});
    expect(r).toMatchObject({ kind: "transaction", parser: "llm/test-model" });
    expect(r.kind === "transaction" && r.txn).toMatchObject({
      amountMinor: 64050, last4: "7788", reference: "600000000020", counterparty: "BLINKIT",
      institution: "jupiter", institutionName: "Jupiter", confidence: 0.5, timeKnown: true,
    });
  });

  it("rejects an amount that is not written in the SMS", () => {
    expect(ground({ amount: "6405.00" })).toMatchObject({ kind: "unrecognized", reason: "llm_amount_not_in_text" });
  });

  it("does not let card digits vouch for an amount", () => {
    expect(ground({ amount: "7788" })).toMatchObject({ kind: "unrecognized", reason: "llm_amount_not_in_text" });
  });

  it("accepts a currency-less amount with decimals", () => {
    const r = ground({ amount: "250.00" }, "Your a/c 7788 debited for 250.00 at BLINKIT");
    expect(r.kind === "transaction" && r.txn.amountMinor).toBe(25000);
  });

  it("drops ungrounded optional fields instead of trusting them", () => {
    const r = ground({ reference: "999999999999", account_last4: "1234", vpa: "made@up", counterparty: "AMAZON" });
    expect(r.kind === "transaction" && r.txn).toMatchObject({ reference: null, last4: null, vpa: null, counterparty: null });
  });

  it("maps known banks to their canonical id", () => {
    const r = ground({ bank_name: "HDFC Bank" }, `${BODY} - HDFC Bank`);
    expect(r.kind === "transaction" && r.txn).toMatchObject({ institution: "hdfc", institutionName: "HDFC Bank" });
  });

  it("needs a direction", () => {
    expect(ground({ direction: null })).toMatchObject({ kind: "unrecognized", reason: "llm_no_direction" });
  });

  it("non-transactions become ignored", () => {
    expect(ground({ is_completed_transaction: false, not_transaction_reason: "promotional" })).toMatchObject({ kind: "ignored", reason: "promotional" });
  });
});
