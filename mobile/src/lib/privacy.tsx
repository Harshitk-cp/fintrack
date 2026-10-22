import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { formatInr } from "./api";
import { haptic } from "./haptics";

const KEY = "fintrack.hideAmounts";

/** What a hidden amount looks like: the rupee sign stays so it still reads as money. */
export const HIDDEN = "₹ ••••";

interface Privacy {
  hidden: boolean;
  toggle: () => void;
}

const Ctx = createContext<Privacy>({ hidden: false, toggle: () => {} });

/** Privacy mode: every amount in the app shows as ₹ •••• until it's turned off. Remembered across launches. */
export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    SecureStore.getItemAsync(KEY).then((v) => setHidden(v === "1")).catch(() => {});
  }, []);
  const toggle = useCallback(() => {
    haptic.press();
    setHidden((h) => {
      SecureStore.setItemAsync(KEY, h ? "0" : "1").catch(() => {});
      return !h;
    });
  }, []);
  return <Ctx.Provider value={{ hidden, toggle }}>{children}</Ctx.Provider>;
}

export const usePrivacy = () => useContext(Ctx);

/** Hides rupee amounts inside text written elsewhere (notification titles and bodies). */
export function useMaskText() {
  const { hidden } = usePrivacy();
  return useCallback((s: string) => (hidden ? s.replace(/[−-]?₹\s?[\d,]+(?:\.\d+)?/g, HIDDEN) : s), [hidden]);
}

/** formatInr that respects privacy mode. Use it for every amount drawn on screen. */
export function useMoney() {
  const { hidden } = usePrivacy();
  return useCallback((minor: number, o?: { sign?: boolean }) => (hidden ? HIDDEN : formatInr(minor, o)), [hidden]);
}
