import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import SmsCollector from "../../modules/sms-collector";
import type { Session } from "./api";
import { clearCache } from "./offline";

const KEY = "fintrack.session";

interface SessionState {
  session: Session | null;
  loading: boolean;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

/** The device token lives in the Keychain (iOS) / Keystore-backed storage (Android). */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((raw) => {
        const s: Session | null = raw ? JSON.parse(raw) : null;
        setSession(s);
        // Keep the native collector in step with the stored session (e.g. after an update).
        if (s) SmsCollector?.configure(s.serverUrl, s.token);
      })
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (s: Session) => {
    clearCache(); // never show one account's saved data to another
    await SecureStore.setItemAsync(KEY, JSON.stringify(s));
    SmsCollector?.configure(s.serverUrl, s.token);
    setSession(s);
  }, []);

  const signOut = useCallback(async () => {
    clearCache();
    await SecureStore.deleteItemAsync(KEY);
    SmsCollector?.disable();
    setSession(null);
  }, []);

  return <Ctx.Provider value={{ session, loading, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
