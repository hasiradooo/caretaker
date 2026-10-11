import { z } from "zod";
import { baseSettings, snowflake } from "../../shared/validation";
export const slowmodeSchema = z
  .object({
    ...baseSettings,
    watch_channels: z.array(snowflake).max(100).nullable().default(null),
    message_threshold: z.number().int().min(2).max(1000).default(10),
    window_seconds: z.number().int().min(1).max(300).default(10),
    slowmode_duration_ms: z
      .number()
      .int()
      .min(1000)
      .max(86400000)
      .default(10000),
    rates: z
      .object({
        high: z.number().int().min(1).max(21600).default(6),
        low: z.number().int().min(0).max(21600).default(2),
      })
      .default({ high: 6, low: 2 }),
  })
  .passthrough();
