import {
    Events,
    type GuildMember,
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import type { Plugin } from "../../core/plugin";
import { requireManageGuild } from "../../shared/discord";
import { KeyedQueue } from "../../shared/serial";
import { moderationLog } from "../moderation/log";
import { botGuardSchema } from "./config";
import { BotGuardSettingsEditor } from "./settings-editor";

export function createBotGuardPlugin(now: () => number = Date.now): Plugin {
    const lastChecks = new Map<string, number>();
    const queue = new KeyedQueue();
    const editor = new BotGuardSettingsEditor();
    return {
        id: "auto_ban_bots",
        name: "Bot guard",
        description:
            "Ban accounts with quarantine roles and optionally unapproved bot joins",
        schema: botGuardSchema,
        commands: [
            {
                data: new SlashCommandBuilder()
                    .setName("botguard")
                    .setDescription(
                        "Configure quarantine role bans and bot join protection",
                    )
                    .setContexts(InteractionContextType.Guild)
                    .setDefaultMemberPermissions(
                        PermissionFlagsBits.ManageGuild,
                    )
                    .addSubcommand((sub) =>
                        sub
                            .setName("settings")
                            .setDescription(
                                "Edit allowed accounts, join protection and quarantine roles",
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
            async function check(
                candidate: GuildMember,
                joining = false,
            ): Promise<void> {
                if (
                    candidate.id === context.botId ||
                    candidate.id === candidate.guild.ownerId
                )
                    return;
                await queue.run(
                    `${candidate.guild.id}:${candidate.id}`,
                    async () => {
                        const config = await context.settings.get(
                            candidate.guild.id,
                            "auto_ban_bots",
                            botGuardSchema,
                        );
                        if (
                            !config.enabled ||
                            config.allowed_bot_ids.includes(candidate.id)
                        )
                            return;
                        const hasQuarantineRole = (member: GuildMember) =>
                            (member.user.bot ||
                                config.quarantine_targets === "all") &&
                            config.watch_roles.some(
                                (id) =>
                                    id !== member.guild.id &&
                                    member.roles.cache.has(id),
                            );
                        const matches = (member: GuildMember) =>
                            (joining &&
                                config.ban_on_join &&
                                member.user.bot) ||
                            hasQuarantineRole(member);
                        if (!matches(candidate)) return;

                        // Events and paged scans can race with role removal or a member leaving.
                        // Re-read a matching member immediately before deciding to ban.
                        const member = await candidate.guild.members
                            .fetch({
                                user: candidate.id,
                                force: true,
                                cache: false,
                            })
                            .catch((error: unknown) => {
                                if (
                                    typeof error === "object" &&
                                    error !== null &&
                                    "code" in error &&
                                    error.code === 10007
                                )
                                    return null;
                                throw error;
                            });
                        if (!member || !matches(member)) return;
                        const quarantined = hasQuarantineRole(member);
                        const me =
                            member.guild.members.me ??
                            (await member.guild.members.fetchMe());
                        if (
                            !member.bannable ||
                            !me.permissions.has(PermissionFlagsBits.BanMembers)
                        ) {
                            context.log.warn(
                                `Bot guard cannot ban ${member.id} in ${member.guild.id}; check Ban Members and role hierarchy`,
                            );
                            return;
                        }
                        const key = `ban:${member.id}:${member.joinedTimestamp ?? 0}`;
                        if (
                            !(await context.state.claim(
                                member.guild.id,
                                "auto_ban_bots",
                                key,
                                3600,
                            ))
                        )
                            return;
                        const reason = quarantined
                            ? "Bot guard: configured quarantine role"
                            : "Bot guard: unapproved bot joined";
                        try {
                            await member.ban({
                                reason,
                                deleteMessageSeconds:
                                    config.delete_message_days * 86400,
                            });
                        } catch (error) {
                            await context.state.release(
                                member.guild.id,
                                "auto_ban_bots",
                                key,
                            );
                            throw error;
                        }
                        await moderationLog(
                            context,
                            member.guild,
                            config.log_channel_id,
                            member.user.bot
                                ? "Bot guard banned a bot"
                                : "Quarantine role ban",
                            `Account ID: ${member.id}\nAccount type: ${member.user.bot ? "Bot" : "Member"}\n${reason}\nMessage history removal: ${config.delete_message_days} day(s)`,
                        );
                    },
                );
            }
            events.on(Events.GuildMemberAdd, (member) => check(member, true));
            events.on(Events.GuildMemberUpdate, async (_before, after) =>
                check(after),
            );
            events.every(60000, async () => {
                for (const guild of context.client.guilds.cache.values()) {
                    try {
                        const config = await context.settings.get(
                            guild.id,
                            "auto_ban_bots",
                            botGuardSchema,
                        );
                        // Join protection never sweeps existing bots. Role checks use REST
                        // pages so offline/uncached members cannot evade a scheduled check.
                        if (
                            !config.enabled ||
                            !config.watch_roles.some((id) => id !== guild.id) ||
                            (lastChecks.has(guild.id) &&
                                now() - (lastChecks.get(guild.id) ?? 0) <
                                    config.ban_check_interval_minutes * 60000)
                        )
                            continue;
                        const startedAt = now();
                        let after: string | undefined;
                        for (;;) {
                            const current = await context.settings.get(
                                guild.id,
                                "auto_ban_bots",
                                botGuardSchema,
                            );
                            if (
                                !current.enabled ||
                                !current.watch_roles.some(
                                    (id) => id !== guild.id,
                                )
                            )
                                break;
                            const page = await guild.members.list({
                                limit: 1000,
                                cache: false,
                                ...(after ? { after } : {}),
                            });
                            for (const member of page.values()) {
                                if (
                                    !current.watch_roles.some(
                                        (id) =>
                                            id !== guild.id &&
                                            member.roles.cache.has(id),
                                    )
                                )
                                    continue;
                                await check(member).catch((error: unknown) =>
                                    context.log.warn(
                                        `Bot guard failed for ${member.id}`,
                                        error,
                                    ),
                                );
                            }
                            if (page.size < 1000) break;
                            const next = page.lastKey();
                            if (
                                !next ||
                                (after && BigInt(next) <= BigInt(after))
                            )
                                throw new Error("Member scan did not advance");
                            after = next;
                        }
                        // Measure from scan start so a slow request does not skip the next minute.
                        lastChecks.set(guild.id, startedAt);
                    } catch (error) {
                        context.log.warn(
                            `Bot guard failed for ${guild.id}`,
                            error,
                        );
                    }
                }
            });
        },
        async stop() {
            await queue.drain();
        },
    };
}
