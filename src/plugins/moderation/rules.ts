import { domainToASCII } from "node:url";
import type { ModerationRule } from "./config";

export const eventNames = {
    create: "Message sent",
    edit: "Message edited",
    both: "Sent or edited",
};
export const conditionNames = {
    links: "Contains a link",
    invites: "Discord invite",
    words: "Contains words or phrases",
    domains: "Links to listed domains",
    attachments: "Has attachments",
    mentions: "Too many mentions",
};
export const actionNames = {
    delete: "Delete message",
    delete_timeout: "Delete + timeout",
    log: "Log only",
};

/** No user-supplied regular expressions or remote URL requests. Work stays bounded
 * to Discord message size; NFKC and format removal cover common disguised links. */
export function normalizeText(text: string): string {
    return text
        .normalize("NFKC")
        .replace(/\p{Cf}/gu, "")
        .toLowerCase();
}
export function linkHosts(text: string): string[] {
    const normalized = normalizeText(text);
    const candidates =
        normalized.match(
            /(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}(?::\d+)?(?:\/[^\s<>()[\]"'`]*)?/gu,
        ) ?? [];
    return candidates.flatMap((candidate) => {
        try {
            return [
                new URL(
                    /^https?:\/\//.test(candidate)
                        ? candidate
                        : `https://${candidate}`,
                ).hostname.replace(/\.$/, ""),
            ];
        } catch {
            return [];
        }
    });
}
export interface MessageFacts {
    content: string;
    attachments: number;
    mentionCount: number;
    everyone: boolean;
}
export function conditionMatches(
    rule: ModerationRule,
    facts: MessageFacts,
): boolean {
    const text = normalizeText(facts.content);
    switch (rule.condition) {
        case "links":
            return /https?:\/\//.test(text) || linkHosts(text).length > 0;
        case "invites":
            return /(?:^|[^\p{L}\p{N}.-])(?:www\.)?(?:discord\.gg\/|(?:discord(?:app)?\.com)\/invite\/)\S+/u.test(
                text,
            );
        case "words":
            return rule.values.some((value) => {
                const phrase = normalizeText(value);
                return phrase.length > 0 && text.includes(phrase);
            });
        case "domains":
            return linkHosts(text).some((host) =>
                rule.values.some((value) => {
                    const domain = domainToASCII(normalizeText(value));
                    return (
                        domain &&
                        (host === domain || host.endsWith(`.${domain}`))
                    );
                }),
            );
        case "attachments":
            return facts.attachments > 0;
        case "mentions":
            return facts.everyone || facts.mentionCount >= rule.mention_limit;
    }
}
export function channelMatches(
    ids: string[],
    channelId: string,
    parentId?: string | null,
): boolean {
    return ids.includes(channelId) || (!!parentId && ids.includes(parentId));
}
