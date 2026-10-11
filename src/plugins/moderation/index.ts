import {
    Events,
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import type { Plugin } from "../../core/plugin";
import { requireManageGuild } from "../../shared/discord";
import { moderationSchema } from "./config";
import { ModerationService } from "./service";
import { ModerationSettingsEditor } from "./settings-editor";

export function createModerationPlugin(): Plugin {
    const editor = new ModerationSettingsEditor();
    let service: ModerationService | undefined;
    return {
        id: "moderation",
        name: "Moderation",
        description:
            "Custom rules for new messages and edits, including old messages",
        schema: moderationSchema,
        commands: [
            {
                data: new SlashCommandBuilder()
                    .setName("moderation")
                    .setDescription(
                        "Configure custom automatic moderation rules",
                    )
                    .setContexts(InteractionContextType.Guild)
                    .setDefaultMemberPermissions(
                        PermissionFlagsBits.ManageGuild,
                    )
                    .addSubcommand((sub) =>
                        sub
                            .setName("settings")
                            .setDescription(
                                "Build rules for message events, conditions and actions",
                            ),
                    ),
                async execute(context, interaction) {
                    requireManageGuild(interaction);
                    await editor.open(context, interaction);
                },
            },
        ],
        component: (context, interaction) =>
            editor.handle(context, interaction),
        register(context, events) {
            service = new ModerationService(context);
            const active = service;
            events.on(Events.MessageCreate, (message) =>
                active.check(message, "create"),
            );
            events.on(Events.MessageUpdate, (_before, after) =>
                active.check(after, "edit"),
            );
        },
        async stop() {
            await service?.stop();
        },
    };
}
