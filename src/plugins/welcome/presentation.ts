import {
  escapeMarkdown,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { noMentions } from "../../shared/discord";
import { card } from "../../shared/messages";
import { renderTemplate } from "../../shared/templates";
import type { WelcomeSettings } from "./config";

export type GreetingKind = "welcome" | "goodbye";

export const greetingFields = {
  welcome: {
    channel: "welcome_channel_id",
    message: "welcome_message",
    label: "Welcome",
  },
  goodbye: {
    channel: "leave_channel_id",
    message: "goodbye_message",
    label: "Goodbye",
  },
} as const;

export function greetingTemplate(
  config: WelcomeSettings,
  kind: GreetingKind,
): string {
  return (
    config[greetingFields[kind].message] ??
    (kind === "welcome"
      ? "Welcome to {server}, {user}!"
      : "{display_name} has left {server}.")
  );
}

// Member and server names are plain text. Only the administrator's template
// supplies Markdown and channel mentions; names cannot inject formatting/pings.
function plainName(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]+/g, " "))
    .replaceAll("@", "@\u200b")
    .replaceAll("<", "<\u200b");
}

/** The preview and real join/leave events share a renderer so they stay in sync. */
export function greetingCard(
  config: WelcomeSettings,
  kind: GreetingKind,
  member: GuildMember | PartialGuildMember,
  preview = false,
) {
  const name = plainName(
    member.nickname ?? member.user?.displayName ?? "A member",
  );
  return {
    ...card({
      title: kind === "welcome" ? "Welcome in" : "Until next time",
      icon: kind === "welcome" ? "👋" : "🚪",
      thumbnail: member.user ? member.displayAvatarURL() : undefined,
      body: renderTemplate(greetingTemplate(config, kind), {
        user: `<@${member.id}>`,
        display_name: name,
        server: plainName(member.guild.name),
        member_count: member.guild.memberCount,
      }),
      footer: preview
        ? "Private preview · Your profile is used as the example · No notification sent"
        : `${member.guild.memberCount.toLocaleString()} members${kind === "welcome" ? " · Make yourself at home" : ""}`,
    }),
    allowedMentions:
      !preview && kind === "welcome"
        ? { ...noMentions, users: [member.id] }
        : noMentions,
  };
}
