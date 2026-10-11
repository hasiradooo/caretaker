import { z } from "zod";
import { baseSettings, roleIds } from "../../shared/validation";
export const botGuardSchema = z
  .object({
    ...baseSettings,
    watch_roles: roleIds,
    allowed_bot_ids: roleIds,
    ban_check_interval_minutes: z.number().int().min(1).max(1440).default(60),
    delete_message_days: z.number().int().min(0).max(7).default(0),
  })
  .passthrough();
