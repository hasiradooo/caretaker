import {
  type ButtonInteraction,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { UserError } from "../../shared/errors";
import { successCard } from "../../shared/messages";
import { isTicketStaff } from "./access";
import { ticketsSchema } from "./config";
import { ticketLabel } from "./presentation";
import { TicketRepository } from "./repository";

/** Joining is an explicit staff action; opening a ticket never invites staff. */
export async function handleTicketJoin(
  context: Context,
  interaction: ButtonInteraction<"cached">,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const threadId = /^tickets:join:(\d{17,20})$/.exec(interaction.customId)?.[1];
  if (!threadId || interaction.message.author.id !== context.botId)
    throw new UserError("This ticket button is invalid.");

  // A cached interaction member may still have a staff role that was revoked.
  const member = await interaction.guild.members.fetch({
    user: interaction.user.id,
    force: true,
  });
  const config = await context.settings.get(
    interaction.guildId,
    "tickets",
    ticketsSchema,
  );
  if (!isTicketStaff(member, config))
    throw new UserError("Only ticket staff can join through this button.");

  const row = await new TicketRepository(context.db, context.botId).get(
    interaction.guildId,
    threadId,
  );
  if (!row || row.status !== "open")
    throw new UserError("This ticket is closed or no longer available.");
  // Bind the button to the original saved alert, including after settings change.
  if (
    row.staff_alert_channel_id !== interaction.channelId ||
    row.staff_alert_message_id !== interaction.message.id
  )
    throw new UserError(
      "Use the Join ticket button on the original staff alert.",
    );

  const thread = await interaction.guild.channels.fetch(row.thread_id);
  if (thread?.type !== ChannelType.PrivateThread || thread.locked)
    throw new UserError("This ticket is locked or no longer available.");
  if (
    !thread
      .permissionsFor(member)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
      ])
  )
    throw new UserError(
      "You need View Channel and Send Messages in Threads in the support channel to join this ticket.",
    );
  if (thread.archived)
    await thread.setArchived(
      false,
      "Ticket staff chose to join an ongoing ticket",
    );
  await thread.members.add(member.id);
  await interaction.editReply(
    successCard(
      `Joined ticket ${ticketLabel(row.ticket_number)}`,
      `Continue in <#${thread.id}>. Use /ticket claim there when you are ready to take responsibility.`,
    ),
  );
}
