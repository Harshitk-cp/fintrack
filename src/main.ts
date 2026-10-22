#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildApi } from "./api.ts";
import { ClaudeAssistant } from "./assistant.ts";
import { hashPin, isWeakPin, normalizePhone, PIN_RE } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { newDataKey, newDeviceToken, newPairingCode, normalizePairingCode, Sealer, sha256 } from "./crypto.ts";
import { connect, migrate } from "./db.ts";
import { purgeExpiredRaw } from "./ingest.ts";
import { classifyBackfill } from "./ledger.ts";
import { ClaudeExtractor, DEFAULT_LLM_MODEL, groundExtraction } from "./llm.ts";
import { Notifier, NtfyPush } from "./notify.ts";
import { parseSms } from "./sms/parser.ts";
import { MailPoller } from "./mail/poller.ts";
import { ImapMailSource } from "./mail/source.ts";
import { LlmWorker } from "./worker.ts";

const USAGE = `fintrack <command>

  serve                                           run migrations, then the HTTP API
  migrate                                         apply pending migrations
  user add --name <name> [--phone <no> --pin <4 digits>]
                                                  create a user (people can also sign up in the app)
  user set-pin --phone <no> --pin <4 digits>      reset a forgotten PIN and clear its lockout
  device add --user <id> --name <name> --platform ios|android|other
                                                  issue a collector token (shown once)
  pair --user <id> --name <name> --platform ios|android|other
                                                  one-time code to pair the app (15 min)
  device revoke --id <device-id>                  revoke a collector token
  parse [--sender <id>] [--llm]                   parse an SMS from stdin (no database);
                                                  --llm tries the Claude fallback if rules fail
  keygen                                          print a new FINTRACK_DATA_KEY`;

async function main(argv: string[]) {
  const [cmd, sub] = argv;
  const { values } = parseArgs({
    args: argv.slice(cmd === "user" || cmd === "device" ? 2 : 1),
    options: {
      name: { type: "string" }, email: { type: "string" }, user: { type: "string" },
      platform: { type: "string" }, id: { type: "string" }, sender: { type: "string" },
      llm: { type: "boolean" }, phone: { type: "string" }, pin: { type: "string" },
    },
  });

  switch (cmd) {
    case "keygen":
      console.log(newDataKey());
      return;

    case "parse": {
      const body = readFileSync(0, "utf8");
      const tz = process.env.FINTRACK_TIME_ZONE ?? "Asia/Kolkata";
      const sender = values.sender ?? null;
      let result = parseSms(sender, body, new Date(), tz);
      if (values.llm && result.kind === "unrecognized") {
        const model = process.env.FINTRACK_LLM_MODEL ?? DEFAULT_LLM_MODEL;
        const extraction = await new ClaudeExtractor(model).extract(sender, body);
        console.error(`rules: ${result.reason}; llm extraction:\n${JSON.stringify(extraction, null, 2)}`);
        result = groundExtraction(extraction, body, new Date(), tz, model);
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "serve": {
      const cfg = loadConfig();
      const sql = connect(cfg.databaseUrl);
      const applied = await migrate(sql);
      if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);
      const classified = await classifyBackfill(sql);
      if (classified) console.log(`categorised ${classified} existing transactions`);
      const sealer = new Sealer(cfg.dataKey);
      let worker: LlmWorker | null = null;
      const notifier = new Notifier(sql, cfg.pushUrl ? new NtfyPush(cfg.pushUrl, cfg.pushToken) : null);
      const assistant = cfg.llmModel ? new ClaudeAssistant(sql, cfg.llmModel) : null;
      const mailSource = new ImapMailSource();
      const mailPoller = new MailPoller(sql, sealer, cfg.timeZone, mailSource, { onUnrecognized: () => worker?.kick(), onTransaction: () => notifier.kick() });
      const app = await buildApi({
        sql, sealer, timeZone: cfg.timeZone, onUnrecognized: () => worker?.kick(), notifier, assistant, mail: { source: mailSource, poller: mailPoller },
      });
      notifier.setLogger(app.log);
      notifier.start();
      mailPoller.setLogger(app.log);
      mailPoller.start();
      if (cfg.llmModel) {
        worker = new LlmWorker(sql, sealer, new ClaudeExtractor(cfg.llmModel), cfg.timeZone, app.log);
        worker.start();
        app.log.info({ model: cfg.llmModel }, "llm fallback enabled");
      } else {
        app.log.warn("ANTHROPIC_API_KEY not set: unrecognized SMS stay unrecognized and the assistant is off");
      }
      const purge = () => purgeExpiredRaw(sql).catch((err) => app.log.error({ err }, "purge failed"));
      setInterval(purge, 3_600_000).unref();
      void purge();
      const shutdown = async () => {
        await app.close();
        await sql.end();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown).on("SIGINT", shutdown);
      await app.listen({ host: cfg.host, port: cfg.port });
      return;
    }
  }

  // Remaining commands only need the database.
  const sql = connect(loadConfig().databaseUrl);
  try {
    if (cmd === "migrate") {
      const applied = await migrate(sql);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    } else if (cmd === "user" && sub === "add") {
      if (!values.name) throw new Error("--name is required");
      const phone = values.phone ? normalizePhone(values.phone) : null;
      if (values.phone && !phone) throw new Error("--phone is not a valid phone number");
      if (phone && !(values.pin && PIN_RE.test(values.pin))) throw new Error("--pin (4 digits) is required with --phone");
      if (phone && isWeakPin(values.pin!)) throw new Error("--pin is too easy to guess (repeated, sequential or a year)");
      const pinHash = phone ? await hashPin(values.pin!) : null;
      const [u] = await sql`
        insert into users (name, email, phone, pin_hash)
        values (${values.name}, ${values.email ?? null}, ${phone}, ${pinHash}) returning id`;
      console.log(u!.id);
    } else if (cmd === "device" && sub === "add") {
      const platform = values.platform ?? "other";
      if (!values.user || !values.name) throw new Error("--user and --name are required");
      if (!["ios", "android", "other"].includes(platform)) throw new Error("--platform must be ios, android or other");
      const { token, hash } = newDeviceToken();
      const [d] = await sql`
        insert into devices (user_id, name, platform, token_hash)
        values (${values.user}, ${values.name}, ${platform}, ${hash}) returning id`;
      console.log(`device id: ${d!.id}\ntoken (shown once): ${token}`);
    } else if (cmd === "pair") {
      const platform = values.platform ?? "other";
      if (!values.user || !values.name) throw new Error("--user and --name are required");
      if (!["ios", "android", "other"].includes(platform)) throw new Error("--platform must be ios, android or other");
      const code = newPairingCode();
      await sql`
        insert into pairing_codes (code_hash, user_id, device_name, platform, expires_at)
        values (${sha256(normalizePairingCode(code))}, ${values.user}, ${values.name}, ${platform}, now() + interval '15 minutes')`;
      console.log(`pairing code (valid 15 min, single use): ${code}`);
    } else if (cmd === "user" && sub === "set-pin") {
      const phone = values.phone ? normalizePhone(values.phone) : null;
      if (!phone) throw new Error("--phone is required");
      if (!values.pin || !PIN_RE.test(values.pin)) throw new Error("--pin must be 4 digits");
      if (isWeakPin(values.pin)) throw new Error("--pin is too easy to guess (repeated, sequential or a year)");
      const r = await sql`
        update users set pin_hash = ${await hashPin(values.pin)}, pin_failures = 0, pin_locked_until = null
        where phone = ${phone}`;
      console.log(r.count ? `PIN reset for ${phone}` : `no user with phone ${phone}`);
    } else if (cmd === "device" && sub === "revoke") {
      if (!values.id) throw new Error("--id is required");
      const r = await sql`update devices set revoked_at = now() where id = ${values.id} and revoked_at is null`;
      console.log(r.count ? "revoked" : "no active device with that id");
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
