import { z } from "zod";
import { baseSettings, optionalId, snowflake } from "../../shared/validation";

export const counterKinds = [
    "members",
    "humans",
    "bots",
    "goal",
    "supporters",
    "boosts",
    "staff_online",
] as const;
export type CounterKind = (typeof counterKinds)[number];
export const counterDetails: Record<
    CounterKind,
    { emoji: string; label: string }
> = {
    members: { emoji: "💚", label: "Members" },
    humans: { emoji: "👤", label: "Humans" },
    bots: { emoji: "🤖", label: "Bots" },
    goal: { emoji: "🚀", label: "Goal" },
    supporters: { emoji: "💝", label: "Supporters" },
    boosts: { emoji: "💎", label: "Boosts" },
    staff_online: { emoji: "🛠️", label: "Staff Online" },
};
export const defaultCounterSeparator = "┃";
export const counterSeparatorSchema = z
    .string()
    .trim()
    .min(1, "Enter a separator.")
    .max(16, "Use a separator of up to 16 characters.")
    .refine(
        (value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value),
        "Use a separator on one line without control characters.",
    );
const roles = z.array(snowflake).max(25).default([]);
export const serverStatsSchema = z
    .object({
        ...baseSettings,
        category_id: optionalId,
        counters: z
            .array(z.enum(counterKinds))
            .max(counterKinds.length)
            .refine(
                (value) => new Set(value).size === value.length,
                "Choose each counter once.",
            )
            .default(["members"]),
        member_goal: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .nullable()
            .default(null),
        supporter_role_ids: roles,
        staff_role_ids: roles,
        separators: z
            .partialRecord(z.enum(counterKinds), counterSeparatorSchema)
            .default({}),
    })
    .passthrough();
export type ServerStatsSettings = z.infer<typeof serverStatsSchema>;
export const statsUpdateMs = 10 * 60 * 1000;

export function counterLabel(
    kind: CounterKind,
    separator = defaultCounterSeparator,
): string {
    const { emoji, label } = counterDetails[kind];
    return `${emoji} ${separator} ${label}`;
}

export function counterName(
    kind: CounterKind,
    value: number,
    separator = defaultCounterSeparator,
): string {
    return `${counterLabel(kind, separator)}: ${value}`;
}
