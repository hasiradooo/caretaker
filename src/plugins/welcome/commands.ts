import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandChannelOption,
  type SlashCommandStringOption,
} from "discord.js";
import type { Command } from "../../core/plugin";
import { requireManageGuild, sendableChannel } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { welcomeSchema } from "./config";
import { type GreetingKind, greetingFields } from "./presentation";
import type { WelcomeSettingsEditor } from "./settings-editor";

/** Both greeting types expose the same menu and patch only their own fields. */
export function greetingCommand(
  kind: GreetingKind,
  editor: WelcomeSettingsEditor,
): Command {
  const fields = greetingFields[kind];
  const channelOption = (option: SlashCommandChannelOption) =>
    option
      .setName("channel")
      .setDescription(`Destination for ${kind} messages`)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true);
  const messageOption = (option: SlashCommandStringOption) =>
    option
      .setName("message")
      .setDescription(
        "Template: {user}, {display_name}, {server}, {member_count}",
      )
      .setMinLength(1)
      .setMaxLength(1800);

  return {
    data: new SlashCommandBuilder()
      .setName(kind)
      .setDescription(`Manage ${kind} messages, channels, and previews`)
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName("settings")
          .setDescription(
            `Open the ${kind} editor with buttons and text inputs`,
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription(
            `Set the ${kind} channel and enable greetings; optionally replace its message`,
          )
          .addChannelOption(channelOption)
          .addStringOption(messageOption),
      )
      .addSubcommand((sub) =>
        sub
          .setName("channel")
          .setDescription(
            `Change the ${kind} channel without changing paused/enabled status`,
          )
          .addChannelOption(channelOption),
      )
      .addSubcommand((sub) =>
        sub
          .setName("message")
          .setDescription(`Replace the ${kind} message template`)
          .addStringOption((option) => messageOption(option).setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("preview")
          .setDescription(`Privately preview the saved ${kind} message`),
      ),
    async execute(context, interaction) {
      requireManageGuild(interaction);
      const action = interaction.options.getSubcommand(false);
      if (action === "settings" || action === "preview") {
        await editor.open(
          context,
          interaction,
          kind,
          undefined,
          action === "preview" ? "preview" : "home",
        );
        return;
      }
      if (action !== null && !["set", "channel", "message"].includes(action))
        throw new UserError(
          `This command is outdated. Open /${kind} settings again.`,
        );

      // Cached Discord command menus may briefly use the old flat arguments.
      const channel = interaction.options.getChannel(
        "channel",
        action === "set" || action === "channel",
      );
      const message = interaction.options.getString(
        "message",
        action === "message",
      );
      if (!channel && message === null) {
        await editor.open(context, interaction, kind);
        return;
      }
      if (channel) {
        const selected = await sendableChannel(interaction.guild, channel.id);
        if (
          selected.type !== ChannelType.GuildText &&
          selected.type !== ChannelType.GuildAnnouncement
        )
          throw new UserError("Choose a server text or announcement channel.");
      }
      if (message !== null && !message.trim())
        throw new UserError(`The ${kind} message cannot be blank.`);
      const enable = Boolean(channel && (action === "set" || action === null));
      await context.settings.patch(
        interaction.guildId,
        "welcome_goodbye",
        welcomeSchema,
        {
          ...(enable ? { enabled: true } : {}),
          ...(channel ? { [fields.channel]: channel.id } : {}),
          ...(message !== null ? { [fields.message]: message.trim() } : {}),
        },
      );
      await editor.open(
        context,
        interaction,
        kind,
        enable
          ? `✓ Greetings enabled. ${fields.label} messages will use <#${channel?.id}>.`
          : channel
            ? `✓ ${fields.label} channel saved. Greetings remain enabled or paused as before.`
            : `✓ ${fields.label} message saved.`,
      );
    },
  };
}
