import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import type { PGlite } from "@electric-sql/pglite";

type Result = { rows: unknown[]; count: number };
type Adapter = {
  query: (statement: string, values: unknown[]) => Promise<Result>;
  transaction: <T>(work: (adapter: Adapter) => Promise<T>) => Promise<T>;
};
type Statement = { sql: string; values: unknown[]; first: <T>() => Promise<T | null>; all: <T>() => Promise<{ results: T[] }>; run: () => Promise<Result> };
const state = globalThis as typeof globalThis & { walshkenPg?: Adapter; walshkenLocal?: Promise<Adapter> };

async function postgresQuery(connection: PoolClient, statement: string, values: unknown[]): Promise<Result> {
  const result = await connection.query(statement, values);
  return { rows: result.rows, count: result.rowCount ?? 0 };
}

export function databaseAtCapacity(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "53300";
}

async function connect(pool: Pool) {
  async function acquire() {
    const client = await pool.connect();
    if (process.env.VERCEL_ENV !== "preview" || process.env.WALSHKEN_CLIENT_PORTAL_ENABLED !== "1") return client;
    try {
      const {rows: [scope]} = await client.query("SELECT current_schema() AS schema_name, current_user AS login_name");
      const expected = process.env.WALSHKEN_CLIENT_PREVIEW_SCHEMA;
      if (!expected || scope?.schema_name !== expected || scope?.login_name !== `${expected}_runtime`) {
        throw new Error("Client Portal Preview is missing an isolated database connection");
      }
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
  for (const delay of [250, 750, 1_500]) {
    try {
      return await acquire();
    } catch (error) {
      if (!databaseAtCapacity(error)) throw error;
      await wait(delay + Math.floor(Math.random() * 250));
    }
  }
  return acquire();
}

function postgresAdapter(pool: Pool): Adapter {
  return {
    async query(statement, values) {
      const client = await connect(pool);
      try {
        const result = await postgresQuery(client, statement, values);
        client.release();
        return result;
      } catch (error) {
        client.release(true);
        throw error;
      }
    },
    async transaction(work) {
      const client = await connect(pool);
      const transaction: Adapter = {
        query: (statement, values) => postgresQuery(client, statement, values),
        transaction: (nestedWork) => nestedWork(transaction),
      };
      try {
        await client.query("BEGIN");
        const result = await work(transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function pooledPostgres(url: string) {
  const ca = process.env.WALSHKEN_DATABASE_CA?.trim();
  const preview = process.env.VERCEL_ENV === "preview";
  const config: import("pg").PoolConfig = { connectionString: url };
  if (ca) {
    const connection = new URL(url);
    // pg lets SSL options in the URL override the configured CA.
    for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      connection.searchParams.delete(key);
    }
    config.connectionString = connection.toString();
    config.ssl = { ca, rejectUnauthorized: true };
  }
  const pool = new Pool({
    ...config,
    max: preview ? 1 : 3,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: preview ? 1_500 : 5_000,
    maxLifetimeSeconds: 60,
  });
  pool.on("error", (error) => console.error("Walshken idle database connection failed", error.name));
  attachDatabasePool(pool);
  return postgresAdapter(pool);
}

type PgliteConnection = Pick<PGlite, "query"> & Partial<Pick<PGlite, "transaction">>;
function pgliteAdapter(connection: PgliteConnection): Adapter {
  return {
    async query(sql, values) {
      const result = await connection.query(sql, values);
      return { rows: result.rows, count: result.affectedRows ?? 0 };
    },
    async transaction(work) {
      return connection.transaction ? connection.transaction((transaction) => work(pgliteAdapter(transaction))) : work(pgliteAdapter(connection));
    },
  };
}

async function localAdapter() {
  const { PGlite } = await import("@electric-sql/pglite");
  const connection = new PGlite();
  await connection.exec("CREATE TABLE IF NOT EXISTS walshken_migrations (name text PRIMARY KEY)");
  for (const directory of ["drizzle","supabase/migrations"]) {
  for (const file of (await readdir(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ process.cwd(), directory)).catch(()=>[])).filter((name) => name.endsWith(".sql")).sort()) {
    await connection.transaction(async (transaction) => {
      if ((await transaction.query("SELECT name FROM walshken_migrations WHERE name=$1", [file])).rows.length) return;
      const sql = await readFile(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ process.cwd(), directory, file), "utf8");
      for (const part of sql.split("--> statement-breakpoint")) if (part.trim()) await transaction.exec(part);
      await transaction.query("INSERT INTO walshken_migrations (name) VALUES ($1)", [file]);
    });
  }
  }
  return pgliteAdapter(connection);
}

export class Db {
  constructor(private driver: () => Promise<Adapter>) {}
  prepare(statement: string, values: unknown[]): Statement {
    let parameter = 0;
    const sql = statement.replace(/\?/g, () => `$${++parameter}`);
    const execute = async () => (await this.driver()).query(sql, values);
    return {
      sql, values,
      async first<T>() { return ((await execute()).rows[0] as T | undefined) ?? null; },
      async all<T>() { return { results: (await execute()).rows as T[] }; },
      run: execute,
    };
  }
  async transaction<T>(work: (db: Db) => Promise<T>) {
    return (await this.driver()).transaction((driver) => work(new Db(async () => driver)));
  }
  async batch(statements: Statement[]) {
    return (await this.driver()).transaction(async (transaction) => {
      const results: Result[] = [];
      for (const { sql, values } of statements) results.push(await transaction.query(sql, values));
      return results;
    });
  }
}
export function workspaceDatabase() {
  const url = process.env.DATABASE_URL;
  if (url) {
    return new Db(async () => state.walshkenPg ??= pooledPostgres(url));
  }
  if (process.env.NODE_ENV === "test") {
    return new Db(() => state.walshkenLocal ??= localAdapter());
  }
  return null;
}
