import { Events, type GuildMember, PermissionFlagsBits } from "discord.js";
import type { Plugin } from "../../core/plugin";
import { botGuardSchema } from "./config";

export function createBotGuardPlugin(): Plugin {
  const lastChecks = new Map<string, number>();
  return {
    id: "auto_ban_bots",
    name: "Bot guard",
    description:
      "Ban bot accounts carrying explicitly configured quarantine roles",
    schema: botGuardSchema,
    register(context, events) {
      async function check(member: GuildMember): Promise<void> {
        if (!member.user.bot || member.id === context.botId) return;
        const config = await context.settings.get(
          member.guild.id,
          "auto_ban_bots",
          botGuardSchema,
        );
        if (
          !config.enabled ||
          !config.watch_roles.length ||
          config.allowed_bot_ids.includes(member.id)
        )
          return;
        if (
          !config.watch_roles.some(
            (id) => id !== member.guild.id && member.roles.cache.has(id),
          )
        )
          return;
        const me =
          member.guild.members.me ?? (await member.guild.members.fetchMe());
        if (
          !member.bannable ||
          !me.permissions.has(PermissionFlagsBits.BanMembers)
        )
          return;
        await member.ban({
          reason: "Bot guard: configured quarantine role",
          deleteMessageSeconds: config.delete_message_days * 86400,
        });
      }
      events.on(Events.GuildMemberAdd, check);
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
            if (
              !config.enabled ||
              Date.now() - (lastChecks.get(guild.id) ?? 0) <
                config.ban_check_interval_minutes * 60000
            )
              continue;
            lastChecks.set(guild.id, Date.now());
            for (const member of guild.members.cache.values())
              await check(member);
          } catch (error) {
            context.log.warn(`Bot guard failed for ${guild.id}`, error);
          }
        }
      });
    },
  };
}
