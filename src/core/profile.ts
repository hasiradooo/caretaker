import { type REST, Routes } from "discord.js";
import { z } from "zod";
import { botProfile } from "../config/profile";
import type { BuildIdentity } from "../config/version";
import { clipText } from "../shared/messages";
import { snowflake } from "../shared/validation";

const buildPrefix = "Caretaker build: ";
const startPrefix = "Last start: ";
const isRuntimeLine = (line: string) =>
    line.startsWith(buildPrefix) || line.startsWith(startPrefix);

function withRuntimeLines(text: string, lines: string[]): string {
    const body = text
        .split(/\r?\n/)
        .filter((line) => !isRuntimeLine(line))
        .join("\n")
        .trim();
    if (!lines.length) return body;
    const footer = lines.join("\n");
    const available = 400 - footer.length - 2;
    if (available < 1) throw new Error("Runtime bio information is too long.");
    return [clipText(body, available), footer].filter(Boolean).join("\n\n");
}

export function versionedBio(
    text: string,
    identity: BuildIdentity,
    startedAt: Date,
): string {
    return withRuntimeLines(text, [
        `${buildPrefix}${identity.label}`,
        `${startPrefix}${startedAt.toISOString().slice(0, 19).replace("T", " ")} UTC`,
    ]);
}

/** Manual bio edits keep the identity of the running process, not a local build. */
export function preserveRuntimeBio(text: string, currentBio: string): string {
    return withRuntimeLines(
        text,
        currentBio.split(/\r?\n/).filter(isRuntimeLine),
    );
}

export async function syncRuntimeBio(
    rest: Pick<REST, "get" | "patch">,
    applicationId: string,
    identity: BuildIdentity,
    startedAt: Date,
): Promise<void> {
    const schema = z.object({ id: snowflake, description: z.string() });
    const route = Routes.currentApplication();
    const current = schema.parse(await rest.get(route));
    if (current.id !== applicationId)
        throw new Error("DISCORD_CLIENT_ID does not match this bot token.");
    const description = versionedBio(
        current.description.trim() ? current.description : botProfile.bio,
        identity,
        startedAt,
    );
    if (current.description === description) return;
    await rest.patch(route, { body: { description } });
    const saved = schema.parse(await rest.get(route));
    if (saved.id !== current.id || saved.description !== description)
        throw new Error("Discord did not return the expected versioned bio.");
}
