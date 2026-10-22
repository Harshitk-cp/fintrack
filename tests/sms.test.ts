// Fixtures are SYNTHETIC approximations of BoB/HDFC formats. Replace or extend
// them with real (masked) messages; `pnpm fintrack parse` helps check one.
import { describe, expect, it } from "vitest";
import { parseSms, toMinor, type ParsedTxn } from "../src/sms/parser.ts";

const TZ = "Asia/Kolkata";
const received = new Date("2026-10-21T15:00:00+05:30");

function txn(body: string, sender: string | null = null): ParsedTxn {
  const r = parseSms(sender, body, received, TZ);
  if (r.kind !== "transaction") throw new Error(`expected transaction, got ${r.kind}: ${r.reason}`);
  return r.txn;
}

// Real message formats, with names, phone-number VPAs, refs and digits masked.
describe("real formats", () => {
  it("BoB UPI debit to a phone-number VPA", () => {
    const t = txn("Rs.270.00 Dr. from A/C XXXXXX1111 and Cr. to 9800000000@ibl. Ref:600000000001. AvlBal:Rs38282.43(2026:10:21 08:46:19). Not you? Call 18005700/5000-BOB");
    expect(t).toMatchObject({
      institution: "bob", direction: "debit", amountMinor: 27000, last4: "1111", accountKind: "bank_account",
      channel: "upi", vpa: "9800000000@ibl", reference: "600000000001", balanceMinor: 3828243, timeKnown: true,
    });
    expect(t.occurredAt?.toISOString()).toBe("2026-10-21T03:16:19.000Z");
  });

  it("BoB UPI debit to a merchant VPA with dots and digits", () => {
    const t = txn("Rs.1586.00 Dr. from A/C XXXXXX1111 and Cr. to paperandpie.12345678@hdfcbank. Ref:600000000002. AvlBal:Rs39496.32(2026:10:20 05:17:40). Not you? Call 18005700/5000-BOB");
    expect(t).toMatchObject({ amountMinor: 158600, vpa: "paperandpie.12345678@hdfcbank", counterparty: "paperandpie.12345678@hdfcbank" });
  });

  it("HDFC RuPay credit card on UPI (multiline, verb-less, yearless date)", () => {
    const t = txn("Txn Rs.357.44\nOn HDFC Bank Card 2222\nAt *payu@hd \nby UPI 600000000003\nOn 14-10\nNot You?\nCall 18002586161/SMS BLOCK CC 2222 to 7308080808");
    expect(t).toMatchObject({
      institution: "hdfc", direction: "debit", amountMinor: 35744, last4: "2222", accountKind: "credit_card",
      channel: "upi", counterparty: "*payu@hd", reference: "600000000003", timeKnown: false,
    });
    expect(t.occurredAt?.toISOString()).toBe("2026-10-14T06:30:00.000Z"); // noon IST
  });

  it("HDFC credit card spend", () => {
    const t = txn("Spent Rs.3451 On HDFC Bank Card 3333 At SWIGGYI14242463 On 2026-10-11:21:30:13.Not You? To Block+Reissue Call 18002586161/SMS BLOCK CC 3333 to 7308080808");
    expect(t).toMatchObject({ amountMinor: 345100, last4: "3333", accountKind: "credit_card", channel: "card", counterparty: "SWIGGYI14242463", reference: null });
    expect(t.occurredAt?.toISOString()).toBe("2026-10-11T16:00:13.000Z");
  });

  it("BoB NEFT credit with alphanumeric UTR", () => {
    const t = txn("Rs.12500 Credited to A/c ...1111 thru NEFT UTR IN12345678901234 by A PERSON. Total Bal:Rs.18120.54CR. Avlbl Amt:Rs.18120.54(09-10-2026 21:05:25) - Bank of Baroda");
    expect(t).toMatchObject({
      direction: "credit", amountMinor: 1250000, last4: "1111", channel: "bank_transfer",
      counterparty: "A PERSON", reference: "IN12345678901234", balanceMinor: 1812054,
    });
  });

  it("yearless date in early January resolves to the previous year", () => {
    const r = parseSms(null, "Txn Rs.10\nOn HDFC Bank Card 2222\nAt X\nby UPI 600000000009\nOn 31-12", new Date("2026-01-02T10:00:00+05:30"), TZ);
    expect(r.kind === "transaction" && r.txn.occurredAt?.toISOString()).toBe("2025-12-31T06:30:00.000Z");
  });
});

describe("Bank of Baroda (synthetic)", () => {
  it("UPI debit", () => {
    const t = txn(
      "Rs.180.00 Dr. from A/C XXXXXX1234 and Cr. to ramesh.k@ybl. Ref:429512345678. AvlBal:Rs12345.67(2026:10:21 14:32:10). Not you? Call 18005700-BOB",
    );
    expect(t).toMatchObject({
      institution: "bob", direction: "debit", amountMinor: 18000, last4: "1234",
      accountKind: "bank_account", channel: "upi", vpa: "ramesh.k@ybl", counterparty: "ramesh.k@ybl",
      reference: "429512345678", balanceMinor: 1234567, timeKnown: true,
    });
    expect(t.occurredAt?.toISOString()).toBe("2026-10-21T09:02:10.000Z");
  });

  it("UPI credit", () => {
    const t = txn(
      "Rs.500.00 Credited to A/c ...1234 thru UPI/429598765432 by friend@okaxis. Total Bal:Rs.12845.67CR. Avlbl Amt:Rs.12845.67(21-10-2026 15:00:00) - Bank of Baroda",
    );
    expect(t).toMatchObject({
      direction: "credit", amountMinor: 50000, last4: "1234", reference: "429598765432",
      counterparty: "friend@okaxis", channel: "upi",
    });
  });

  it("detects by sender id", () => {
    expect(txn("Rs.42 debited from A/c XX9999 on 21-10-26 to merchant@paytm. UPI Ref 429511112222", "AD-BOBTXN-S").institution).toBe("bob");
  });
});

describe("HDFC (synthetic)", () => {
  it("UPI sent (multiline)", () => {
    const t = txn("Sent Rs.250.00\nFrom HDFC Bank A/C *4321\nTo SWIGGY\nOn 21/10/26\nRef 429500001111\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808");
    expect(t).toMatchObject({
      institution: "hdfc", direction: "debit", amountMinor: 25000, last4: "4321",
      accountKind: "bank_account", counterparty: "SWIGGY", reference: "429500001111", timeKnown: false,
    });
    expect(t.occurredAt).toEqual(received); // date-only and same day -> received time
  });

  it("credit card spend", () => {
    const t = txn("Spent Rs.1,234.50 On HDFC Bank Card 5678 At AMAZON PAY INDIA On 2026-10-21:14:32:10 Not You? To Block+Reissue Call 18002586161/SMS BLOCK CC 5678 to 7308080808");
    expect(t).toMatchObject({
      direction: "debit", amountMinor: 123450, last4: "5678", accountKind: "credit_card",
      channel: "card", counterparty: "AMAZON PAY INDIA", reference: null, timeKnown: true,
    });
  });

  it("debit card spend with balance", () => {
    const t = txn("Spent Rs.500 From HDFC Bank Card x8765 At ZEPTO On 2026-10-21:13:01:02 Bal Rs.12,345.67 Not You? Call 18002586161");
    expect(t).toMatchObject({ accountKind: "debit_card", amountMinor: 50000, balanceMinor: 1234567, counterparty: "ZEPTO" });
  });

  it("UPI credit alert", () => {
    const t = txn("Credit Alert!\nRs.5000.00 credited to HDFC Bank A/c XX4321 on 21-10-26 from VPA friend@okaxis (UPI 429522223333)");
    expect(t).toMatchObject({ direction: "credit", amountMinor: 500000, counterparty: "friend@okaxis", reference: "429522223333" });
  });

  it("RuPay credit card on UPI (Tata Neo)", () => {
    const t = txn("Rs.120.00 debited from HDFC Bank Credit Card XX9876 towards UPI txn to chaiwala@ybl on 21-10-26. UPI Ref No 429533334444");
    expect(t).toMatchObject({ accountKind: "credit_card", channel: "upi", last4: "9876", vpa: "chaiwala@ybl", reference: "429533334444" });
  });

  it("credit card payment received", () => {
    const t = txn("Payment of Rs.10,000.00 received towards your HDFC Bank Credit Card ending 5678 on 21-10-2026. Thank you");
    expect(t).toMatchObject({ direction: "credit", eventType: "card_payment", accountKind: "credit_card", last4: "5678" });
  });

  it("refund", () => {
    expect(txn("Refund of Rs.499.00 credited to your HDFC Bank Credit Card XX5678 from MYNTRA on 20-10-26").eventType).toBe("refund");
  });

  it("ATM withdrawal", () => {
    expect(txn("Rs.2000 withdrawn from HDFC Bank A/c XX4321 at ATM KORAMANGALA on 21-10-26").eventType).toBe("cash_withdrawal");
  });
});

describe("ignored and unrecognized", () => {
  const cases: [string, string, string][] = [
    ["OTP", "123456 is the OTP for txn of Rs.500 at AMAZON on HDFC Bank Card 5678", "otp"],
    ["autopay notice", "Rs.199 will be debited from HDFC Bank A/c XX4321 on 25-10-26 for NETFLIX mandate", "future_debit_notice"],
    ["failed txn", "Your UPI txn of Rs.300 from Bank of Baroda A/c XX1234 has failed", "failed_transaction"],
    ["due reminder", "HDFC Bank Credit Card XX5678: Total amount due Rs.15,000 by 05-11-26", "statement_or_due_reminder"],
    ["collect request", "merchant@ybl has requested money Rs.250 from your HDFC Bank A/c via UPI", "payment_request"],
    ["EMI offer", "HDFC Bank Credit Card xx0271 Update: Convert Rs.24294 spend to SmartEMI. Interest rate starts from 0.99% p.m.: https://1.hdfc.bank.in/HDFCBK/a/13Ag2ov T&C", "promotional"],
    ["loan offer", "Dear Customer, you have a pre-approved Personal Loan of Rs.5,00,000 from Bank of Baroda. Apply now", "promotional"],
  ];
  it.each(cases)("%s is ignored", (_, body, reason) => {
    expect(parseSms(null, body, received, TZ)).toMatchObject({ kind: "ignored", reason });
  });

  it("payee name stops before 'via NEFT' and 'credited to'", () => {
    const salary = parseSms("BOBSMS-S", "Rs.85000.00 Cr. to A/C XXXXXX5614 from ACME TECHNOLOGIES PVT LTD via NEFT UTR N295260001234. AvlBal:Rs122000.00", received, TZ);
    expect(salary).toMatchObject({ kind: "transaction", txn: { counterparty: "ACME TECHNOLOGIES PVT LTD", direction: "credit" } });
    const refund = parseSms("HDFCBK-S", "Refund of Rs.299.00 from AMAZON credited to HDFC Bank Credit Card XX0271 on 22-10-26", received, TZ);
    expect(refund).toMatchObject({ kind: "transaction", txn: { counterparty: "AMAZON", eventType: "refund" } });
  });

  it("promotional sender header is ignored whatever the text", () => {
    const body = "Rs.500 credited to your HDFC Bank A/c XX1234 on 22-10-26";
    expect(parseSms("HDFCBN-P", body, received, TZ)).toMatchObject({ kind: "ignored", reason: "promotional" });
    expect(parseSms("HDFCBK-S", body, received, TZ)).toMatchObject({ kind: "transaction" });
  });

  it("unknown bank is unrecognized, not guessed", () => {
    expect(parseSms(null, "Rs.100 debited from A/c XX1111 to x@ybl", received, TZ)).toMatchObject({ kind: "unrecognized", reason: "unknown_institution" });
  });

  it("missing amount is unrecognized", () => {
    expect(parseSms(null, "HDFC Bank: your account was debited", received, TZ)).toMatchObject({ kind: "unrecognized", reason: "no_amount" });
  });
});

describe("toMinor", () => {
  it.each([["1,234.5", 123450], ["180", 18000], ["0.07", 7], ["12.345", null], ["abc", null]] as const)("%s -> %s", (s, v) => {
    expect(toMinor(s)).toBe(v);
  });
});

describe("generic fallback (other banks)", () => {
  it("BoB message paying an @hdfcbank VPA stays BoB", () => {
    expect(txn("Rs.1586.00 Dr. from A/C XXXXXX1111 and Cr. to shop.123@hdfcbank. Ref:600000000002. AvlBal:Rs1.00(2026:10:20 05:17:40). Not you? Call 18005700/5000-BOB")).toMatchObject({
      institution: "bob", institutionName: "Bank of Baroda",
    });
  });

  it("listed bank by name uses generic extraction", () => {
    const r = parseSms(null, "ICICI Bank Acct XX123 debited for Rs 450.00 on 21-Oct-26; zomato@icici credited. UPI:600000000010. Call 18002662 for dispute.", received, TZ);
    expect(r).toMatchObject({ kind: "transaction", parser: "generic/v1" });
    expect(r.kind === "transaction" && r.txn).toMatchObject({
      institution: "icici", institutionName: "ICICI Bank", direction: "debit", amountMinor: 45000,
      vpa: "zomato@icici", reference: "600000000010", channel: "upi", confidence: expect.any(Number),
    });
  });

  it("listed bank by sender ID", () => {
    expect(txn("Dear Customer, Rs.300.00 debited from A/c XX4444 on 21Oct26 to swiggy@axis. Ref 600000000011", "VM-SBIINB-S")).toMatchObject({
      institution: "sbi", institutionName: "State Bank of India",
    });
  });

  it("State Bank of India is not mistaken for Bank of India", () => {
    expect(txn("Rs.10.00 debited from State Bank of India A/c XX4444 to x@ybl Ref 600000000012").institution).toBe("sbi");
  });

  it("unlisted bank named in the text", () => {
    expect(txn("Rs.75.00 debited from A/c XX5555 to tea@ybl Ref 600000000013 - Saraswat Co-operative BANK")).toMatchObject({
      institution: "saraswat-co-operative", institutionName: "Saraswat Co-operative Bank",
    });
  });

  it("generic results are less confident than tuned parsers", () => {
    const generic = txn("Rs.75.00 debited from A/c XX5555 to tea@ybl Ref 600000000013 - Axis Bank");
    const tuned = txn("Rs.75.00 Dr. from A/C XXXXXX5555 and Cr. to tea@ybl. Ref:600000000013. Call 18005700-BOB");
    expect(generic.confidence).toBeLessThan(tuned.confidence);
  });
});

describe("counterparty", () => {
  it("ignores a trailing helpline number and falls back to the VPA", () => {
    const t = txn("ICICI Bank Acct XX789 debited for Rs 120.00 on 21-Oct-26; chaiwala@ybl credited. UPI:600000000077. Call 18002662 for dispute. SMS BLOCK 789 to 9215676766.");
    expect(t).toMatchObject({ counterparty: "chaiwala@ybl", vpa: "chaiwala@ybl" });
  });
});
