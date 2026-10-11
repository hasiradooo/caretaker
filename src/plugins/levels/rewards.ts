import type { GuildMember } from "discord.js";
import type { Context } from "../../core/plugin";
import { assignableRole } from "../../shared/discord";
import type { LevelsSettings } from "./config";

/** Keep every reward at the highest unlocked milestone, including tied rewards. */
export async function syncLevelRewards(
  context: Pick<Context, "log">,
  member: GuildMember,
  level: number,
  config: LevelsSettings,
): Promise<boolean> {
  if (!config.reward_roles.length) return true;
  const milestone = Math.max(
    0,
    ...config.reward_roles
      .filter((item) => item.level <= level)
      .map((item) => item.level),
  );
  const desired = new Set(
    config.reward_roles
      .filter((item) => item.level === milestone)
      .map((item) => item.role_id),
  );
  try {
    // Fetch fresh roles: the previous message or a moderator may have changed them.
    const current = await member.guild.members.fetch({
      user: member.id,
      force: true,
    });
    const reason = `Level ${level}: highest milestone reward`;
    // Validate all new rewards first, then add before removing. If a grant fails,
    // the member keeps their previous milestone and we retry on their next XP award.
    const rewards = await Promise.all(
      [...desired].map((id) => assignableRole(member.guild, id)),
    );
    for (const role of rewards) {
      if (!current.roles.cache.has(role.id))
        await current.roles.add(role, reason);
    }
    for (const id of new Set(config.reward_roles.map((item) => item.role_id))) {
      if (desired.has(id) || !current.roles.cache.has(id)) continue;
      // Only explicitly configured, still-safe reward roles may be removed.
      const role = await assignableRole(member.guild, id);
      await current.roles.remove(role, reason);
    }
    return true;
  } catch (error) {
    context.log.warn(
      `Could not sync level rewards for ${member.guild.id}:${member.id}`,
      error,
    );
    return false;
  }
}
