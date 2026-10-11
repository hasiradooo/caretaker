import {
  ActionRowBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { Plugin } from "../../core/plugin";
import {
  assignableRole,
  requireManageGuild,
  sendableChannel,
} from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, successCard } from "../../shared/messages";
import { KeyedQueue } from "../../shared/serial";
import { rolesSchema } from "./config";

export function createRolesPlugin(): Plugin {
  const queue = new KeyedQueue();
  return {
    id: "roles",
    name: "Self roles",
    description: "Persistent role selection panels",
    schema: rolesSchema,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("roles")
          .setDescription("Publish a self-role panel in this channel")
          .setContexts(InteractionContextType.Guild)
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        async execute(context, interaction) {
          requireManageGuild(interaction);
          const config = await context.settings.get(
            interaction.guildId,
            "roles",
            rolesSchema,
          );
          if (!config.enabled || config.roles.length === 0)
            throw new UserError(
              "Enable the roles plugin and configure its roles first with /config.",
            );
          for (const item of config.roles)
            await assignableRole(interaction.guild, item.role_id);
          const menu = new StringSelectMenuBuilder()
            .setCustomId("roles:select")
            .setPlaceholder("Choose your roles")
            .setMinValues(0)
            .setMaxValues(config.roles.length)
            .addOptions(
              config.roles.map((role) => ({
                label: role.label,
                value: role.role_id,
                ...(role.description ? { description: role.description } : {}),
              })),
            );
          const channel = await sendableChannel(
            interaction.guild,
            interaction.channelId,
          );
          await channel.send(
            card({
              title: config.title,
              icon: "🎭",
              body: config.description,
              footer:
                "Choose below · Submit an empty selection to remove your self roles",
              actions: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                  menu,
                ),
              ],
            }),
          );
          await interaction.editReply(
            successCard(
              "Panel published",
              `Your role panel is ready in <#${channel.id}>.`,
            ),
          );
        },
      },
    ],
    async component(context, interaction) {
      if (
        !interaction.isStringSelectMenu() ||
        interaction.customId !== "roles:select"
      )
        return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await queue.run(
        `${interaction.guildId}:${interaction.user.id}`,
        async () => {
          const config = await context.settings.get(
            interaction.guildId,
            "roles",
            rolesSchema,
          );
          if (!config.enabled) throw new UserError("Self roles are disabled.");
          if (interaction.message.author.id !== context.botId)
            throw new UserError("This role panel is invalid.");
          const allowed = new Set(config.roles.map((item) => item.role_id));
          if (interaction.values.some((id) => !allowed.has(id)))
            throw new UserError(
              "This panel is outdated. Ask a moderator to publish it again.",
            );
          const member = await interaction.guild.members.fetch({
            user: interaction.user.id,
            force: true,
          });
          // Validate the whole selection before the first mutation. A bad role must
          // not leave the member with half of their requested changes applied.
          const roles = await Promise.all(
            [...allowed].map((id) => assignableRole(interaction.guild, id)),
          );
          // Update only configured roles, so unrelated roles survive concurrent changes.
          for (const role of roles) {
            const roleId = role.id;
            if (
              interaction.values.includes(roleId) &&
              !member.roles.cache.has(roleId)
            )
              await member.roles.add(role, "Self-role selection");
            else if (
              !interaction.values.includes(roleId) &&
              member.roles.cache.has(roleId)
            )
              await member.roles.remove(role, "Self-role selection");
          }
          await interaction.editReply(
            successCard(
              "Roles updated",
              interaction.values.length
                ? `Your selected roles:\n${interaction.values.map((id) => `<@&${id}>`).join(" · ")}`
                : "Your self roles have been cleared. You can choose new ones at any time.",
            ),
          );
        },
      );
    },
    async stop() {
      await queue.drain();
    },
  };
}
