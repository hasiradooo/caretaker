import { isRecord } from "../shared/validation";

/**
 * Decode legacy double-encoded JSON before it can be spread as an object.
 * Earlier versions also spread JSON text into numeric character keys. Recover
 * the embedded object and overlay the most recently saved named fields.
 * Never replace malformed data with empty settings: fail without writing it.
 */
export function storedJsonObject(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth > 16)
    throw new Error("Stored JSON exceeds the recovery depth limit");
  if (typeof value === "string") {
    try {
      return storedJsonObject(JSON.parse(value), depth + 1);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("Stored JSON contains invalid text");
      throw error;
    }
  }
  if (!isRecord(value)) throw new Error("Stored JSON must be an object");
  const keys = Object.keys(value);
  const characters = keys.filter((key) => /^(0|[1-9]\d*)$/.test(key));
  // Only the exact signature of a spread JSON object is repaired. Ordinary
  // numeric legacy keys are left alone unless their characters start with '{'.
  if (characters.length && value["0"] === "{") {
    characters.sort((a, b) => Number(a) - Number(b));
    if (
      characters.some(
        (key, index) =>
          key !== String(index) ||
          typeof value[key] !== "string" ||
          value[key].length !== 1,
      )
    )
      throw new Error("Stored JSON character sequence is incomplete");
    const recovered = storedJsonObject(
      characters.map((key) => value[key]).join(""),
      depth + 1,
    );
    const named = Object.fromEntries(
      keys
        .filter((key) => !/^(0|[1-9]\d*)$/.test(key))
        .map((key) => [key, value[key]]),
    );
    return { ...recovered, ...named };
  }
  return value;
}
