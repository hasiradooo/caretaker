import { type GuildMember, PermissionFlagsBits } from "discord.js";
import type { TicketSettings } from "./config";

export function isTicketStaff(
    member: GuildMember,
    config: TicketSettings,
): boolean {
    return (
        member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        config.mods_role_ids.some((role) => member.roles.cache.has(role))
    );
}
