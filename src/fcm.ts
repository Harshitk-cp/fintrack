// Firebase Cloud Messaging (HTTP v1) for Android push. The server signs its own
// OAuth token from a Firebase service account key, so no Firebase SDK is needed.
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmMessage {
  title: string;
  body: string;
  /** Deep link the app opens when the notification is tapped. */
  url: string;
  /** Android notification channel (created by the app). */
  channel: "payments" | "review" | "summary" | "budget";
  /** Notifications with the same tag replace each other in the tray. */
  tag?: string;
  high?: boolean;
}

export type FcmResult = "sent" | "unregistered";

/**
 * Reads the service account from FINTRACK_FCM_SERVICE_ACCOUNT: the JSON itself,
 * a path to the JSON file, or the JSON base64-encoded (handy in a .env file).
 */
export function loadServiceAccount(value: string | undefined): ServiceAccount | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  const text = v.startsWith("{") ? v : existsSync(v) ? readFileSync(v, "utf8") : Buffer.from(v, "base64").toString("utf8");
  const sa = JSON.parse(text) as Partial<ServiceAccount>;
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error("FINTRACK_FCM_SERVICE_ACCOUNT is not a Firebase service account key");
  return sa as ServiceAccount;
}

const base64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class FcmSender {
  #sa: ServiceAccount;
  #token: { value: string; expires: number } | null = null;

  constructor(sa: ServiceAccount) {
    this.#sa = sa;
  }

  get projectId() {
    return this.#sa.project_id;
  }

  /** A Google OAuth access token for FCM, cached until shortly before it expires. */
  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expires > Date.now() + 60_000) return this.#token.value;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({
      iss: this.#sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    }));
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.#sa.private_key).toString("base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`google oauth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  /** Sends one notification; "unregistered" means the token is dead and should be forgotten. */
  async send(token: string, m: FcmMessage): Promise<FcmResult> {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.#sa.project_id}/messages:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await this.#accessToken()}` },
      body: JSON.stringify({ message: fcmPayload(token, m) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "sent";
    const text = await res.text();
    if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) return "unregistered";
    throw new Error(`fcm ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * The Android notification in the app's style: the pixel mark as the small
 * icon, tinted Orange, on the channel the app created for this kind.
 */
export function fcmPayload(token: string, m: FcmMessage) {
  return {
    token,
    notification: { title: m.title, body: m.body },
    data: { url: m.url },
    android: {
      priority: m.high ? "HIGH" : "NORMAL",
      notification: {
        channel_id: m.channel,
        icon: "notification_icon",
        color: "#FF8400",
        ...(m.tag ? { tag: m.tag } : {}),
        default_sound: true,
      },
    },
  };
}
