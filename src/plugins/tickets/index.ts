import {
  Events,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Plugin } from "../../core/plugin";
import { requireManageGuild } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { successCard } from "../../shared/messages";
import { removeClosedTicketAlert } from "./alerts";
import { ticketsSchema } from "./config";
import { checkTicketInactivity } from "./inactivity";
import { handleTicketJoin } from "./joining";
import { ticketLabel, ticketPanel } from "./presentation";
import { TicketRepository } from "./repository";
import { handleTicketReview } from "./reviews";
import { closeTicket, isTicketStaff, openTicket } from "./service";
import { TicketSettingsEditor } from "./settings-editor";
import { ticketDestination, validateTicketSetup } from "./setup";
import { TranscriptRepository } from "./transcript-repository";
import { syncTicketTranscript } from "./transcripts";

const editor = new TicketSettingsEditor();

export const ticketsPlugin: Plugin = {
  id: "tickets",
  name: "Tickets",
  description:
    "Private ticket threads, staff-only closing, transcripts and inactivity closure",
  schema: ticketsSchema,
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Private support tickets")
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((sub) =>
          sub
            .setName("settings")
            .setDescription(
              "Manage Server: edit ticket channels, staff, panel and auto-close",
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("open")
            .setDescription(
              "Open your private ticket thread or return to your ongoing ticket",
            )
            .addStringOption((option) =>
              option
                .setName("topic")
                .setDescription("What do you need help with?")
                .setMaxLength(300),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("close")
            .setDescription("Staff: close this ticket")
            .addStringOption((option) =>
              option
                .setName("reason")
                .setDescription("Reason")
                .setMaxLength(300),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("claim")
            .setDescription("Staff: take responsibility for this ticket"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("panel")
            .setDescription("Manage Server: publish an open-ticket button"),
        ),
      async execute(context, interaction) {
        const action = interaction.options.getSubcommand();
        if (action === "settings") {
          await editor.open(context, interaction);
          return;
        }
        const config = await context.settings.get(
          interaction.guildId,
          "tickets",
          ticketsSchema,
        );
        if (action === "panel") {
          requireManageGuild(interaction);
          if (!config.enabled)
            throw new UserError("Enable tickets in /ticket settings first.");
          await validateTicketSetup(interaction.guild, config);
          await (
            await ticketDestination(
              interaction.guild,
              config.panel_channel_id ?? interaction.channelId,
            )
          ).send(ticketPanel(config));
          await interaction.editReply(
            successCard(
              "Support desk published",
              `Members can now open tickets from the panel in <#${config.panel_channel_id ?? interaction.channelId}>.`,
            ),
          );
          return;
        }
        if (action === "open") {
          if (!config.enabled) throw new UserError("Tickets are disabled.");
          const ticket = await openTicket(
            context,
            interaction.member,
            config,
            interaction.options.getString("topic") ?? "General support",
          );
          await interaction.editReply(
            successCard(
              `Your support ticket ${ticketLabel(ticket.ticket_number)}`,
              `Continue in <#${ticket.thread_id}>. The support team can see your messages there.`,
            ),
          );
          return;
        }
        const repository = new TicketRepository(context.db, context.botId);
        const row = await repository.get(
          interaction.guildId,
          interaction.channelId,
        );
        if (!row || row.status !== "open")
          throw new UserError("Use this inside an open ticket.");
        const staff = isTicketStaff(interaction.member, config);
        if (action === "claim") {
          if (!staff)
            throw new UserError("Only ticket staff can claim tickets.");
          if (
            !(await repository.claim(
              interaction.guildId,
              row.thread_id,
              interaction.user.id,
            ))
          )
            throw new UserError(
              "Another staff member already claimed this ticket.",
            );
          await interaction.editReply(
            successCard(
              `Ticket ${ticketLabel(row.ticket_number)} claimed`,
              "You are now responsible for this ticket.",
            ),
          );
        } else {
          if (!staff)
            throw new UserError(
              "Only ticket staff can close tickets. Ask a moderator when you are finished.",
            );
          await closeTicket(
            context,
            interaction.guild,
            row,
            config,
            interaction.user.id,
            interaction.options.getString("reason") ?? "Resolved",
          );
          await interaction.editReply(
            successCard(
              `Ticket ${ticketLabel(row.ticket_number)} closed`,
              "Its channel remains available as an archive.",
            ),
          );
        }
      },
    },
  ],
  async directMessageComponent(context, interaction) {
    if (!interaction.customId.startsWith("tickets:review:")) return false;
    await handleTicketReview(context, interaction);
    return true;
  },
  async component(context, interaction) {
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("tickets:join:")
    ) {
      await handleTicketJoin(context, interaction);
      return;
    }
    if (
      (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
      interaction.customId.startsWith("tickets:editor:")
    ) {
      await editor.handle(context, interaction);
      return;
    }
    if (!interaction.isButton() || interaction.customId !== "tickets:open")
      return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = await context.settings.get(
      interaction.guildId,
      "tickets",
      ticketsSchema,
    );
    if (!config.enabled) throw new UserError("Tickets are disabled.");
    const ticket = await openTicket(
      context,
      interaction.member,
      config,
      "General support",
    );
    await interaction.editReply(
      successCard(
        `Your support ticket ${ticketLabel(ticket.ticket_number)}`,
        `Continue in <#${ticket.thread_id}>. The support team can see your messages there.`,
      ),
    );
  },
  register(context, events) {
    const repository = new TicketRepository(context.db, context.botId);
    events.on(Events.MessageCreate, async (message) => {
      if (!message.guildId || message.author.bot) return;
      // Keep tracking replies while paused so re-enabling cannot lose activity.
      await repository.touch(
        message.guildId,
        message.channelId,
        message.author.id,
        message.createdAt,
      );
    });
    events.every(60000, async () => {
      for (const guild of context.client.guilds.cache.values()) {
        try {
          // Alert cleanup continues with tickets/automatic closure disabled.
          for (const row of await repository.pendingStaffAlerts(guild.id)) {
            await removeClosedTicketAlert(context, guild.id, row);
          }
          for (const row of await new TranscriptRepository(
            context.db,
            context.botId,
          ).pending(guild.id)) {
            await syncTicketTranscript(context, guild.id, row.thread_id);
          }
          const config = await context.settings.get(
            guild.id,
            "tickets",
            ticketsSchema,
          );
          if (!config.enabled || !config.auto_close.enabled) {
            await repository.clearWarning(guild.id);
            continue;
          }
          for (const row of await repository.open(guild.id)) {
            try {
              await checkTicketInactivity(context, guild, row, config);
            } catch (error) {
              // One inaccessible thread must not block all other tickets.
              context.log.warn(
                `Ticket inactivity check failed for ${row.thread_id}`,
                error,
              );
            }
          }
        } catch (error) {
          context.log.warn(`Ticket cleanup failed for ${guild.id}`, error);
        }
      }
    });
  },
};
