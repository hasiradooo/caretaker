import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import type { Plugin } from "../../core/plugin";
import { sendableChannel } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, successCard } from "../../shared/messages";
import { birthdaySchema } from "./config";
import { localDate } from "./dates";
import { birthdayCard } from "./presentation";
import { BirthdayRepository } from "./repository";
import { BirthdaySettingsEditor } from "./settings-editor";

const editor = new BirthdaySettingsEditor();

export const birthdayPlugin: Plugin = {
  id: "birthday",
  name: "Birthdays",
  description: "Opt-in birthday reminders in each server's time zone",
  schema: birthdaySchema,
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName("birthday")
        .setDescription("Manage your birthday")
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((sub) =>
          sub
            .setName("settings")
            .setDescription(
              "Manage Server: edit birthday channel, message and schedule",
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription(
              "Opt in to birthday celebrations (year is optional)",
            )
            .addIntegerOption((option) =>
              option
                .setName("day")
                .setDescription("Day")
                .setMinValue(1)
                .setMaxValue(31)
                .setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName("month")
                .setDescription("Month")
                .setMinValue(1)
                .setMaxValue(12)
                .setRequired(true),
            )
            .addIntegerOption((option) =>
              option
                .setName("year")
                .setDescription(
                  "Optional birth year; never included in announcements",
                )
                .setMinValue(1900),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("show")
            .setDescription("Privately view your saved birthday"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Delete your birthday and opt out"),
        ),
      async execute(context, interaction) {
        const action = interaction.options.getSubcommand();
        if (action === "settings") {
          await editor.open(context, interaction);
          return;
        }
        const repository = new BirthdayRepository(context.db, context.botId);
        // Removal remains available even after the server disables this plugin.
        if (action === "remove") {
          await repository.remove(interaction.guildId, interaction.user.id);
          await interaction.editReply(
            successCard(
              "Birthday removed",
              "Your saved birthday has been deleted for this server.",
            ),
          );
          return;
        }
        if (action === "show") {
          const row = await repository.get(
            interaction.guildId,
            interaction.user.id,
          );
          await interaction.editReply(
            card({
              title: "Your birthday",
              icon: "🎂",
              body: row
                ? `Your birthday: ${row.day}/${row.month}${row.year ? `/${row.year}` : ""}.`
                : "You have not saved a birthday.",
              footer: "Only you can see this · Use /birthday remove to opt out",
            }),
          );
          return;
        }
        const config = await context.settings.get(
          interaction.guildId,
          "birthday",
          birthdaySchema,
        );
        if (!config.enabled)
          throw new UserError("Birthday celebrations are disabled here.");
        await repository.set(interaction.guildId, interaction.user.id, {
          day: interaction.options.getInteger("day", true),
          month: interaction.options.getInteger("month", true),
          year: interaction.options.getInteger("year"),
        });
        await interaction.editReply(
          successCard(
            "Birthday saved",
            "You are on the celebration calendar for this server.\nUse `/birthday remove` to opt out at any time.",
          ),
        );
      },
    },
  ],
  component: (context, interaction) => editor.handle(context, interaction),
  register(context, events) {
    const repository = new BirthdayRepository(context.db, context.botId);
    events.every(60000, async () => {
      for (const guild of context.client.guilds.cache.values()) {
        try {
          const config = await context.settings.get(
            guild.id,
            "birthday",
            birthdaySchema,
          );
          if (!config.enabled || !config.channel_id) continue;
          const today = localDate(new Date(), config.timezone);
          if (today.hour < config.hour) continue;
          for (const row of await repository.onDate(
            guild.id,
            today.month,
            today.day,
          )) {
            const member = await guild.members
              .fetch(row.user_id)
              .catch(() => null);
            if (!member || member.user.bot) continue;
            const channel = await sendableChannel(guild, config.channel_id);
            const key = `${today.key}:${row.user_id}`;
            if (!(await context.state.claim(guild.id, "birthday", key, 172800)))
              continue;
            // Claim before sending to prevent duplicate announcements after restart.
            // A crash between claim and send may skip one greeting; documented tradeoff.
            await channel.send(birthdayCard(config, member));
          }
        } catch (error) {
          context.log.warn(
            `Birthday check failed for guild ${guild.id}`,
            error,
          );
        }
      }
    });
  },
};
