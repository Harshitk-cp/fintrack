// Typed client for the fintrack backend. Amounts are integers in paise.

export interface Session {
  serverUrl: string;
  token: string;
  userName: string;
  phone?: string | null;
}

export type ReviewReason = "unknown_payee" | "uncategorized" | "llm_parsed";

export interface Transaction {
  id: string;
  amount_minor: number;
  direction: "debit" | "credit";
  event_type: string;
  channel: string;
  source: "sms" | "manual";
  occurred_at: string;
  counterparty: string | null;
  counterparty_vpa: string | null;
  reference: string | null;
  institution: string | null;
  institution_name: string | null;
  category: string | null;
  category_source: "user" | "rule" | "builtin" | null;
  label: string | null;
  note: string | null;
  excluded: boolean;
  review_reason: ReviewReason | null;
  reviewed_at: string | null;
  account_kind: string | null;
  last4: string | null;
  evidence_count: number;
}

export interface TransactionDetail extends Transaction {
  evidence: { id: string; source_type: string; sender: string | null; observed_at: string; parser: string | null }[];
}

export interface TransactionPatch {
  label?: string | null;
  category?: string | null;
  note?: string | null;
  event_type?: string;
  excluded?: boolean;
  amount_minor?: number;
  occurred_at?: string;
  remember?: boolean;
}

export interface ManualEntry {
  amount_minor: number;
  direction: "debit" | "credit";
  counterparty: string;
  category: string | null;
  occurred_at: string;
  paid_with: string | null;
  note: string | null;
}

export interface AppNotification {
  id: string;
  kind: "transaction" | "review" | "digest" | "budget";
  title: string;
  body: string;
  transaction_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface Settings {
  alert_min_minor: number;
  digest_hour: number;
  monthly_budget_minor: number | null;
  time_zone: string;
  push: { available: boolean; enabled: boolean; server: string | null; topic: string | null };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Summary {
  month: string;
  spent_minor: number;
  refunds_minor: number;
  net_spent_minor: number;
  received_minor: number;
  cash_withdrawn_minor: number;
  transaction_count: number;
  budget_minor: number | null;
  review_count: number;
  by_bank: { institution_name: string; spent_minor: number; transaction_count: number }[];
  by_category: { category: string | null; spent_minor: number; transaction_count: number }[];
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function request<T>(serverUrl: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  return body as T;
}

/** Plain HTTP is only accepted in development builds, for the local backend. */
export function normalizeServerUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!__DEV__ && !/^https:\/\//i.test(u)) throw new ApiError(0, "https_required");
  return u;
}

type AuthResult = { token: string; device_id: string; user: { id: string; name: string; phone: string } };
type DeviceInfo = { platform: "ios" | "android" | "other"; device_name: string };

export function register(serverUrl: string, body: { phone: string; pin: string; name: string } & DeviceInfo) {
  return request<AuthResult>(serverUrl, "/v1/auth/register", { method: "POST", body: JSON.stringify(body) });
}

export function login(serverUrl: string, body: { phone: string; pin: string } & DeviceInfo) {
  return request<AuthResult>(serverUrl, "/v1/auth/login", { method: "POST", body: JSON.stringify(body) });
}

export interface Mailbox {
  id: string;
  address: string;
  host: string;
  status: "pending" | "ok" | "auth_failed" | "error";
  last_error: string | null;
  last_checked_at: string | null;
  emails_found: number;
}

export interface MailState {
  available: boolean;
  max: number;
  mailboxes: Mailbox[];
}

export function getMail(s: Session) {
  return authed<MailState>(s, "/v1/mail");
}

/** Adds a mailbox, or updates the password of one already connected with this address. */
export function connectMail(s: Session, body: { address: string; app_password: string; host?: string }) {
  return authed<MailState>(s, "/v1/mail", "PUT", body);
}

export function syncMail(s: Session, id?: string) {
  return authed<{ ok: true }>(s, `/v1/mail/sync${id ? `?id=${id}` : ""}`, "POST", {});
}

export function disconnectMail(s: Session, id: string) {
  return authed<void>(s, `/v1/mail/${id}`, "DELETE");
}

export function verifyPin(s: Session, pin: string) {
  return authed<{ ok: true }>(s, "/v1/auth/verify-pin", "POST", { pin });
}

export function changePin(s: Session, current_pin: string, new_pin: string) {
  return authed<void>(s, "/v1/auth/pin", "POST", { current_pin, new_pin });
}

export function logout(s: Session) {
  return authed<void>(s, "/v1/auth/logout", "POST", {});
}

const authed = <T>(s: Session, path: string, method = "GET", body?: unknown) =>
  request<T>(s.serverUrl, path, { token: s.token, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function getTransactions(s: Session, o: { limit?: number; review?: boolean; q?: string } = {}) {
  const qs = new URLSearchParams({ limit: String(o.limit ?? 100) });
  if (o.review) qs.set("review", "1");
  if (o.q) qs.set("q", o.q);
  return authed<{ transactions: Transaction[] }>(s, `/v1/transactions?${qs}`);
}

export const getSummary = (s: Session) => authed<Summary>(s, "/v1/summary");
export const getTransaction = (s: Session, id: string) => authed<{ transaction: TransactionDetail }>(s, `/v1/transactions/${id}`);
export const updateTransaction = (s: Session, id: string, patch: TransactionPatch) =>
  authed<{ transaction: TransactionDetail; applied_to: number }>(s, `/v1/transactions/${id}`, "PATCH", patch);
export const addTransaction = (s: Session, entry: ManualEntry) =>
  authed<{ transaction: TransactionDetail }>(s, "/v1/transactions", "POST", entry);
export const deleteTransaction = (s: Session, id: string) => authed<void>(s, `/v1/transactions/${id}`, "DELETE");
export const getNotifications = (s: Session) => authed<{ notifications: AppNotification[]; unread: number }>(s, "/v1/notifications");
export const markNotificationsRead = (s: Session) => authed<{ ok: true }>(s, "/v1/notifications/read", "POST", {});
export const getSettings = (s: Session) => authed<Settings>(s, "/v1/settings");
export const updateSettings = (s: Session, patch: Partial<Pick<Settings, "alert_min_minor" | "digest_hour" | "monthly_budget_minor">> & { push_enabled?: boolean }) =>
  authed<Settings>(s, "/v1/settings", "PATCH", patch);
export const sendTestPush = (s: Session) => authed<{ ok: true }>(s, "/v1/settings/push/test", "POST", {});
export const ask = (s: Session, messages: ChatMessage[]) => authed<{ answer: string }>(s, "/v1/ask", "POST", { messages });

/** "1,234.50" or "₹ 99" → 123450 / 9900 paise; null when it isn't a positive amount. */
export function parseRupees(input: string): number | null {
  const clean = input.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const minor = Math.round(Number(clean) * 100);
  return minor > 0 ? minor : null;
}

/** ₹1,23,456.78 with Indian digit grouping, independent of the device's Intl support. */
export function formatInr(minor: number, { sign = false }: { sign?: boolean } = {}): string {
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  const prefix = sign ? (minor < 0 ? "−" : "+") : minor < 0 ? "−" : "";
  return `${prefix}₹${grouped}${paise ? `.${String(paise).padStart(2, "0")}` : ""}`;
}
