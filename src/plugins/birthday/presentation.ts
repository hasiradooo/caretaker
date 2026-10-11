import { escapeMarkdown, type GuildMember } from "discord.js";
import { noMentions } from "../../shared/discord";
import { card } from "../../shared/messages";
import { renderTemplate } from "../../shared/templates";
import type { BirthdaySettings } from "./config";

const plain = (value: string) =>
    escapeMarkdown(value.replace(/[\r\n]/g, " "))
        .replaceAll("@", "@\u200b")
        .replaceAll("<", "<\u200b");

/** No saved birth date or year is exposed by public announcements or previews. */
export function birthdayCard(
    config: BirthdaySettings,
    member: GuildMember,
    preview = false,
) {
    return {
        ...card({
            title: "Time to celebrate",
            icon: "🎂",
            thumbnail: member.displayAvatarURL(),
            body: renderTemplate(config.message, {
                user: `<@${member.id}>`,
                display_name: plain(member.displayName),
                server: plain(member.guild.name),
            }),
            footer: preview
                ? "Private preview · Your profile is the example · No notification sent"
                : "A little celebration for one of our own",
        }),
        allowedMentions: preview
            ? noMentions
            : { ...noMentions, users: [member.id] },
    };
}
