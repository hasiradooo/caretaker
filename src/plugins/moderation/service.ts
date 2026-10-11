import { createHash } from "node:crypto";
import {
    type Message,
    type PartialMessage,
    PermissionFlagsBits,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { KeyedQueue } from "../../shared/serial";
import { moderationSchema } from "./config";
import { moderationLog } from "./log";
import { channelMatches, conditionMatches } from "./rules";

const errorCode = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
export class ModerationService {
    private readonly queue = new KeyedQueue();
    constructor(private readonly context: Context) {}

    async check(
        candidate: Message | PartialMessage,
        event: "create" | "edit",
    ): Promise<void> {
        if (!candidate.guild || candidate.author?.id === this.context.botId)
            return;
        await this.queue.run(
            `${candidate.guild.id}:${candidate.id}`,
            async () => {
                const { context } = this;
                const guild = candidate.guild;
                if (!guild) return;
                const config = await context.settings.get(
                    guild.id,
                    "moderation",
                    moderationSchema,
                );
                if (
                    !config.enabled ||
                    !config.rules.some(
                        (rule) =>
                            rule.enabled &&
                            (rule.event === event || rule.event === "both"),
                    )
                )
                    return;
                if (
                    channelMatches(
                        config.exempt_channels,
                        candidate.channelId,
                        candidate.channel.isThread()
                            ? candidate.channel.parentId
                            : null,
                    )
                )
                    return;
                // Fetch uncached/old edits and re-read the latest version before deciding.
                // There is deliberately no age limit on an edit. Never rely on old.content.
                let message: Message;
                try {
                    message =
                        event === "edit" || candidate.partial
                            ? await candidate.fetch(true)
                            : (candidate as Message);
                } catch (error) {
                    if (errorCode(error) !== 10008)
                        context.log.warn(
                            `Cannot inspect edited message ${candidate.id}`,
                            error,
                        );
                    return;
                }
                if (
                    !message.inGuild() ||
                    message.author.id === context.botId ||
                    message.system
                )
                    return;
                if (
                    !config.include_bots &&
                    (message.author.bot || message.webhookId)
                )
                    return;
                const parent = message.channel.isThread()
                    ? message.channel.parentId
                    : null;
                if (
                    channelMatches(
                        config.exempt_channels,
                        message.channelId,
                        parent,
                    )
                )
                    return;
                // Webhooks have no guild member. Only apply unscoped rules when explicitly enabled.
                const member = message.webhookId
                    ? null
                    : await guild.members
                          .fetch(message.author.id)
                          .catch((error: unknown) => {
                              if (errorCode(error) !== 10007)
                                  context.log.warn(
                                      `Cannot check moderation exemptions for member ${message.author.id}`,
                                      error,
                                  );
                              return null;
                          });
                if (!member && !message.webhookId) return;
                if (
                    member &&
                    (member.id === guild.ownerId ||
                        config.exempt_roles.some((id) =>
                            member.roles.cache.has(id),
                        ) ||
                        (config.exempt_staff &&
                            member.permissions.any([
                                PermissionFlagsBits.Administrator,
                                PermissionFlagsBits.ManageGuild,
                                PermissionFlagsBits.ManageMessages,
                            ])))
                )
                    return;
                const facts = {
                    content: message.content,
                    attachments: message.attachments.size,
                    mentionCount:
                        message.mentions.users.size +
                        message.mentions.roles.size,
                    everyone: message.mentions.everyone,
                };
                const matches = config.rules.filter(
                    (rule) =>
                        rule.enabled &&
                        (rule.event === event || rule.event === "both") &&
                        (!rule.channels.length ||
                            channelMatches(
                                rule.channels,
                                message.channelId,
                                parent,
                            )) &&
                        (!rule.roles.length ||
                            rule.roles.some((id) =>
                                member?.roles.cache.has(id),
                            )) &&
                        conditionMatches(rule, facts),
                );
                if (!matches.length) return;
                const deletes = matches.some((rule) => rule.action !== "log");
                const digest = createHash("sha256")
                    .update(
                        JSON.stringify([
                            message.content,
                            [...message.attachments.keys()],
                            matches.map((rule) => rule.id),
                        ]),
                    )
                    .digest("hex")
                    .slice(0, 32);
                const key = deletes
                    ? `deleted:${message.id}`
                    : `logged:${message.id}:${digest}`;
                if (
                    !(await context.state.claim(
                        guild.id,
                        "moderation",
                        key,
                        86400,
                    ))
                )
                    return;
                const outcomes: string[] = [];
                if (deletes) {
                    try {
                        const me =
                            guild.members.me ?? (await guild.members.fetchMe());
                        if (
                            !message.deletable ||
                            !message.channel
                                .permissionsFor(me)
                                ?.has(PermissionFlagsBits.ManageMessages)
                        )
                            throw new Error(
                                "Missing Manage Messages permission or message is not deletable",
                            );
                        await message.delete();
                        outcomes.push("Message deleted");
                    } catch (error) {
                        if (errorCode(error) === 10008) return; // Already removed; do not punish twice.
                        await context.state.release(
                            guild.id,
                            "moderation",
                            key,
                        );
                        context.log.warn(
                            `Moderation could not delete ${message.id}`,
                            error,
                        );
                        await moderationLog(
                            context,
                            guild,
                            config.log_channel_id,
                            "Moderation action failed",
                            `Message ID: ${message.id}\nChannel: <#${message.channelId}>\nDeletion failed; no timeout was applied. Check channel permissions.`,
                        );
                        return;
                    }
                }
                const minutes = Math.max(
                    0,
                    ...matches
                        .filter((rule) => rule.action === "delete_timeout")
                        .map((rule) => rule.timeout_minutes),
                );
                if (minutes > 0) {
                    try {
                        if (!member?.moderatable)
                            throw new Error(
                                "Member cannot be timed out; check Moderate Members and role hierarchy",
                            );
                        const until = Date.now() + minutes * 60000;
                        if (
                            (member.communicationDisabledUntilTimestamp ?? 0) <
                            until
                        )
                            await member.disableCommunicationUntil(
                                new Date(until),
                                `Caretaker moderation: rule ${matches.find((rule) => rule.action === "delete_timeout")?.id}`,
                            );
                        outcomes.push(`Timeout: at least ${minutes} minutes`);
                    } catch (error) {
                        context.log.warn(
                            `Moderation timeout failed for ${message.author.id}`,
                            error,
                        );
                        outcomes.push(
                            "Timeout failed; message was deleted. Check permissions and role hierarchy.",
                        );
                    }
                }
                // Rule IDs avoid turning administrator-written labels into links or mentions.
                await moderationLog(
                    context,
                    guild,
                    config.log_channel_id,
                    "Moderation rule matched",
                    `Member ID: ${message.author.id}\nMessage ID: ${message.id}\nChannel: <#${message.channelId}>\nEvent: ${event}\nRules: ${matches.map((rule) => rule.id).join(", ")}\n${outcomes.join("\n") || "Logged only; message kept"}`,
                );
            },
        );
    }
    async stop() {
        await this.queue.drain();
    }
}
