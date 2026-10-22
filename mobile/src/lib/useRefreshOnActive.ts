import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { AppState } from "react-native";

/**
 * Runs `refresh` when the screen gains focus, when the app returns to the
 * foreground while the screen is focused, and every `intervalMs` if given.
 */
export function useRefreshOnActive(refresh: () => void, intervalMs?: number) {
  useFocusEffect(
    useCallback(() => {
      refresh();
      const sub = AppState.addEventListener("change", (s) => s === "active" && refresh());
      const timer = intervalMs ? setInterval(refresh, intervalMs) : undefined;
      return () => {
        sub.remove();
        if (timer) clearInterval(timer);
      };
    }, [refresh, intervalMs]),
  );
}
