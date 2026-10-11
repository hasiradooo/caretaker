import { z } from "zod";
import {
    baseSettings,
    optionalId,
    roleIds,
    snowflake,
} from "../../shared/validation";

export const MAX_LEVEL_REWARDS = 100;
export const MAX_REWARD_LEVEL = 100000;

export const levelsSchema = z
    .object({
        ...baseSettings,
        // null disables announcements; XP and role rewards remain enabled separately.
        reward_channel_id: optionalId,
        // null allows rank/leaderboard anywhere; admin setup and message XP are unaffected.
        command_channel_id: optionalId,
        xp_cooldown_seconds: z.number().int().min(1).max(86400).default(60),
        xp_gain: z
            .object({
                min: z.number().int().min(1).max(10000).default(15),
                max: z.number().int().min(1).max(10000).default(25),
            })
            .default({ min: 15, max: 25 }),
        xp_multipliers: z
            .object({
                default: z.number().min(0).max(100).default(1),
                roles: z
                    .array(
                        z.object({
                            role_id: snowflake,
                            multiplier: z.number().min(0).max(100),
                        }),
                    )
                    .max(100)
                    .default([]),
            })
            .default({ default: 1, roles: [] }),
        reward_roles: z
            .array(
                z.object({
                    role_id: snowflake,
                    // Level zero is the starter role, awarded as soon as a member joins.
                    level: z.number().int().min(0).max(MAX_REWARD_LEVEL),
                }),
            )
            .max(MAX_LEVEL_REWARDS)
            .default([]),
        ignored_channels: roleIds,
        ignored_roles: roleIds,
        reward_message: z
            .string()
            .min(1)
            .max(1800)
            .default("Congratulations {user}, you reached level {level}!"),
    })
    .passthrough()
    .refine((config) => config.xp_gain.min <= config.xp_gain.max, {
        path: ["xp_gain"],
        message: "min must not exceed max",
    });
export type LevelsSettings = z.infer<typeof levelsSchema>;
