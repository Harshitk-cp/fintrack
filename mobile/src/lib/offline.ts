import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";

// Offline mode: the last good answer for each screen's main request is kept on
// the phone, and served when the server can't be reached. Writes (saving,
// marking paid) still need the network; they fail with "You're offline".

/** GET paths worth keeping. Searches and paging aren't cached; the screens people open first are. */
const CACHED = [
  /^\/v1\/summary$/,
  /^\/v1\/transactions\?limit=200$/,
  /^\/v1\/transactions\?limit=50$/,
  /^\/v1\/transactions\/[0-9a-f-]{36}$/,
  /^\/v1\/(sips|budgets|subscriptions|health|settings|mail|notifications|nudges)$/,
  /^\/v1\/transactions\?limit=200&review=1$/,
];
const MAX_DETAILS = 40;

type Entry = { at: number; body: unknown };
let entries: Record<string, Entry> | null = null;
const file = () => new File(Paths.document, "fintrack-cache.json");

function load(): Record<string, Entry> {
  if (entries) return entries;
  try {
    const f = file();
    entries = f.exists ? (JSON.parse(f.textSync()) as Record<string, Entry>) : {};
  } catch {
    entries = {};
  }
  return entries;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const f = file();
      if (!f.exists) f.create();
      f.write(JSON.stringify(entries ?? {}));
    } catch {
      // A full disk just means no cache.
    }
  }, 500);
}

export const isCacheable = (path: string) => CACHED.some((r) => r.test(path));

export function remember(path: string, body: unknown) {
  const e = load();
  e[path] = { at: Date.now(), body };
  // Keep only the most recent transaction details.
  const details = Object.keys(e).filter((k) => /^\/v1\/transactions\/[0-9a-f-]{36}$/.test(k)).sort((a, b) => e[b]!.at - e[a]!.at);
  for (const k of details.slice(MAX_DETAILS)) delete e[k];
  persist();
  setOnline();
}

export function recall(path: string): Entry | null {
  return load()[path] ?? null;
}

/** Signing out (or in as someone else) must not leave the last person's data behind. */
export function clearCache() {
  entries = {};
  try {
    const f = file();
    if (f.exists) f.delete();
  } catch {}
  setOnline();
}

// Whether the last request was answered from the cache, and how old that answer was.
let state: { offline: boolean; since: number | null } = { offline: false, since: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setOffline(at: number) {
  if (state.offline && state.since !== null && state.since <= at) return;
  state = { offline: true, since: at };
  emit();
}

function setOnline() {
  if (!state.offline) return;
  state = { offline: false, since: null };
  emit();
}

/** { offline, since }: since is when the data on screen was last fetched. */
export function useOffline() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
