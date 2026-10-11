import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import type { Environment } from "../config/environment";

export type Parameter = string | number | boolean | Date | null;
export interface Database {
    query<T extends object = Record<string, unknown>>(
        statement: string,
        parameters?: Parameter[],
    ): Promise<T[]>;
    transaction<T>(
        operation: (transaction: Database) => Promise<T>,
    ): Promise<T>;
    close(): Promise<void>;
}

export function connectDatabase(
    env: Pick<
        Environment,
        | "DATABASE_URL"
        | "DATABASE_SSL"
        | "DATABASE_CA_FILE"
        | "DATABASE_POOL_SIZE"
    >,
): Database {
    const hostname = new URL(env.DATABASE_URL).hostname;
    const bundledCertificate = resolve("certs/supabase-root-2021.crt");
    const caFile =
        env.DATABASE_CA_FILE ??
        ((hostname.endsWith(".supabase.co") ||
            hostname.endsWith(".pooler.supabase.com")) &&
        existsSync(bundledCertificate)
            ? bundledCertificate
            : undefined);
    const sql = postgres(env.DATABASE_URL, {
        max: env.DATABASE_POOL_SIZE,
        prepare: false,
        idle_timeout: 20,
        connect_timeout: 10,
        ssl:
            env.DATABASE_SSL === "disable"
                ? false
                : {
                      rejectUnauthorized: true,
                      ...(caFile ? { ca: readFileSync(caFile, "utf8") } : {}),
                  },
        connection: { application_name: "caretaker", statement_timeout: 15000 },
    });
    const wrap = (
        connection: postgres.Sql | postgres.TransactionSql,
    ): Database => ({
        async query<T extends object>(
            statement: string,
            parameters: Parameter[] = [],
        ) {
            return Array.from(
                await connection.unsafe<T[]>(statement, parameters),
            );
        },
        async transaction<T>(
            operation: (transaction: Database) => Promise<T>,
        ): Promise<T> {
            if (!("begin" in connection)) return operation(wrap(connection));
            // Box the result: postgres.js applies special array handling to transaction returns.
            const result = await connection.begin(async (tx) => ({
                value: await operation(wrap(tx)),
            }));
            return result.value;
        },
        async close() {
            await sql.end({ timeout: 5 });
        },
    });
    return wrap(sql);
}
