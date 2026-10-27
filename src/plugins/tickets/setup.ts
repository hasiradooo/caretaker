import {
    ChannelType,
    type Guild,
    PermissionFlagsBits,
    RESTJSONErrorCodes,
} from "discord.js";
import { UserError } from "../../shared/errors";
import type { TicketSettings } from "./config";

/** A channel selection must see permission changes made since the bot connected. */
export async function refreshTicketChannel(guild: Guild, id: string) {
    try {
        await Promise.all([
            guild.channels.fetch(id, { force: true }),
            guild.roles.fetch(),
            guild.members.fetchMe({ force: true }),
        ]);
    } catch (error) {
        if (error && typeof error === "object" && "code" in error) {
            if (error.code === RESTJSONErrorCodes.UnknownChannel)
                throw new UserError(
                    `Channel <#${id}> no longer exists. Choose another channel.`,
                );
            if (
                error.code === RESTJSONErrorCodes.MissingAccess ||
                error.code === RESTJSONErrorCodes.MissingPermissions
            )
                throw new UserError(
                    `I cannot access <#${id}>. In that channel's Permissions, allow my bot role to View Channel and Send Messages, then select it again. Check category permissions too.`,
                );
        }
        throw error;
    }
}

export async function ticketDestination(
    guild: Guild,
    id: string,
    transcript = false,
) {
    const channel = await guild.channels.fetch(id);
    if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement)
    )
        throw new UserError("Choose a server text or announcement channel.");
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const permissions = channel.permissionsFor(me);
    const required = [
        [PermissionFlagsBits.ViewChannel, "View Channel"],
        [PermissionFlagsBits.SendMessages, "Send Messages"],
        ...(transcript
            ? ([[PermissionFlagsBits.AttachFiles, "Attach Files"]] as const)
            : []),
    ] as const;
    const missing = required
        .filter(([permission]) => !permissions?.has(permission))
        .map(([, label]) => label);
    if (missing.length)
        throw new UserError(
            `I need ${missing.join(", ")} in <#${id}>. In that channel's Permissions, allow these for my bot role, then select it again. Check category permissions too.`,
        );
    if (transcript) {
        if (
            channel
                .permissionsFor(guild.roles.everyone)
                ?.has(PermissionFlagsBits.ViewChannel)
        )
            throw new UserError(
                `Choose a private transcript channel where @everyone cannot View Channel. <#${id}> is visible to @everyone.`,
            );
    }
    return channel;
}

export async function ticketParent(guild: Guild, id: string) {
    const channel = await guild.channels.fetch(id);
    if (channel?.type !== ChannelType.GuildText)
        throw new UserError(
            "Choose a server text channel for private ticket threads.",
        );
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (
        !channel
            .permissionsFor(me)
            ?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.CreatePrivateThreads,
                PermissionFlagsBits.SendMessagesInThreads,
                PermissionFlagsBits.ManageThreads,
                PermissionFlagsBits.ReadMessageHistory,
            ])
    )
        throw new UserError(
            "I need View Channel, Read Message History, Create Private Threads, Send Messages in Threads and Manage Threads in the ticket parent channel.",
        );
    return channel;
}

export async function ticketStaffRole(guild: Guild, id: string) {
    const role = await guild.roles.fetch(id);
    // Staff roles are access rules, not roles this bot assigns. Their hierarchy
    // and moderation permissions do not need automatic-role restrictions.
    if (!role || role.id === guild.id)
        throw new UserError(
            "Choose an existing staff role other than @everyone.",
        );
    return role;
}

export async function validateTicketSetup(
    guild: Guild,
    config: TicketSettings,
) {
    const parentId = config.parent_channel_id ?? config.panel_channel_id;
    if (!parentId)
        throw new UserError(
            "Choose the Ticket threads channel in /ticket settings first.",
        );
    await ticketParent(guild, parentId);
    for (const id of config.mods_role_ids) await ticketStaffRole(guild, id);
    if (config.admin_channel_id)
        await ticketDestination(guild, config.admin_channel_id);
    if (config.transcript_channel_id)
        await ticketDestination(guild, config.transcript_channel_id, true);
}
