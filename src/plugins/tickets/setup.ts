import { ChannelType, type Guild, PermissionFlagsBits } from "discord.js";
import { sendableChannel } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import type { TicketSettings } from "./config";

export async function ticketDestination(
  guild: Guild,
  id: string,
  transcript = false,
) {
  const channel = await sendableChannel(guild, id);
  if (
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(
      channel.type,
    )
  )
    throw new UserError("Choose a server text or announcement channel.");
  if (transcript) {
    if (
      channel
        .permissionsFor(guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    )
      throw new UserError(
        "Choose a private transcript channel where @everyone cannot View Channel.",
      );
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles))
      throw new UserError("I need Attach Files in the transcript channel.");
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
    throw new UserError("Choose an existing staff role other than @everyone.");
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
