import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { getNotifications, getTransactions } from "./api";
import { useSession } from "./session";

interface Badges {
  review: number;
  unread: number;
  refresh: () => void;
}

const Ctx = createContext<Badges>({ review: 0, unread: 0, refresh: () => {} });

/** Counts shown on the Review tab and the inbox bell. Screens call refresh() after changing things. */
export function BadgesProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [review, setReview] = useState(0);
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(() => {
    if (!session) return;
    getTransactions(session, { review: true, limit: 200 })
      .then((r) => setReview(r.transactions.length))
      .catch(() => {});
    getNotifications(session)
      .then((r) => setUnread(r.unread))
      .catch(() => {});
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

  return <Ctx.Provider value={{ review, unread, refresh }}>{children}</Ctx.Provider>;
}

export const useBadges = () => useContext(Ctx);
