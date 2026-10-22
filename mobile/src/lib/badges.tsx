import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { dismissMailNudge, getNotifications, getNudges, getSips, getTransactions } from "./api";
import { useSession } from "./session";

interface Badges {
  review: number;
  unread: number;
  /** No mailbox connected yet: a dot on the Settings tab until there is one. */
  mailPending: boolean;
  /** The Home banner asking to connect a mailbox is due (the server spaces out reminders). */
  mailNudge: boolean;
  dismissMailNudge: () => void;
  refresh: () => void;
}

const Ctx = createContext<Badges>({ review: 0, unread: 0, mailPending: false, mailNudge: false, dismissMailNudge: () => {}, refresh: () => {} });

/** Counts and nudges shown on tabs, the inbox bell and Home. Screens call refresh() after changing things. */
export function BadgesProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [review, setReview] = useState(0);
  const [unread, setUnread] = useState(0);
  const [mailPending, setMailPending] = useState(false);
  const [mailNudge, setMailNudge] = useState(false);

  const refresh = useCallback(() => {
    if (!session) return;
    // Review covers payments to answer and SIP alerts to confirm.
    Promise.all([getTransactions(session, { review: true, limit: 200 }), getSips(session).catch(() => ({ suggestions: [] }))])
      .then(([r, s]) => setReview(r.transactions.length + s.suggestions.length))
      .catch(() => {});
    getNotifications(session)
      .then((r) => setUnread(r.unread))
      .catch(() => {});
    getNudges(session)
      .then((n) => {
        setMailPending(n.mail.pending);
        setMailNudge(n.mail.show);
      })
      .catch(() => {});
  }, [session]);

  const dismiss = useCallback(() => {
    setMailNudge(false); // hide at once; the server records it and decides when to ask again
    if (session) dismissMailNudge(session).catch(() => {});
  }, [session]);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener("change", (s) => s === "active" && refresh());
    const timer = setInterval(refresh, 60_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [refresh]);

  return <Ctx.Provider value={{ review, unread, mailPending, mailNudge, dismissMailNudge: dismiss, refresh }}>{children}</Ctx.Provider>;
}

export const useBadges = () => useContext(Ctx);
