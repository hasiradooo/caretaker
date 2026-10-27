import {
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import type { Plugin } from "../../core/plugin";
import { requireManageGuild } from "../../shared/discord";
import { successCard } from "../../shared/messages";
import { serverStatsSchema } from "./config";
import { ServerStatsService } from "./service";
import { ServerStatsSettingsEditor } from "./settings-editor";

export function createServerStatsPlugin(): Plugin {
    const service = new ServerStatsService();
    const editor = new ServerStatsSettingsEditor(service);
    return {
        id: "server_stats",
        name: "Server stats",
        description:
            "Automatic locked counter channels for members, goals, supporters, boosts and staff",
        schema: serverStatsSchema,
        commands: [
            {
                data: new SlashCommandBuilder()
                    .setName("stats")
                    .setDescription("Manage automatic server stats channels")
                    .setContexts(InteractionContextType.Guild)
                    .setDefaultMemberPermissions(
                        PermissionFlagsBits.ManageGuild,
                    )
                    .addSubcommand((sub) =>
                        sub
                            .setName("settings")
                            .setDescription(
                                "Choose the stats category, counters, roles and member goal",
                            ),
                    )
                    .addSubcommand((sub) =>
                        sub
                            .setName("refresh")
                            .setDescription(
                                "Apply server stats changes now; name updates keep their interval",
                            ),
                    ),
                async execute(context, interaction) {
                    requireManageGuild(interaction);
                    if (interaction.options.getSubcommand() === "settings") {
                        await editor.open(context, interaction);
                        return;
                    }
                    await interaction.editReply(
                        successCard(
                            "Server stats",
                            await service.sync(
                                context,
                                interaction.guild,
                                true,
                            ),
                        ),
                    );
                },
            },
        ],
        async component(context, interaction) {
            if (
                (interaction.isMessageComponent() ||
                    interaction.isModalSubmit()) &&
                interaction.customId.startsWith("server_stats:editor:")
            )
                await editor.handle(context, interaction);
        },
        register(context, events) {
            events.every(60000, async () => {
                for (const guild of context.client.guilds.cache.values()) {
                    try {
                        await service.sync(context, guild);
                    } catch (error) {
                        context.log.warn(
                            `Server stats update failed for ${guild.id}`,
                            error,
                        );
                    }
                }
            });
        },
    };
}
