// "Ask" tab: answers questions about the user's own spending. The model can
// only read, through tools that are scoped to the asking user and compute all
// totals in SQL, so the figures it quotes come from the ledger, not from it.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CATEGORIES, CATEGORY_IDS } from "./categories.ts";
import type { Sql } from "./db.ts";
import { localParts } from "./money.ts";
import { isRefund, isSpend } from "./stats.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Assistant {
  ask(userId: string, timeZone: string, messages: ChatMessage[]): Promise<string>;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local date, YYYY-MM-DD");

const SearchInput = z.object({
  from: date.optional(),
  to: date.optional().describe("Inclusive"),
  text: z.string().max(100).optional().describe("Matches payee name, UPI ID, the user's label or note"),
  category: z.enum(CATEGORY_IDS).optional(),
  bank: z.string().max(60).optional().describe('Bank name as shown, e.g. "HDFC Bank", or "Cash"'),
  direction: z.enum(["debit", "credit"]).optional(),
  min_rupees: z.number().nonnegative().optional(),
  max_rupees: z.number().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

const BreakdownInput = z.object({
  from: date,
  to: date.describe("Inclusive"),
  group_by: z.enum(["category", "payee", "bank", "day", "month"]),
  limit: z.number().int().min(1).max(60).default(15),
});

const rupees = (minor: unknown) => Number(minor) / 100;

/** The tools, bound to one user. Exported for tests. */
export function ledgerTools(sql: Sql, userId: string, tz: string) {
  const range = (from?: string, to?: string) => sql`
    ${from ? sql`and t.occurred_at >= (${from}::date)::timestamp at time zone ${tz}` : sql``}
    ${to ? sql`and t.occurred_at < (${to}::date + 1)::timestamp at time zone ${tz}` : sql``}`;

  const search = betaZodTool({
    name: "search_transactions",
    description:
      "List individual transactions, newest first, with optional filters. Use for questions about specific payments. " +
      "Amounts are in rupees. excluded=true rows are ones the user marked as not counting.",
    inputSchema: SearchInput,
    run: async (i) => {
      const rows = await sql`
        select to_char(t.occurred_at at time zone ${tz}, 'YYYY-MM-DD HH24:MI') as at, t.amount_minor, t.direction,
               t.event_type, coalesce(t.label, t.counterparty, t.counterparty_vpa) as payee, t.category,
               t.institution_name as bank, t.note, t.excluded
        from transactions t
        where t.user_id = ${userId} ${range(i.from, i.to)}
          ${i.text ? sql`and concat_ws(' ', t.label, t.counterparty, t.counterparty_vpa, t.note) ilike ${"%" + i.text.replace(/[%_\\]/g, "\\$&") + "%"}` : sql``}
          ${i.category ? sql`and t.category = ${i.category}` : sql``}
          ${i.bank ? sql`and t.institution_name ilike ${i.bank}` : sql``}
          ${i.direction ? sql`and t.direction = ${i.direction}` : sql``}
          ${i.min_rupees !== undefined ? sql`and t.amount_minor >= ${Math.round(i.min_rupees * 100)}` : sql``}
          ${i.max_rupees !== undefined ? sql`and t.amount_minor <= ${Math.round(i.max_rupees * 100)}` : sql``}
        order by t.occurred_at desc limit ${i.limit}`;
      return JSON.stringify(rows.map((r) => ({ ...r, amount_minor: undefined, rupees: rupees(r.amount_minor) })));
    },
  });

  const breakdown = betaZodTool({
    name: "spending_breakdown",
    description:
      "Total spending between two dates, grouped. Spending excludes card bill payments, transfers between the user's own " +
      "accounts, ATM withdrawals and excluded transactions; refunds are subtracted. Also returns money received. Use this for any total.",
    inputSchema: BreakdownInput,
    run: async (i) => {
      const key = {
        category: sql`coalesce(t.category, 'uncategorized')`,
        payee: sql`coalesce(t.label, t.counterparty, t.counterparty_vpa, 'unknown')`,
        bank: sql`coalesce(t.institution_name, 'Unknown bank')`,
        day: sql`to_char(t.occurred_at at time zone ${tz}, 'YYYY-MM-DD')`,
        month: sql`to_char(t.occurred_at at time zone ${tz}, 'YYYY-MM')`,
      }[i.group_by];
      const groups = await sql`
        select ${key} as key,
               coalesce(sum(t.amount_minor) filter (where ${isSpend(sql)}), 0) - coalesce(sum(t.amount_minor) filter (where ${isRefund(sql)}), 0) as net,
               count(*) filter (where ${isSpend(sql)})::int as payments
        from transactions t
        where t.user_id = ${userId} ${range(i.from, i.to)} and (${isSpend(sql)} or ${isRefund(sql)})
        group by 1 order by 2 desc limit ${i.limit}`;
      const [tot] = await sql`
        select coalesce(sum(t.amount_minor) filter (where ${isSpend(sql)}), 0) - coalesce(sum(t.amount_minor) filter (where ${isRefund(sql)}), 0) as net,
               coalesce(sum(t.amount_minor) filter (where t.direction = 'credit' and not t.excluded and t.event_type not in ('refund', 'card_payment', 'transfer')), 0) as received
        from transactions t where t.user_id = ${userId} ${range(i.from, i.to)}`;
      return JSON.stringify({
        net_spent_rupees: rupees(tot!.net),
        received_rupees: rupees(tot!.received),
        groups: groups.map((g) => ({ key: g.key, net_spent_rupees: rupees(g.net), payments: g.payments })),
      });
    },
  });

  return { search, breakdown };
}

function systemPrompt(name: string, tz: string, now: Date) {
  const { date } = localParts(now, tz);
  const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone: tz }).format(now);
  return `You are the assistant inside Fintrack, a personal expense tracker. You are talking to ${name}. Today is ${weekday}, ${date} (${tz}).

The ledger is built from the user's bank SMS alerts plus entries they added by hand, so it covers UPI, card and bank payments that sent an SMS; cash is only there if they entered it. Mention this when a gap could matter.

Answer only from the tools. Never estimate or invent amounts; if the tools return nothing, say so. Use spending_breakdown for any total and search_transactions to list or find payments. Interpret "this month", "last week" and similar relative to today.

Write amounts in rupees with Indian digit grouping (₹1,23,456). Keep answers short: lead with the number or the answer, then at most a few lines or a short list. The chat shows plain text and renders only **bold** and "- " list lines, so don't use headings, tables or links. You can't change transactions; for that, point the user to the Review tab or the transaction's screen.

Categories: ${CATEGORIES.map((c) => `${c.id} (${c.name})`).join(", ")}; "uncategorized" means the user hasn't said yet.`;
}

export class ClaudeAssistant implements Assistant {
  #sql: Sql;
  #model: string;
  #client: Anthropic;

  constructor(sql: Sql, model: string, client = new Anthropic()) {
    this.#sql = sql;
    this.#model = model;
    this.#client = client;
  }

  async ask(userId: string, timeZone: string, messages: ChatMessage[]): Promise<string> {
    const [u] = await this.#sql`select name from users where id = ${userId}`;
    const final = await this.#client.beta.messages.toolRunner({
      model: this.#model,
      max_tokens: 8000,
      max_iterations: 8,
      system: systemPrompt(u?.name ?? "the user", timeZone, new Date()),
      tools: Object.values(ledgerTools(this.#sql, userId, timeZone)),
      messages,
    });
    if (final.stop_reason === "refusal") return "Sorry, I can't help with that one.";
    const text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (final.stop_reason === "max_tokens" || !text) return "Sorry, I couldn't finish that answer. Try a narrower question.";
    return text;
  }
}
