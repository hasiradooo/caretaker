import {
    type ChatInputCommandInteraction,
    type Guild,
    type GuildMember,
    PermissionFlagsBits,
} from "discord.js";
import { UserError } from "./errors";

export function requireManageGuild(
    interaction: Pick<
        ChatInputCommandInteraction<"cached">,
        "memberPermissions"
    >,
): void {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild))
        throw new UserError("You need Manage Server permission to do this.");
}

const privilegedPermissions = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.ModerateMembers,
];

/** Automatic and self-assignable roles must never provide server administration. */
export async function assignableRole(guild: Guild, roleId: string) {
    const role = await guild.roles.fetch(roleId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (
        !role ||
        role.id === guild.id ||
        role.managed ||
        role.comparePositionTo(me.roles.highest) >= 0 ||
        !me.permissions.has(PermissionFlagsBits.ManageRoles) ||
        role.permissions.any(privilegedPermissions)
    ) {
        throw new UserError(
            "That role cannot be assigned automatically. Check its permissions and place it below the bot's role.",
        );
    }
    return role;
}

export async function addSafeRole(
    member: GuildMember,
    roleId: string,
    reason: string,
): Promise<void> {
    if (member.roles.cache.has(roleId)) return;
    const role = await assignableRole(member.guild, roleId);
    await member.roles.add(role, reason);
}

/** Fetch through this guild, never client.channels: IDs in configuration are untrusted. */
export async function sendableChannel(guild: Guild, channelId: string) {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isSendable())
        throw new UserError(
            "The configured channel is missing or cannot receive messages.",
        );
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const sendPermission = channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
    if (
        !channel
            .permissionsFor(me)
            ?.has([PermissionFlagsBits.ViewChannel, sendPermission])
    )
        throw new UserError(
            "I cannot view or send messages in the configured channel.",
        );
    return channel;
}

export const noMentions = {
    parse: [] as ("roles" | "users" | "everyone")[],
    repliedUser: false,
};
