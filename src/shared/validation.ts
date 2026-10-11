import { z } from "zod";

export const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, "Expected a Discord ID");
export const optionalId = snowflake.nullable().default(null);
export const roleIds = z.array(snowflake).max(100).default([]);
export const messageTemplate = z.string().min(1).max(1800);
export const baseSettings = { enabled: z.boolean().default(false) };
export type Settings = { enabled: boolean; [key: string]: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Arrays replace; nested objects merge. Reject prototype keys at every depth. */
export function mergeSettings(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Unsafe configuration key");
    result[key] = isRecord(value)
      ? mergeSettings(isRecord(result[key]) ? result[key] : {}, value)
      : value;
  }
  return result;
}

export function pathPatch(
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split(".");
  if (
    parts.length > 8 ||
    parts.some(
      (part) =>
        !/^[a-z][a-z0-9_]*$/i.test(part) ||
        ["__proto__", "prototype", "constructor"].includes(part),
    )
  ) {
    throw new Error("Invalid configuration path");
  }
  return parts.reduceRight<Record<string, unknown>>(
    (nested, key, index) => ({
      [key]: index === parts.length - 1 ? value : nested,
    }),
    {},
  );
}
