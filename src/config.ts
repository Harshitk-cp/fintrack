import { DEFAULT_LLM_MODEL } from "./llm.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

export interface Config {
  databaseUrl: string;
  dataKey: string;
  host: string;
  port: number;
  timeZone: string;
  // LLM fallback for unparseable SMS; disabled when no Anthropic key is configured.
  llmModel: string | null;
  // ntfy server for push alerts; users opt in from the app. "off" disables push.
  pushUrl: string | null;
  pushToken: string | null;
  /** Firebase service account (JSON, a path to it, or base64) for Android push. */
  fcmServiceAccount: string | null;
}

export function loadConfig(): Config {
  return {
    databaseUrl: required("DATABASE_URL"),
    dataKey: required("FINTRACK_DATA_KEY"),
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 8080),
    timeZone: process.env.FINTRACK_TIME_ZONE ?? "Asia/Kolkata",
    llmModel: process.env.ANTHROPIC_API_KEY ? (process.env.FINTRACK_LLM_MODEL ?? DEFAULT_LLM_MODEL) : null,
    pushUrl: process.env.FINTRACK_PUSH_URL === "off" ? null : (process.env.FINTRACK_PUSH_URL ?? "https://ntfy.sh"),
    pushToken: process.env.FINTRACK_PUSH_TOKEN ?? null,
    fcmServiceAccount: process.env.FINTRACK_FCM_SERVICE_ACCOUNT ?? null,
  };
}
