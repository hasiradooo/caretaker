import {
    type ActionRowBuilder,
    FileBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    type MessageActionRowComponentBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { noMentions } from "./discord";

export const featureIcons: Record<string, string> = {
    levels: "✨",
    welcome_goodbye: "👋",
    roles: "🎭",
    birthday: "🎂",
    tickets: "🎫",
    starboard: "⭐",
    server_stats: "📊",
    tempvc: "🔊",
    slowmode: "⏳",
    auto_ban_bots: "🛡️",
    moderation: "🛡️",
};

export type CardImage = string | { url: string; spoiler?: boolean };

interface CardOptions {
    title: string;
    body?: string;
    icon?: string;
    sections?: string[];
    footer?: string;
    thumbnail?: string;
    image?: string;
    images?: CardImage[];
    /** These names must also be supplied as attachments in the send/edit call. */
    fileNames?: string[];
    actions?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/** Truncate by UTF-16 length without cutting an emoji's surrogate pair in half. */
export function clipText(value: string, limit: number): string {
    if (value.length <= limit) return value;
    if (limit <= 1) return "…".slice(0, limit);
    return `${value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/**
 * One layout for public messages and private replies. V2 messages cannot contain
 * legacy content/embeds; attachments must have an explicit File component.
 * Keep components at the top level: a Container adds the embed-like box and
 * colored edge that this bot deliberately avoids. Thumbnails belong in Sections.
 * Reserve the footer first and bound all text together (Discord's 4,000 limit).
 */
export function card(options: CardOptions) {
    if (
        (options.sections?.length ?? 0) > 6 ||
        (options.actions?.length ?? 0) > 3 ||
        (options.fileNames?.length ?? 0) > 2
    )
        throw new Error("Split this card into smaller messages.");
    const footer = options.footer ? `-# ${clipText(options.footer, 240)}` : "";
    let remaining = 3900 - footer.length;
    const text = (value: string, limit = remaining) => {
        const content = clipText(value, Math.min(limit, remaining));
        remaining -= content.length;
        return new TextDisplayBuilder().setContent(content);
    };
    const components: Array<
        | TextDisplayBuilder
        | SectionBuilder
        | SeparatorBuilder
        | MediaGalleryBuilder
        | FileBuilder
        | ActionRowBuilder<MessageActionRowComponentBuilder>
    > = [];
    const heading = text(
        `## ${options.icon ?? "🗝️"} ${options.title.replace(/[\r\n]/g, " ")}`,
        250,
    );
    if (options.thumbnail) {
        const header = new SectionBuilder().addTextDisplayComponents(heading);
        if (options.body?.trim())
            header.addTextDisplayComponents(text(options.body));
        components.push(
            header.setThumbnailAccessory(
                new ThumbnailBuilder()
                    .setURL(options.thumbnail)
                    .setDescription("Member avatar"),
            ),
        );
    } else {
        components.push(heading);
        if (options.body?.trim()) components.push(text(options.body));
    }
    for (const section of options.sections ?? []) {
        if (!section.trim() || remaining <= 0) continue;
        components.push(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
        );
        components.push(text(section));
    }
    const images = options.images ?? (options.image ? [options.image] : []);
    if (images.length)
        components.push(
            new MediaGalleryBuilder().addItems(
                ...images.slice(0, 10).map((image) => {
                    const item = new MediaGalleryItemBuilder()
                        .setURL(typeof image === "string" ? image : image.url)
                        .setDescription("Shared image");
                    if (typeof image !== "string" && image.spoiler)
                        item.setSpoiler(true);
                    return item;
                }),
            ),
        );
    for (const name of options.fileNames ?? [])
        components.push(new FileBuilder().setURL(`attachment://${name}`));
    if (options.actions?.length) components.push(...options.actions);
    if (footer) {
        components.push(
            new SeparatorBuilder()
                .setDivider(false)
                .setSpacing(SeparatorSpacingSize.Small),
        );
        components.push(new TextDisplayBuilder().setContent(footer));
    }
    return {
        flags: MessageFlags.IsComponentsV2 as const,
        components,
        allowedMentions: noMentions,
    };
}

export function successCard(title: string, body: string) {
    return card({ title, body, icon: "✓" });
}

export function progressBar(current: number, maximum: number): string {
    const ratio =
        Number.isFinite(current) && maximum > 0
            ? Math.max(0, Math.min(1, current / maximum))
            : 0;
    const filled = Math.floor(ratio * 12);
    return `${"▰".repeat(filled)}${"▱".repeat(12 - filled)}  **${Math.floor(ratio * 100)}%**`;
}

/** Discord stores V2 text in nested components, including in ticket history. */
export function componentText(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    if ("toJSON" in value && typeof value.toJSON === "function")
        return componentText(value.toJSON());
    const item = value as { content?: unknown; components?: unknown[] };
    return [
        typeof item.content === "string" ? item.content : "",
        ...(item.components ?? []).map(componentText),
    ]
        .filter(Boolean)
        .join("\n");
}
