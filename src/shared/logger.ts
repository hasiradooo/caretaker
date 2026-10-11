import { stripVTControlCharacters } from "node:util";

export type LogFields = Record<string, unknown>;
export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, error?: unknown): void;
    error(message: string, error?: unknown): void;
}

const priorities = { debug: 0, info: 1, warn: 2, error: 3 };
type Level = keyof typeof priorities;
type Format = "pretty" | "json" | "auto";
export interface LoggerOptions {
    format?: Format;
    colors?: boolean;
    timeZone?: string;
    /** Inject the output and clock for tests without touching the global console. */
    write?: (line: string) => void;
    now?: () => Date;
}

function clockFormatter(timeZone?: string) {
    const options: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    };
    try {
        return new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
    } catch {
        // A misspelled optional timezone must not prevent startup/error reporting.
        return new Intl.DateTimeFormat("en-GB", options);
    }
}

export function createLogger(
    scope: string,
    minimum: Level = "info",
    secrets: string[] = [],
    options: LoggerOptions = {},
): Logger {
    // Resolve here so startup failures and standalone scripts use the same format.
    const requested = options.format ?? process.env.LOG_FORMAT ?? "pretty";
    const format =
        requested === "json" || (requested === "auto" && !process.stdout.isTTY)
            ? "json"
            : "pretty";
    const colors =
        options.colors ??
        (!!process.stdout.isTTY &&
            process.env.NO_COLOR === undefined &&
            process.env.TERM !== "dumb");
    const output = options.write ?? ((line: string) => console.log(line));
    const now = options.now ?? (() => new Date());
    const clock = clockFormatter(options.timeZone ?? process.env.LOG_TIMEZONE);
    const redact = (text: string) =>
        secrets
            .filter(Boolean)
            .reduce(
                (safe, secret) => safe.replaceAll(secret, "[REDACTED]"),
                text,
            )
            .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[DATABASE_URL]")
            // Match credentials, not ordinary phrases such as "Bot guard".
            .replace(/\bBot\s+[\w.-]{20,}/g, "Bot [REDACTED]");

    /** Redact before either renderer; nested values must never bypass redaction.
     * Circular metadata and bigint IDs should not turn a successful action into
     * a logging exception. Preserve real errors separately from ordinary fields. */
    const clean = (value: unknown): unknown => {
        const seen = new WeakSet<object>();
        try {
            const json = JSON.stringify(value, (_key, item: unknown) => {
                if (item instanceof Error)
                    return redact(`${item.name}: ${item.message}`);
                if (typeof item === "string") return redact(item);
                if (typeof item === "bigint") return item.toString();
                if (typeof item === "object" && item !== null) {
                    if (seen.has(item)) return "[Circular]";
                    seen.add(item);
                }
                return item;
            });
            return json === undefined ? undefined : JSON.parse(json);
        } catch {
            return "[Unserializable log value]";
        }
    };
    const terminalText = (value: string) =>
        Array.from(stripVTControlCharacters(value.replace(/\r\n?/g, "\n")))
            .filter(
                (char) =>
                    char === "\n" ||
                    (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
            )
            .join("");
    const tint = (code: number, text: string) =>
        colors ? `\x1b[${code}m${text}\x1b[0m` : text;
    const detailLines = (label: string, value: unknown) => {
        const text =
            typeof value === "string" ? value : JSON.stringify(value, null, 2);
        if (text === undefined) return [];
        const lines = terminalText(text).split("\n");
        return lines.map(
            (line, index) =>
                `  ${index === 0 && label ? `${label}: ` : ""}${line}`,
        );
    };
    const write = (
        level: Level,
        message: string,
        error?: unknown,
        fields?: LogFields,
    ) => {
        if (priorities[level] < priorities[minimum]) return;
        const date = now();
        const entry = {
            time: date.toISOString(),
            level,
            scope: redact(scope),
            message: redact(message),
            ...(error === undefined ? {} : { error: clean(error) }),
            ...(fields === undefined ? {} : { fields: clean(fields) }),
        };
        if (format === "json") {
            output(JSON.stringify(entry));
            return;
        }
        const parts = Object.fromEntries(
            clock.formatToParts(date).map(({ type, value }) => [type, value]),
        );
        const time = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
        const messages = terminalText(entry.message).split("\n");
        const lines = [
            `${tint(90, time)}  ${tint({ debug: 90, info: 36, warn: 33, error: 31 }[level], level.toUpperCase().padEnd(5))}  ${tint(90, terminalText(entry.scope).replaceAll("\n", " "))}  ${messages[0] ?? ""}`,
            ...messages.slice(1).map((line) => `  ${line}`),
        ];
        if (entry.fields !== undefined) {
            if (
                entry.fields !== null &&
                typeof entry.fields === "object" &&
                !Array.isArray(entry.fields)
            ) {
                for (const [key, value] of Object.entries(entry.fields)) {
                    const label =
                        key === "detail"
                            ? ""
                            : key === "guildId"
                              ? "Server"
                              : terminalText(redact(key)).replaceAll("\n", " ");
                    lines.push(...detailLines(label, value));
                }
            } else lines.push(...detailLines("Details", entry.fields));
        }
        if (entry.error !== undefined)
            lines.push(
                ...detailLines(
                    typeof entry.error === "string" ? "" : "Error",
                    entry.error,
                ),
            );
        output(lines.join("\n"));
    };
    return {
        debug: (message, fields) => write("debug", message, undefined, fields),
        info: (message, fields) => write("info", message, undefined, fields),
        warn: (message, error) => write("warn", message, error),
        error: (message, error) => write("error", message, error),
    };
}
