import { expect, mock, test } from "bun:test";
import { ApplicationFlagsBitField, type REST, Routes } from "discord.js";
import {
    inspectDiscordAccess,
    missingGatewayIntents,
} from "../src/core/discord-preflight";

const appId = "100000000000000001",
    guildId = "200000000000000001";

test("gateway checks accept both verified and limited intent grants", () => {
    const flags = ApplicationFlagsBitField.Flags;
    expect(
        missingGatewayIntents(
            flags.GatewayGuildMembersLimited |
                flags.GatewayMessageContentLimited,
        ),
    ).toEqual([]);
    expect(
        missingGatewayIntents(
            flags.GatewayGuildMembers | flags.GatewayMessageContent,
        ),
    ).toEqual([]);
    expect(missingGatewayIntents(flags.GatewayGuildMembersLimited)).toEqual([
        "Message Content Intent",
    ]);
    expect(missingGatewayIntents(0)).toEqual([
        "Server Members Intent",
        "Message Content Intent",
    ]);
});

test("a mismatched bot ID stops preflight before reading or changing server setup", async () => {
    const get = mock(async () => ({
        id: "100000000000000002",
        name: "Another bot",
        flags: 0,
    }));
    await expect(
        inspectDiscordAccess({ get } as unknown as Pick<REST, "get">, appId),
    ).rejects.toThrow("does not match");
    expect(get).toHaveBeenCalledTimes(1);
});

test("a configured server must belong to this bot", async () => {
    const get = mock(async (route: string) =>
        route === Routes.oauth2CurrentApplication()
            ? { id: appId, name: "Test", flags: 0 }
            : [{ id: guildId, name: "Joined" }],
    );
    await expect(
        inspectDiscordAccess(
            { get } as unknown as Pick<REST, "get">,
            appId,
            "200000000000000002",
        ),
    ).rejects.toThrow("has not joined");
});

test("preflight follows pagination so larger bots can target a later server", async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({
        id: (300000000000000000n + BigInt(i)).toString(),
        name: `Server ${i}`,
    }));
    const get = mock(
        async (route: string, options?: { query: URLSearchParams }) => {
            if (route === Routes.oauth2CurrentApplication())
                return { id: appId, name: "Test", flags: 0 };
            if (!options?.query.get("after")) return page;
            expect(options.query.get("after")).toBe(page.at(-1)?.id ?? "");
            return [{ id: guildId, name: "Target" }];
        },
    );
    const report = await inspectDiscordAccess(
        { get } as unknown as Pick<REST, "get">,
        appId,
        guildId,
    );
    expect(report.guilds).toHaveLength(201);
    expect(report.guilds.at(-1)?.name).toBe("Target");
});
