import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
    ChannelType,
    type ChatInputCommandInteraction,
    Collection,
    ComponentType,
    type Interaction,
    MessageFlags,
    PermissionFlagsBits,
    PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { levelsPlugin } from "../src/plugins/levels";
import { levelsSchema } from "../src/plugins/levels/config";
import { LevelsRepository } from "../src/plugins/levels/repository";
import { LevelSettingsEditor } from "../src/plugins/levels/settings-editor";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001";
const guildId = "200000000000000001";
const userId = "300000000000000001";
const starter = "400000000000000000";
const milestone = "400000000000000005";
const replacement = "400000000000000010";
const destination = "500000000000000001";
const commandDestination = "500000000000000002";
let db: Database;
beforeAll(async () => {
    db = await testDatabase();
}, 30000);
afterAll(async () => {
    await db?.close();
});

// Serialize through Discord's builders as a real response would. Tests exercise
// the menus and modal, then inspect actual PostgreSQL settings, not mock writes.
function wire(payload: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(payload));
}
function controls(payload: unknown): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.custom_id) result.push(record);
        if (Array.isArray(record.components))
            for (const item of record.components) walk(item);
    };
    walk(wire(payload));
    return result;
}
function controlId(payload: unknown, action: string): string {
    const control = controls(payload).find((item) =>
        String(item.custom_id).endsWith(`:${action}`),
    );
    if (!control) throw new Error(`Missing ${action} control`);
    return String(control.custom_id);
}

async function fixture(
    rewards = [
        { role_id: starter, level: 0 },
        { role_id: milestone, level: 5 },
    ],
) {
    const settings = new SettingsStore(db, botId);
    await settings.patch(guildId, "levels", levelsSchema, {
        enabled: false,
        reward_roles: rewards,
        reward_channel_id: destination,
        command_channel_id: null,
        xp_gain: { min: 150, max: 250 },
        xp_cooldown_seconds: 60,
        reward_message: "Congratulations {user}, you reached level {level}!",
        xp_multipliers: {
            default: 1.5,
            roles: [{ role_id: starter, multiplier: 2 }],
        },
        ignored_roles: [starter],
        ignored_channels: [destination],
        custom_note: "Keep this",
    });
    const roles = new Collection(
        [starter, milestone, replacement].map((id) => [
            id,
            {
                id,
                name: `Role ${id}`,
                managed: false,
                comparePositionTo: () => -1,
                permissions: new PermissionsBitField(),
            },
        ]),
    );
    const channel = {
        id: destination,
        type: ChannelType.GuildText,
        isSendable: () => true,
        isThread: () => false,
        permissionsFor: () =>
            new PermissionsBitField([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
            ]),
    };
    const guild = {
        id: guildId,
        roles: {
            cache: roles,
            fetch: mock(async (id: string) => roles.get(id) ?? null),
        },
        channels: {
            fetch: mock(async (id: string) =>
                id === destination
                    ? channel
                    : id === commandDestination
                      ? { ...channel, id }
                      : null,
            ),
        },
        members: {
            me: {
                roles: { highest: {} },
                permissions: new PermissionsBitField(
                    PermissionFlagsBits.ManageRoles,
                ),
            },
        },
    };
    let now = 0;
    const editor = new LevelSettingsEditor(() => now);
    const context = { botId, settings } as Context;
    let payload: unknown;
    const base = {
        guild,
        guildId,
        user: { id: userId },
        memberPermissions: new PermissionsBitField(
            PermissionFlagsBits.ManageGuild,
        ),
        editReply: mock(async (value: unknown) => {
            payload = value;
        }),
    };
    const open = async () => {
        await editor.open(
            context,
            base as unknown as ChatInputCommandInteraction<"cached">,
        );
        return payload;
    };
    await open();
    const interaction = (
        customId: string,
        kind = "button",
        values: string[] = [],
        overrides = {},
    ) => ({
        ...base,
        customId,
        values,
        message: { author: { id: botId } },
        isMessageComponent: () => kind !== "modal",
        isModalSubmit: () => kind === "modal",
        isFromMessage: () => true,
        isButton: () => kind === "button",
        isStringSelectMenu: () => kind === "string",
        isRoleSelectMenu: () => kind === "role",
        isChannelSelectMenu: () => kind === "channel",
        fields: {
            getTextInputValue: (name: string) =>
                values[name === "max" ? 1 : name === "cooldown" ? 2 : 0] ?? "",
        },
        deferUpdate: mock(async () => undefined),
        showModal: mock(async (_value: unknown) => undefined),
        ...overrides,
    });
    const send = async (event: ReturnType<typeof interaction>) => {
        await editor.handle(context, event as unknown as Interaction<"cached">);
        return payload;
    };
    const act = async (
        action: string,
        kind = "button",
        values: string[] = [],
    ) => {
        const event = interaction(controlId(payload, action), kind, values);
        await send(event);
        return event;
    };
    return {
        editor,
        context,
        settings,
        base,
        guild,
        channel,
        roles,
        open,
        interaction,
        send,
        act,
        payload: () => payload,
        expire: () => {
            now += 15 * 60 * 1000;
        },
        saved: () => settings.get(guildId, "levels", levelsSchema),
    };
}

test("settings command is private and the editor works while levels are disabled", async () => {
    const f = await fixture();
    const command = levelsPlugin.commands?.[0];
    expect(
        command?.data.toJSON().options?.some((sub) => sub.name === "settings"),
    ).toBe(true);
    const interaction = {
        ...f.base,
        options: {
            getSubcommandGroup: () => null,
            getSubcommand: () => "settings",
        },
    } as unknown as ChatInputCommandInteraction<"cached">;
    expect(command?.visibility?.(interaction)).toBe("private");
    await command?.execute(f.context, interaction);
    const payload = wire(f.payload());
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload).not.toHaveProperty("embeds");
    expect(
        (payload.components as { type: number }[]).some(
            (item) => item.type === ComponentType.Container,
        ),
    ).toBe(false);
    expect(componentText(payload)).toContain("Level 0 · Join role");
    expect(componentText(payload)).toContain("Disabled");
});

test("role replacement preserves other rewards, XP settings and disabled status", async () => {
    const f = await fixture();
    await f.act("reward", "string", [milestone]);
    await f.act("role", "role", [replacement]);
    expect(await f.saved()).toMatchObject({
        enabled: false,
        reward_roles: [
            { role_id: starter, level: 0 },
            { role_id: replacement, level: 5 },
        ],
        reward_channel_id: destination,
        xp_gain: { min: 150, max: 250 },
        custom_note: "Keep this",
    });
    expect(componentText(f.payload())).toContain(
        "old role is no longer managed",
    );
});

test("level modal supports zero and cancellation leaves the original controls usable", async () => {
    const f = await fixture();
    await f.act("reward", "string", [milestone]);
    const modal = await f.act("level");
    expect(modal.deferUpdate).not.toHaveBeenCalled();
    const first = wire(modal.showModal.mock.calls[0]?.[0]);
    expect((first.components as { type: number }[])[0]?.type).toBe(
        ComponentType.Label,
    );
    const retry = await f.act("level");
    const second = wire(retry.showModal.mock.calls[0]?.[0]);
    await f.send(f.interaction(String(second.custom_id), "modal", ["0"]));
    expect(
        (await f.saved()).reward_roles.find(
            (reward) => reward.role_id === milestone,
        )?.level,
    ).toBe(0);
    // An older open modal cannot restore stale settings after another modal saves.
    await f.send(f.interaction(String(first.custom_id), "modal", ["15"]));
    expect(
        (await f.saved()).reward_roles.find(
            (reward) => reward.role_id === milestone,
        )?.level,
    ).toBe(0);
    expect(componentText(f.payload())).toContain("Settings changed");
});

test("invalid levels, duplicate roles and unsafe roles leave settings intact and an editable panel", async () => {
    const f = await fixture();
    for (const input of ["-1", "1.5", "1e2", "100001", "", "NaN"]) {
        await f.act("reward", "string", [milestone]);
        const shown = await f.act("level");
        const modal = wire(shown.showModal.mock.calls[0]?.[0]);
        await f.send(f.interaction(String(modal.custom_id), "modal", [input]));
        expect(componentText(f.payload())).toContain("Enter a whole level");
    }
    await f.act("reward", "string", [milestone]);
    await f.act("role", "role", [starter]);
    expect(componentText(f.payload())).toContain("already has a milestone");
    const role = f.roles.get(replacement);
    if (!role) throw new Error("Missing fixture role");
    role.permissions.add(PermissionFlagsBits.Administrator);
    await f.act("reward", "string", [milestone]);
    await f.act("role", "role", [replacement]);
    expect(componentText(f.payload())).toContain("cannot be assigned");
    expect((await f.saved()).reward_roles).toEqual([
        { role_id: starter, level: 0 },
        { role_id: milestone, level: 5 },
    ]);
});

test("channel picker saves and disables announcements without changing XP or rewards", async () => {
    const f = await fixture();
    await f.act("channel");
    const picker = controls(f.payload()).find(
        (control) => control.type === ComponentType.ChannelSelect,
    );
    expect(picker?.channel_types).toEqual([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
    ]);
    await f.act("disable");
    expect((await f.saved()).reward_channel_id).toBeNull();
    await f.act("destination", "channel", [destination]);
    expect(await f.saved()).toMatchObject({
        reward_channel_id: destination,
        xp_gain: { min: 150, max: 250 },
        enabled: false,
    });
    expect(f.guild.channels.fetch).toHaveBeenCalledWith(destination);
    f.channel.permissionsFor = () => new PermissionsBitField();
    await f.act("destination", "channel", [destination]);
    expect(componentText(f.payload())).toContain("cannot view or send");
    expect((await f.saved()).reward_channel_id).toBe(destination);
});

test("command channel can be set, changed and cleared without touching XP or announcements", async () => {
    const f = await fixture();
    const before = await f.saved();
    await f.act("commands");
    expect(componentText(f.payload())).toContain("Allowed anywhere");
    expect(
        controls(f.payload()).find((item) =>
            String(item.custom_id).endsWith(":allow-anywhere"),
        )?.disabled,
    ).toBe(true);
    const picker = controls(f.payload()).find(
        (item) => item.type === ComponentType.ChannelSelect,
    );
    expect(picker?.channel_types).toEqual([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
    ]);
    await f.act("command-destination", "channel", [commandDestination]);
    expect(await f.saved()).toEqual({
        ...before,
        command_channel_id: commandDestination,
    });
    expect(componentText(f.payload())).toContain(`<#${commandDestination}>`);
    expect(
        controls(f.payload()).find(
            (item) => item.type === ComponentType.ChannelSelect,
        )?.default_values,
    ).toEqual([{ id: commandDestination, type: "channel" }]);
    // Reopening reads the stored guild setting; no in-memory editor state is required.
    await f.open();
    expect(componentText(f.payload())).toContain(
        `**Command channel:** <#${commandDestination}>`,
    );
    await f.act("commands");
    await f.act("command-destination", "channel", [destination]);
    expect(await f.saved()).toEqual({
        ...before,
        command_channel_id: destination,
    });
    await f.act("allow-anywhere");
    expect(await f.saved()).toEqual(before);
});

test("command channel rejects missing, unsupported and inaccessible destinations", async () => {
    const f = await fixture();
    const before = await f.saved();
    for (const values of [
        [],
        ["500000000000000099"],
        [destination, commandDestination],
    ]) {
        await f.act("commands");
        await f.act("command-destination", "channel", values);
        expect(componentText(f.payload())).toContain("⚠️");
        expect(await f.saved()).toEqual(before);
    }
    await f.act("commands");
    f.channel.type = ChannelType.GuildVoice;
    await f.act("command-destination", "channel", [destination]);
    expect(componentText(f.payload())).toContain(
        "Choose a server text or announcement channel",
    );
    expect(await f.saved()).toEqual(before);
    await f.act("commands");
    f.channel.type = ChannelType.GuildText;
    f.channel.permissionsFor = () => new PermissionsBitField();
    await f.act("command-destination", "channel", [destination]);
    expect(componentText(f.payload())).toContain("cannot view or send");
    expect(await f.saved()).toEqual(before);
});

test("command channel edits and removal reject concurrent changes and replayed controls", async () => {
    const f = await fixture();
    await f.act("commands");
    const stalePicker = f.interaction(
        controlId(f.payload(), "command-destination"),
        "channel",
        [destination],
    );
    await f.settings.patch(guildId, "levels", levelsSchema, {
        command_channel_id: commandDestination,
    });
    await f.send(stalePicker);
    expect((await f.saved()).command_channel_id).toBe(commandDestination);
    expect(componentText(f.payload())).toContain("Settings changed");
    await expect(f.send(stalePicker)).rejects.toThrow("outdated");
    await f.act("commands");
    const staleClear = f.interaction(controlId(f.payload(), "allow-anywhere"));
    await f.settings.patch(guildId, "levels", levelsSchema, {
        command_channel_id: destination,
    });
    await f.send(staleClear);
    expect((await f.saved()).command_channel_id).toBe(destination);
    expect(componentText(f.payload())).toContain("Settings changed");
});

test("restricted channels never lock an admin out of the settings editor", async () => {
    const f = await fixture();
    await f.settings.patch(guildId, "levels", levelsSchema, {
        command_channel_id: commandDestination,
    });
    const interaction = {
        ...f.base,
        channelId: destination,
        options: {
            getSubcommandGroup: () => null,
            getSubcommand: () => "settings",
        },
    } as unknown as ChatInputCommandInteraction<"cached">;
    await levelsPlugin.commands?.[0]?.execute(f.context, interaction);
    expect(componentText(f.payload())).toContain("Level settings");
    expect(componentText(f.payload())).toContain(`<#${commandDestination}>`);
});

test("only the owning admin in the same bot and server can use an unexpired panel", async () => {
    const f = await fixture();
    const id = controlId(f.payload(), "commands");
    const invalid = [
        { user: { id: "another-admin" } },
        { guildId: "another-guild" },
        { message: { author: { id: "another-bot" } } },
        { memberPermissions: new PermissionsBitField() },
    ];
    for (const overrides of invalid) {
        const event = f.interaction(id, "button", [], overrides);
        await expect(f.send(event)).rejects.toThrow();
        expect(event.deferUpdate).not.toHaveBeenCalled();
    }
    await expect(
        f.editor.handle(
            { ...f.context, botId: "another-bot" },
            f.interaction(id) as unknown as Interaction<"cached">,
        ),
    ).rejects.toThrow();
    f.expire();
    await expect(f.send(f.interaction(id))).rejects.toThrow("expired");
    expect((await f.saved()).reward_channel_id).toBe(destination);
});

test("concurrent admin changes are preserved and a consumed button cannot apply twice", async () => {
    const f = await fixture();
    await f.act("reward", "string", [milestone]);
    const remove = f.interaction(controlId(f.payload(), "remove"));
    await f.settings.patch(guildId, "levels", levelsSchema, {
        reward_roles: [{ role_id: replacement, level: 20 }],
    });
    await f.send(remove);
    expect((await f.saved()).reward_roles).toEqual([
        { role_id: replacement, level: 20 },
    ]);
    expect(componentText(f.payload())).toContain("Settings changed");
    await expect(f.send(remove)).rejects.toThrow("outdated");
    await f.act("reward", "string", [replacement]);
    const current = f.interaction(controlId(f.payload(), "remove"));
    const first = f.send(current);
    await expect(f.send(current)).rejects.toThrow("outdated");
    await first;
    expect((await f.saved()).reward_roles).toEqual([]);
    expect(componentText(f.payload())).toContain(
        "already have that role keep it",
    );
});

test("all 100 rewards are editable through pagination and refresh reloads slash command changes", async () => {
    const rewards = Array.from({ length: 100 }, (_, i) => ({
        role_id: String(BigInt(starter) + BigInt(i)),
        level: i,
    }));
    const f = await fixture(rewards);
    for (let page = 0; page < 10; page++) {
        const picker = controls(f.payload()).find(
            (control) => control.type === ComponentType.StringSelect,
        );
        const options = picker?.options as { value: string }[];
        expect(options).toHaveLength(10);
        expect(options[0]?.value).toBe(rewards[page * 10]?.role_id);
        expect(componentText(f.payload())).toContain(`Page ${page + 1} of 10`);
        if (page < 9) await f.act("next");
    }
    expect(
        controls(f.payload()).find((item) =>
            String(item.custom_id).endsWith(":next"),
        )?.disabled,
    ).toBe(true);
    await f.settings.patch(guildId, "levels", levelsSchema, {
        reward_roles: [],
    });
    await f.act("refresh");
    expect(componentText(f.payload())).toContain("Page 1 of 1");
    expect(componentText(f.payload())).toContain("No reward roles yet");
});

test("one panel exposes all level sections with buttons and no separate setup command links", async () => {
    const f = await fixture();
    for (const action of ["home", "channel", "xp", "commands", "home"]) {
        await f.act(action);
        expect(
            controls(f.payload()).filter((control) =>
                [
                    "Rewards",
                    "Announcements",
                    "XP settings",
                    "Commands",
                ].includes(String(control.label)),
            ),
        ).toHaveLength(4);
        expect(componentText(f.payload())).not.toContain("/level rewards");
        expect(componentText(f.payload())).not.toContain("/config");
        expect(wire(f.payload()).allowedMentions).toEqual({
            parse: [],
            repliedUser: false,
        });
        const rows = wire(f.payload()).components as Array<{
            type: number;
            components?: unknown[];
        }>;
        expect(
            rows.filter((row) => row.type === ComponentType.ActionRow).length,
        ).toBeLessThanOrEqual(3);
        for (const row of rows.filter(
            (row) => row.type === ComponentType.ActionRow,
        ))
            expect(row.components?.length).toBeLessThanOrEqual(5);
    }
});

test("add reward uses the role picker and level input without saving a cancelled draft", async () => {
    const f = await fixture([]);
    const before = await f.settings.raw(guildId, "levels");
    await f.act("add");
    expect(
        controls(f.payload()).find((control) =>
            String(control.custom_id).endsWith(":level"),
        )?.disabled,
    ).toBe(true);
    await f.act("new-role", "role", [replacement]);
    expect(await f.settings.raw(guildId, "levels")).toEqual(before);
    await f.act("back");
    expect(await f.settings.raw(guildId, "levels")).toEqual(before);
    await f.act("add");
    await f.act("new-role", "role", [replacement]);
    const shown = await f.act("level");
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    expect(shown.deferUpdate).not.toHaveBeenCalled();
    expect(modal.title).toBe("Add level reward");
    await f.send(f.interaction(String(modal.custom_id), "modal", ["0"]));
    expect(await f.saved()).toMatchObject({
        enabled: false,
        reward_roles: [{ role_id: replacement, level: 0 }],
        xp_gain: { min: 150, max: 250 },
    });
    expect(componentText(f.payload())).toContain("Join role");
    expect(componentText(f.payload())).toContain("Level reward added");
    // The freshly added reward can be edited immediately without reopening a command.
    const edit = await f.act("level");
    await f.send(
        f.interaction(
            String(wire(edit.showModal.mock.calls[0]?.[0]).custom_id),
            "modal",
            ["10"],
        ),
    );
    expect((await f.saved()).reward_roles).toEqual([
        { role_id: replacement, level: 10 },
    ]);
});

test("adding rejects duplicate/unassignable roles, full lists, and concurrent admin changes", async () => {
    const f = await fixture();
    await f.act("add");
    await f.act("new-role", "role", [starter]);
    expect(componentText(f.payload())).toContain("already has a milestone");
    const role = f.roles.get(replacement);
    if (!role) throw new Error("Missing role");
    role.permissions.add(PermissionFlagsBits.Administrator);
    await f.act("add");
    await f.act("new-role", "role", [replacement]);
    expect(componentText(f.payload())).toContain("cannot be assigned");
    role.permissions.remove(PermissionFlagsBits.Administrator);
    await f.act("add");
    await f.act("new-role", "role", [replacement]);
    const shown = await f.act("level");
    await f.settings.patch(guildId, "levels", levelsSchema, {
        reward_roles: [{ role_id: starter, level: 0 }],
    });
    await f.send(
        f.interaction(
            String(wire(shown.showModal.mock.calls[0]?.[0]).custom_id),
            "modal",
            ["5"],
        ),
    );
    expect(componentText(f.payload())).toContain("Settings changed");
    expect((await f.saved()).reward_roles).toEqual([
        { role_id: starter, level: 0 },
    ]);
    const full = Array.from({ length: 100 }, (_, i) => ({
        role_id: String(BigInt(starter) + BigInt(i)),
        level: i,
    }));
    await f.settings.patch(guildId, "levels", levelsSchema, {
        reward_roles: full,
    });
    await f.act("refresh");
    expect(
        controls(f.payload()).find((control) =>
            String(control.custom_id).endsWith(":add"),
        )?.disabled,
    ).toBe(true);
    await f.act("add");
    expect(componentText(f.payload())).toContain("100 reward roles");
    expect((await f.saved()).reward_roles).toEqual(full);
});

test("XP settings and pause controls preserve member progress and other configuration", async () => {
    const f = await fixture();
    const repository = new LevelsRepository(db, botId);
    await repository.set(guildId, userId, 9500);
    const progress = await repository.get(guildId, userId);
    const before = await f.saved();
    await f.act("xp");
    const shown = await f.act("edit-xp");
    expect(shown.deferUpdate).not.toHaveBeenCalled();
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    const fields = modal.components as {
        component: { custom_id: string; value: string };
    }[];
    expect(
        fields.map((label) => [
            label.component.custom_id,
            label.component.value,
        ]),
    ).toEqual([
        ["min", "150"],
        ["max", "250"],
        ["cooldown", "60"],
    ]);
    await f.send(
        f.interaction(String(modal.custom_id), "modal", ["25", "45", "30"]),
    );
    expect(await f.saved()).toEqual({
        ...before,
        xp_gain: { min: 25, max: 45 },
        xp_cooldown_seconds: 30,
    });
    expect(componentText(f.payload())).toContain("XP settings saved");
    await f.act("toggle");
    expect((await f.saved()).enabled).toBe(true);
    await f.act("channel");
    await f.act("toggle");
    expect((await f.saved()).enabled).toBe(false);
    expect(await repository.get(guildId, userId)).toEqual(progress);
});

test("invalid and stale XP forms cannot overwrite settings", async () => {
    const f = await fixture();
    const before = await f.saved();
    for (const values of [
        ["0", "20", "60"],
        ["50", "20", "60"],
        ["10", "10001", "60"],
        ["10", "20", "0"],
        ["10", "20", "86401"],
        ["1.5", "20", "60"],
        ["1e2", "200", "60"],
    ]) {
        await f.act("xp");
        const shown = await f.act("edit-xp");
        await f.send(
            f.interaction(
                String(wire(shown.showModal.mock.calls[0]?.[0]).custom_id),
                "modal",
                values,
            ),
        );
        expect(componentText(f.payload())).toContain("⚠️");
        expect(await f.saved()).toEqual(before);
    }
    await f.act("xp");
    const shown = await f.act("edit-xp");
    await f.settings.patch(guildId, "levels", levelsSchema, {
        xp_gain: { min: 300, max: 400 },
    });
    await f.send(
        f.interaction(
            String(wire(shown.showModal.mock.calls[0]?.[0]).custom_id),
            "modal",
            ["5", "10", "60"],
        ),
    );
    expect((await f.saved()).xp_gain).toEqual({ min: 300, max: 400 });
    expect(componentText(f.payload())).toContain("Settings changed");
});

test("announcement text is editable in the same panel without changing its channel or roles", async () => {
    const f = await fixture();
    const before = await f.saved();
    await f.act("channel");
    const shown = await f.act("message");
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    expect(shown.deferUpdate).not.toHaveBeenCalled();
    expect(modal.title).toBe("Edit level-up message");
    await f.send(
        f.interaction(String(modal.custom_id), "modal", [
            "{user} reached **level {level}**!",
        ]),
    );
    expect(await f.saved()).toEqual({
        ...before,
        reward_message: "{user} reached **level {level}**!",
    });
    for (const value of ["   ", "x".repeat(1801)]) {
        await f.act("channel");
        const shown = await f.act("message");
        await f.send(
            f.interaction(
                String(wire(shown.showModal.mock.calls[0]?.[0]).custom_id),
                "modal",
                [value],
            ),
        );
        expect(componentText(f.payload())).toContain("1,800");
        expect((await f.saved()).reward_message).toBe(
            "{user} reached **level {level}**!",
        );
    }
});
