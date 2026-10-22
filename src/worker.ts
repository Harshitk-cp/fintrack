import type { FastifyBaseLogger } from "fastify";
import type { Sealer } from "./crypto.ts";
import type { Sql } from "./db.ts";
import { processUnrecognized } from "./ingest.ts";
import type { SmsExtractor } from "./llm.ts";

const BATCH = 10;

/**
 * Runs the LLM fallback in the background. `kick()` is called right after an
 * unrecognized SMS arrives; the interval catches retries and missed kicks.
 */
export class LlmWorker {
  #running = false;
  #again = false;
  #run: () => ReturnType<typeof processUnrecognized>;
  #log: FastifyBaseLogger;

  constructor(sql: Sql, sealer: Sealer, extractor: SmsExtractor, timeZone: string, log: FastifyBaseLogger) {
    this.#run = () => processUnrecognized(sql, sealer, extractor, timeZone, BATCH);
    this.#log = log;
  }

  start(intervalMs = 60_000) {
    setInterval(() => this.kick(), intervalMs).unref();
    this.kick();
  }

  kick() {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void this.#drain().finally(() => {
      this.#running = false;
      if (this.#again) {
        this.#again = false;
        this.kick();
      }
    });
  }

  async #drain() {
    try {
      for (;;) {
        const r = await this.#run();
        if (r.processed || r.failed) this.#log.info(r, "llm fallback batch");
        if (r.processed + r.failed < BATCH) return;
      }
    } catch (err) {
      this.#log.error({ err }, "llm fallback failed");
    }
  }
}
