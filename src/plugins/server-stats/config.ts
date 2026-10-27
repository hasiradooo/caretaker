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
export const counterLabels: Record<CounterKind, string> = {
    members: "💚 ┃ Members",
    humans: "👤 ┃ Humans",
    bots: "🤖 ┃ Bots",
    goal: "🚀 ┃ Goal",
    supporters: "💝 ┃ Supporters",
    boosts: "💎 ┃ Boosts",
    staff_online: "🛠️ ┃ Staff Online",
};
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
    })
    .passthrough();
export type ServerStatsSettings = z.infer<typeof serverStatsSchema>;
export const statsUpdateMs = 10 * 60 * 1000;

export function counterName(kind: CounterKind, value: number): string {
    return `${counterLabels[kind]}: ${value}`;
}
