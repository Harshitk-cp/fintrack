import { useEffect, useRef } from "react";

// "Something in the ledger changed elsewhere" (an Undo from a toast, say), so
// screens already showing that data fetch it again.
const listeners = new Set<() => void>();

export function ledgerChanged() {
  listeners.forEach((l) => l());
}

export function useOnLedgerChange(refresh: () => void) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    const l = () => latest.current();
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}
