// Is everything that feeds the ledger still working? Bank SMS arriving, each
// mailbox being read, and notifications having somewhere to go. Forwarders can
// stop silently (an iOS update, a revoked permission), so the app shows this and
// the notifier sends one calm heads-up when bank SMS stop arriving.
import type { Sql } from "./db.ts";

export type HealthState = "ok" | "warn" | "off";

export interface HealthCheck {
  id: string;
  state: HealthState;
  title: string;
  detail: string;
}

/** Bank SMS older than this make the SMS check a warning. */
export const SMS_STALE_DAYS = 3;
/** A mailbox not checked for this long is a warning (the poller runs every few minutes). */
const MAIL_STALE_MS = 2 * 3_600_000;

export function ago(from: Date, now: Date) {
  const mins = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function healthChecks(sql: Sql, userId: string, o: { mail: boolean; ntfy: boolean; fcm: boolean }, now = new Date()) {
  const [sms] = await sql`
    select max(e.observed_at) as last_at, count(*) filter (where e.observed_at > now() - interval '7 days')::int as week,
           (select d.name from evidence x left join devices d on d.id = x.device_id
            where x.user_id = ${userId} and x.source_type = 'sms' order by x.observed_at desc limit 1) as device
    from evidence e where e.user_id = ${userId} and e.source_type = 'sms'`;
  const mailboxes = await sql`
    select id, address, status, last_checked_at, emails_found from mail_accounts where user_id = ${userId} order by created_at`;
  const [u] = await sql`
    select push_topic, (select count(*)::int from push_tokens p where p.user_id = users.id) as tokens,
           (select count(*)::int from push_tokens p where p.user_id = users.id and p.last_error is not null) as failing
    from users where id = ${userId}`;

  const checks: HealthCheck[] = [];
  const last: Date | null = sms!.last_at;
  if (!last) {
    checks.push({ id: "sms", state: "off", title: "No bank SMS yet", detail: "Set up SMS forwarding below so payments appear on their own." });
  } else {
    const days = (now.getTime() - last.getTime()) / 86_400_000;
    const stale = days > SMS_STALE_DAYS;
    checks.push({
      id: "sms",
      state: stale ? "warn" : "ok",
      title: `Last bank SMS ${ago(last, now)}`,
      detail: stale
        ? "If you've paid by card or UPI since, SMS forwarding may have stopped. Check the steps below."
        : `${sms!.week} in the last 7 days${sms!.device ? ` · from ${sms!.device}` : ""}`,
    });
  }

  if (o.mail) {
    if (!mailboxes.length) {
      checks.push({ id: "mail", state: "off", title: "No mailbox connected", detail: "Bank emails catch payments whose SMS never arrived." });
    }
    for (const m of mailboxes) {
      const checked: Date | null = m.last_checked_at;
      const stale = !checked || now.getTime() - checked.getTime() > MAIL_STALE_MS;
      const state: HealthState = m.status === "auth_failed" || m.status === "error" || (m.status === "ok" && stale) ? "warn" : "ok";
      checks.push({
        id: `mail:${m.id}`,
        state,
        title: m.address,
        detail:
          m.status === "auth_failed" ? "The app password stopped working. Add the mailbox again with a new one."
          : m.status === "error" ? "Couldn't read this mailbox last time. It will keep trying."
          : m.status === "pending" ? "Connecting…"
          : `Checked ${checked ? ago(checked, now) : "never"} · ${m.emails_found} bank email${m.emails_found === 1 ? "" : "s"} read`,
      });
    }
  }

  const pushOn = (o.ntfy && !!u!.push_topic) || (o.fcm && u!.tokens > 0);
  checks.push(
    !pushOn
      ? { id: "push", state: "off", title: "Notifications off", detail: "Turn them on below to hear about payments as they happen." }
      : u!.failing > 0 && u!.failing === u!.tokens && !(o.ntfy && u!.push_topic)
        ? { id: "push", state: "warn", title: "Notifications failing", detail: "The last push couldn't be delivered. Open the app on your phone to re-register." }
        : { id: "push", state: "ok", title: "Notifications on", detail: [o.fcm && u!.tokens ? `${u!.tokens} Android phone${u!.tokens === 1 ? "" : "s"}` : null, o.ntfy && u!.push_topic ? "ntfy" : null].filter(Boolean).join(" · ") },
  );

  const order: Record<HealthState, number> = { ok: 0, off: 1, warn: 2 };
  const overall = checks.reduce<HealthState>((w, c) => (order[c.state] > order[w] ? c.state : w), "ok");
  return { overall: overall === "off" ? ("ok" as HealthState) : overall, checks, last_sms_at: last };
}
