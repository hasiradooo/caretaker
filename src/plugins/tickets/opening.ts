import {
  ChannelType,
  type GuildMember,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { noMentions, sendableChannel } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card } from "../../shared/messages";
import { KeyedQueue } from "../../shared/serial";
import { isTicketStaff } from "./access";
import { removeClosedTicketAlert } from "./alerts";
import type { TicketSettings } from "./config";
import { ticketLabel, ticketThreadName } from "./presentation";
import { TicketRepository, type TicketRow } from "./repository";
import { ticketParent, ticketStaffRole } from "./setup";

// Button and slash-command requests share this queue. The database's partial
// unique index also enforces one ongoing ticket across processes and restarts.
const opening = new KeyedQueue();
export function openTicket(
  context: Context,
  member: GuildMember,
  config: TicketSettings,
  topic: string,
): Promise<TicketRow> {
  return opening.run(`${context.botId}:${member.guild.id}:${member.id}`, () =>
    openPrivateTicket(context, member, config, topic),
  );
}

async function openPrivateTicket(
  context: Context,
  member: GuildMember,
  config: TicketSettings,
  topic: string,
): Promise<TicketRow> {
  const repository = new TicketRepository(context.db, context.botId);
  const existing = (await repository.open(member.guild.id, member.id))[0];
  if (existing) {
    // Discord auto-archiving is not staff closure and never releases this slot.
    const channel = await member.guild.channels.fetch(existing.thread_id);
    if (!channel)
      throw new UserError(
        "Your ongoing ticket is unavailable. Ask ticket staff to check it.",
      );
    if (channel.isThread() && !channel.locked) {
      if (channel.archived)
        await channel.setArchived(
          false,
          "Member returned to an ongoing ticket",
        );
      if (channel.type === ChannelType.PrivateThread)
        await channel.members.add(member.id);
    }
    return existing;
  }
  const parentId = config.parent_channel_id ?? config.panel_channel_id;
  if (!parentId)
    throw new UserError(
      "Ask a server administrator to choose the Ticket threads channel in /ticket settings.",
    );
  const parent = await ticketParent(member.guild, parentId);
  const participantPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessagesInThreads,
  ];
  if (!parent.permissionsFor(member)?.has(participantPermissions))
    throw new UserError(
      "You need View Channel and Send Messages in Threads in the support channel to use tickets.",
    );
  const roleIds = [...new Set(config.mods_role_ids)];
  for (const id of roleIds) await ticketStaffRole(member.guild, id);

  // Private threads cannot grant access to a role. Fetch the complete roster,
  // then add only the opener and current staff members, never the whole server.
  const roster = await member.guild.members.fetch();
  const staff = roster.filter(
    (candidate) => !candidate.user.bot && isTicketStaff(candidate, config),
  );
  for (const candidate of staff.values()) {
    if (!parent.permissionsFor(candidate)?.has(participantPermissions))
      throw new UserError(
        "Ticket staff need View Channel and Send Messages in Threads in the support channel. Ask an administrator to update its permissions.",
      );
  }
  const thread = await parent.threads.create({
    name: `ticket-${member.user.username.replace(/[^a-z0-9-]/gi, "").slice(0, 30) || "member"}`,
    type: ChannelType.PrivateThread,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    invitable: false,
    reason: "Member opened a private support ticket",
  });
  try {
    for (const id of new Set([member.id, ...staff.keys()])) {
      if (id !== context.botId) await thread.members.add(id);
    }
  } catch (error) {
    await thread
      .delete("Ticket setup failed")
      .catch((cleanupError) =>
        context.log.warn(
          "Could not remove incomplete ticket thread",
          cleanupError,
        ),
      );
    throw error;
  }
  let ticket: TicketRow;
  try {
    ticket = await repository.create(
      member.guild.id,
      thread.id,
      member.id,
      topic,
    );
  } catch (error) {
    // A network error can arrive after an insert committed. Check its outcome
    // before removing the thread; never delete a successfully recorded ticket.
    const winner = (await repository.open(member.guild.id, member.id))[0];
    if (winner?.thread_id !== thread.id) {
      await thread
        .delete("Ticket registration failed")
        .catch((cleanupError) =>
          context.log.warn(
            "Could not remove unregistered ticket thread",
            cleanupError,
          ),
        );
      if (winner) return winner;
      throw error;
    }
    ticket = winner;
  }

  // Numbering is committed before it reaches Discord. A failed name update must
  // not discard a valid ticket; its cards and transcript still contain the ID.
  await thread
    .setName(ticketThreadName(ticket.ticket_number, member.user.username))
    .catch((error) =>
      context.log.warn(
        `Could not name ticket ${ticketLabel(ticket.ticket_number)} (${thread.id})`,
        error,
      ),
    );
  const label = ticketLabel(ticket.ticket_number);

  const staffLine = roleIds.length
    ? `**Ticket staff:** ${roleIds.map((id) => `<@&${id}>`).join(" ")}`
    : "**Ticket staff:** server administrators";
  if (config.admin_channel_id) {
    try {
      const alerts = await sendableChannel(
        member.guild,
        config.admin_channel_id,
      );
      const alert = await alerts.send({
        ...card({
          title: `New support ticket ${label}`,
          icon: "📬",
          body: `${staffLine}\n\n<@${member.id}> opened <#${thread.id}>.`,
          sections: [`### Topic\n${topic}`],
          footer: "Staff: use /ticket claim or /ticket close inside the thread",
        }),
        // Never allow topic text to ping unrelated users, roles or @everyone.
        allowedMentions: { ...noMentions, roles: roleIds },
      });
      try {
        const saved = await repository.saveStaffAlert(
          member.guild.id,
          thread.id,
          alerts.id,
          alert.id,
        );
        await removeClosedTicketAlert(context, member.guild.id, saved);
      } catch (error) {
        // Do not leave an untracked alert behind when its ID could not be saved.
        await alert
          .delete()
          .catch((cleanupError) =>
            context.log.warn(
              "Could not remove untracked ticket alert",
              cleanupError,
            ),
          );
        throw error;
      }
    } catch (error) {
      context.log.warn("Could not send ticket staff notification", error);
    }
  }
  await thread.send({
    ...card({
      title: `Your ticket ${label} is open`,
      icon: "🎫",
      thumbnail: member.displayAvatarURL(),
      body: `<@${member.id}>, describe what you need and the support team will help you here.`,
      sections: [`### Topic\n${topic}`],
      footer: "One ongoing ticket per person · Only ticket staff can close it",
    }),
    // Only the opener is mentioned here. Staff notifications belong exclusively
    // in the configured alerts channel, even when that destination is unavailable.
    allowedMentions: {
      ...noMentions,
      users: [member.id],
      roles: [],
    },
  });
  return ticket;
}
