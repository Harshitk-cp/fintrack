import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/** Applies pending migrations in filename order, one transaction each. */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(724637)`; // serialize concurrent migrators
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select name from schema_migrations`).map((r) => r.name as string));
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(await readFile(new URL(f, MIGRATIONS_DIR), "utf8"));
      await tx`insert into schema_migrations (name) values (${f})`;
      applied.push(f);
    }
  });
  return applied;
}
