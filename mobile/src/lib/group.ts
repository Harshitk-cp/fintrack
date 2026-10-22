import type { Transaction } from "./api";
import { TZ } from "./format";

/** Transactions (newest first) split into "Today", "Yesterday" and dated day sections. */
export function groupByDay(txns: Transaction[]) {
  const fmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const today = key.format(new Date());
  const yesterday = key.format(new Date(Date.now() - 86_400_000));
  const sections: { title: string; data: Transaction[] }[] = [];
  let current: string | null = null;
  for (const txn of txns) {
    const d = new Date(txn.occurred_at);
    const k = key.format(d);
    if (k !== current) {
      current = k;
      sections.push({ title: k === today ? "Today" : k === yesterday ? "Yesterday" : fmt.format(d), data: [] });
    }
    sections.at(-1)!.data.push(txn);
  }
  return sections;
}
