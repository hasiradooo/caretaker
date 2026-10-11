import { z } from "zod";
import { baseSettings, optionalId, roleIds } from "../../shared/validation";
export const botGuardSchema = z
  .object({
    ...baseSettings,
    // Opt-in for future joins only. Never retroactively ban every installed bot.
    ban_on_join: z.boolean().default(false),
    // Keep existing servers bot-only until an admin explicitly broadens role bans.
    quarantine_targets: z.enum(["bots", "all"]).default("bots"),
    log_channel_id: optionalId,
    watch_roles: roleIds,
    allowed_bot_ids: roleIds,
    ban_check_interval_minutes: z.number().int().min(1).max(1440).default(60),
    delete_message_days: z.number().int().min(0).max(7).default(0),
  })
  .passthrough();
