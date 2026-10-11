import { z } from "zod";
import { baseSettings, optionalId, roleIds } from "../../shared/validation";

export const welcomeSchema = z
  .object({
    ...baseSettings,
    welcome_channel_id: optionalId,
    leave_channel_id: optionalId,
    join_role_ids: roleIds,
    welcome_message: z.string().min(1).max(1800).nullable().default(null),
    goodbye_message: z.string().min(1).max(1800).nullable().default(null),
    include_bots: z.boolean().default(false),
  })
  .passthrough();

export type WelcomeSettings = z.infer<typeof welcomeSchema>;
