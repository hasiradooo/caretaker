import { z } from "zod";
import { baseSettings, optionalId, roleIds } from "../../shared/validation";
export const tempVoiceSchema = z
    .object({
        ...baseSettings,
        channel_id: optionalId,
        title_template: z
            .string()
            .min(1)
            .max(100)
            .default("{display_name}'s room"),
        max_duration_minutes: z
            .number()
            .int()
            .min(1)
            .max(10080)
            .nullable()
            .default(null),
        allowed_role_ids: roleIds,
        user_limit: z.number().int().min(0).max(99).default(0),
    })
    .passthrough();
