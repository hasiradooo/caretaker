import { z } from "zod";
import { baseSettings, optionalId, snowflake } from "../../shared/validation";
export const starboardSchema = z
  .object({
    ...baseSettings,
    emoji: z.string().trim().min(1).max(100).default("⭐"),
    channel_id: optionalId,
    threshold: z.number().int().min(1).max(1000).default(15),
    watch_channels: z.array(snowflake).max(100).nullable().default(null),
    allow_self_star: z.boolean().default(false),
    auto_react: z.boolean().default(false),
  })
  .passthrough();

export type StarboardSettings = z.infer<typeof starboardSchema>;
