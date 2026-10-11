import { Events } from "discord.js";
import type { Plugin } from "../../core/plugin";
import { addSafeRole, sendableChannel } from "../../shared/discord";
import { greetingCommand } from "./commands";
import { welcomeSchema } from "./config";
import { greetingCard } from "./presentation";
import { WelcomeSettingsEditor } from "./settings-editor";

const editor = new WelcomeSettingsEditor();

export const welcomePlugin: Plugin = {
    id: "welcome_goodbye",
    name: "Welcome & goodbye",
    description: "Join messages, farewell messages and automatic join roles",
    schema: welcomeSchema,
    commands: [
        greetingCommand("welcome", editor),
        greetingCommand("goodbye", editor),
    ],
    component: (context, interaction) => editor.handle(context, interaction),
    register(context, events) {
        events.on(Events.GuildMemberAdd, async (member) => {
            const config = await context.settings.get(
                member.guild.id,
                "welcome_goodbye",
                welcomeSchema,
            );
            if (!config.enabled || (member.user.bot && !config.include_bots))
                return;
            for (const roleId of config.join_role_ids) {
                try {
                    await addSafeRole(
                        member,
                        roleId,
                        "Configured welcome role",
                    );
                } catch (error) {
                    context.log.warn(
                        `Could not assign welcome role ${roleId}`,
                        error,
                    );
                }
            }
            if (!config.welcome_channel_id) return;
            const channel = await sendableChannel(
                member.guild,
                config.welcome_channel_id,
            );
            await channel.send(greetingCard(config, "welcome", member));
        });
        events.on(Events.GuildMemberRemove, async (member) => {
            const config = await context.settings.get(
                member.guild.id,
                "welcome_goodbye",
                welcomeSchema,
            );
            if (
                !config.enabled ||
                !config.leave_channel_id ||
                (member.user.bot && !config.include_bots)
            )
                return;
            const channel = await sendableChannel(
                member.guild,
                config.leave_channel_id,
            );
            await channel.send(greetingCard(config, "goodbye", member));
        });
    },
};
