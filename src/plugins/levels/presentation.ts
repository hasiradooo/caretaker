import { escapeMarkdown, type Guild, type User } from "discord.js";

/** Display names are text, even if a nickname contains Markdown or mention syntax. */
export function levelDisplayName(name: string): string {
  return escapeMarkdown(name.replace(/[\r\n]+/g, " "))
    .replaceAll("@", "@\u200b")
    .replaceAll("<", "<\u200b");
}

/** Prefer the server nickname/avatar; a missing member must not break a leaderboard. */
export async function levelProfile(
  guild: Guild,
  userId: string,
  fallback?: User,
) {
  const member =
    guild.members.cache.get(userId) ??
    (await guild.members.fetch(userId).catch(() => null));
  const user = member?.user ?? fallback ?? guild.client.users.cache.get(userId);
  return {
    name: levelDisplayName(
      member?.displayName ?? user?.displayName ?? "Unknown member",
    ),
    avatar: member?.displayAvatarURL() ?? user?.displayAvatarURL(),
  };
}
