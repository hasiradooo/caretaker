export interface Logger {
  debug(message: string, error?: unknown): void;
  info(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

const priorities = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(
  scope: string,
  minimum: keyof typeof priorities = "info",
  secrets: string[] = [],
): Logger {
  const redact = (text: string) =>
    secrets
      .filter(Boolean)
      .reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), text)
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
      .replace(/Bot\s+[\w.-]+/g, "Bot [REDACTED]");
  const write = (
    level: keyof typeof priorities,
    message: string,
    error?: unknown,
  ) => {
    if (priorities[level] < priorities[minimum]) return;
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : error === undefined
          ? undefined
          : String(error);
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        scope,
        message: redact(message),
        error: detail && redact(detail),
      }),
    );
  };
  return {
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}
