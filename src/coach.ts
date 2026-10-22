// Calm check-ins about the pace of spending against the user's salary.
// The numbers are worked out here; the model only words them kindly.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { formatInr } from "./money.ts";

export interface PaceFacts {
  name: string;
  incomeMinor: number;
  spentMinor: number;
  savedMinor: number;
  /** 0–1: how far through the month we are. */
  monthDone: number;
  daysLeft: number;
  topCategory: { name: string; spentMinor: number } | null;
  reason: "ahead" | "weekly";
}

export interface CoachNote {
  title: string;
  body: string;
}

export interface Coach {
  write(f: PaceFacts): Promise<CoachNote>;
}

const Note = z.object({ title: z.string(), body: z.string() });

const SYSTEM = `You write one short push notification for a personal finance app in India, about how the month's spending is going against the person's salary.

Tone: calm, warm and practical, like a sensible friend. Never shame, scold or alarm; no exclamation marks; no emojis.
- title: at most 45 characters.
- body: at most 2 short sentences (under 180 characters). Use the given numbers (₹ with Indian grouping). If they're ahead of pace, suggest one gentle, concrete step, ideally about their top category. If they're on track, say so and encourage them.
Don't invent numbers or facts that aren't given.`;

export class ClaudeCoach implements Coach {
  #client: Anthropic;
  #model: string;
  constructor(model: string, client = new Anthropic()) {
    this.#model = model;
    this.#client = client;
  }
  async write(f: PaceFacts): Promise<CoachNote> {
    const res = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: 1024,
      output_config: { effort: "low", format: zodOutputFormat(Note) },
      system: SYSTEM,
      messages: [{ role: "user", content: describe(f) }],
    });
    const out = res.parsed_output;
    if (res.stop_reason === "refusal" || !out) throw new Error(`no coach note (stop_reason=${res.stop_reason})`);
    return { title: out.title.slice(0, 60), body: out.body.slice(0, 240) };
  }
}

function describe(f: PaceFacts) {
  const pct = Math.round((f.spentMinor / f.incomeMinor) * 100);
  return [
    `Name: ${f.name}`,
    `Salary this month: ${formatInr(f.incomeMinor)}`,
    `Spent so far: ${formatInr(f.spentMinor)} (${pct}% of salary)`,
    `Saved/invested so far: ${formatInr(f.savedMinor)}`,
    `Month: ${Math.round(f.monthDone * 100)}% gone, ${f.daysLeft} days left`,
    f.topCategory ? `Biggest category: ${f.topCategory.name} (${formatInr(f.topCategory.spentMinor)})` : null,
    `Why this message: ${f.reason === "ahead" ? "spending is running ahead of the month" : "weekly check-in"}`,
  ].filter(Boolean).join("\n");
}

/** The message without the model: plain and still kind. */
export function plainNote(f: PaceFacts): CoachNote {
  const pct = Math.round((f.spentMinor / f.incomeMinor) * 100);
  const left = Math.max(0, f.incomeMinor - f.spentMinor);
  if (f.reason === "ahead") {
    return {
      title: `${pct}% of your salary is spent`,
      body: `${formatInr(left)} left for ${f.daysLeft} days. Easing off a little${f.topCategory ? ` on ${f.topCategory.name.toLowerCase()}` : ""} would keep the month comfortable.`,
    };
  }
  return {
    title: pct <= f.monthDone * 100 ? "You're on track this month" : "Weekly check-in",
    body: `${formatInr(f.spentMinor)} spent of ${formatInr(f.incomeMinor)} with ${f.daysLeft} days to go.`,
  };
}

/**
 * Which "ahead of pace" level applies, if any: half the salary gone in the
 * first ~40% of the month, three quarters in the first ~65%, or 90% before the
 * last few days.
 */
export function paceLevel(spentShare: number, monthDone: number): 1 | 2 | 3 | null {
  if (spentShare >= 0.9 && monthDone < 0.9) return 3;
  if (spentShare >= 0.75 && monthDone <= 0.65) return 2;
  if (spentShare >= 0.5 && monthDone <= 0.4) return 1;
  return null;
}
