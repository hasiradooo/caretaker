import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
    type AttachmentBuilder,
    type ButtonInteraction,
    ChannelType,
    type ChatInputCommandInteraction,
    Collection,
    type Guild,
    type GuildMember,
    type Message,
    MessageFlags,
    PermissionFlagsBits,
    PermissionsBitField,
} from "discord.js";
import type { Context, EventRegistrar } from "../src/core/plugin";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { StateStore } from "../src/database/state-store";
import { ticketsPlugin } from "../src/plugins/tickets";
import { removeClosedTicketAlert } from "../src/plugins/tickets/alerts";
import { ticketsSchema } from "../src/plugins/tickets/config";
import { checkTicketInactivity } from "../src/plugins/tickets/inactivity";
import {
    ticketLabel,
    ticketThreadName,
} from "../src/plugins/tickets/presentation";
import { TicketRepository } from "../src/plugins/tickets/repository";
import { handleTicketReview } from "../src/plugins/tickets/reviews";
import { closeTicket, openTicket } from "../src/plugins/tickets/service";
import { TranscriptRepository } from "../src/plugins/tickets/transcript-repository";
import { syncTicketTranscript } from "../src/plugins/tickets/transcripts";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001";
const openerId = "300000000000000001",
    staffId = "300000000000000002";
const adminId = "300000000000000003",
    otherId = "300000000000000004";
const roleId = "500000000000000001",
    parentId = "400000000000000001";
const alertsId = "400000000000000002";
const transcriptsId = "400000000000000003";
let db: Database,
    sequence = 0;
beforeAll(async () => {
    db = await testDatabase();
}, 30000);
afterAll(async () => {
    await db?.close();
});

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("Missing test fixture value");
    return value;
}

async function fixture() {
    const guildId = String(200000000000000000n + BigInt(++sequence));
    const full = new PermissionsBitField(PermissionsBitField.All);
    const participants = new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
    ]);
    const channels = new Collection<string, ReturnType<typeof makeThread>>();
    const created: ReturnType<typeof makeThread>[] = [];
    function makeThread(id: string) {
        return {
            id,
            type: ChannelType.PrivateThread,
            archived: false,
            locked: false,
            isThread: () => true,
            isTextBased: () => true,
            permissionsFor: mock(() => full),
            setName: mock(async (_name: string) => {}),
            messages: { fetch: mock(async () => new Collection()) },
            members: { add: mock(async (_id: string) => {}) },
            send: mock(async (_payload: unknown) => ({
                id: "800000000000000002",
                delete: mock(async () => {}),
            })),
            delete: mock(async (_reason: string) => {
                channels.delete(id);
            }),
            setArchived: mock(async (archived: boolean, _reason?: string) => {
                const thread = channels.get(id);
                if (thread) thread.archived = archived;
            }),
            setLocked: mock(async (locked: boolean, _reason?: string) => {
                const thread = channels.get(id);
                if (thread) thread.locked = locked;
            }),
        };
    }
    const parent = {
        id: parentId,
        type: ChannelType.GuildText,
        permissionsFor: mock((member: { id: string }) =>
            member.id === botId ? full : participants,
        ),
        threads: {
            create: mock(async (_options: unknown) => {
                const thread = makeThread(
                    String(600000000000000000n + BigInt(created.length + 1)),
                );
                channels.set(thread.id, thread);
                created.push(thread);
                return thread;
            }),
        },
    };
    const discardAlert = mock(async () => {});
    const deleteAlert = mock(async (_route: string) => {});
    const reviewDm = mock(async (_payload: unknown) => ({
        id: "800000000000000001",
    }));
    const alerts = {
        id: alertsId,
        isSendable: () => true,
        isThread: () => false,
        permissionsFor: () => full,
        send: mock(async (_payload: unknown) => ({
            id: String(700000000000000000n + BigInt(created.length)),
            delete: discardAlert,
        })),
    };
    const transcripts = {
        ...alerts,
        type: ChannelType.GuildText,
        id: transcriptsId,
        permissionsFor: (member: { id: string }) =>
            member.id === guildId ? new PermissionsBitField() : full,
        send: mock(async (_payload: unknown) => ({ id: "900000000000000001" })),
        messages: {
            edit: mock(async (_id: string, _payload: unknown) => ({
                id: "900000000000000001",
            })),
        },
    };
    const roster = new Collection<string, GuildMember>();
    const guild = {
        id: guildId,
        name: "Test backrooms",
        channels: {
            fetch: mock(async (id: string) =>
                id === parentId
                    ? parent
                    : id === alertsId
                      ? alerts
                      : id === transcriptsId
                        ? transcripts
                        : (channels.get(id) ?? null),
            ),
            create: mock(async () => {
                throw new Error("Must not create text channels");
            }),
        },
        roles: {
            everyone: { id: guildId },
            fetch: mock(async (id: string) => ({ id })),
        },
        members: {
            me: { id: botId },
            fetch: mock(async (options?: { user: string }) =>
                options ? roster.get(options.user) : roster,
            ),
        },
    };
    function member(
        id: string,
        roles: string[] = [],
        admin = false,
        bot = false,
    ) {
        const result = {
            id,
            guild,
            user: { username: "wanderer", bot },
            displayAvatarURL: () =>
                "https://cdn.discordapp.com/embed/avatars/0.png",
            permissions: new PermissionsBitField(
                admin ? [PermissionFlagsBits.ManageGuild] : [],
            ),
            roles: { cache: new Collection(roles.map((id) => [id, { id }])) },
        } as unknown as GuildMember;
        roster.set(id, result);
        return result;
    }
    const opener = member(openerId);
    member(staffId, [roleId]);
    member(adminId, [], true);
    member(otherId);
    member(botId, [roleId], true, true);
    const config = ticketsSchema.parse({
        enabled: true,
        parent_channel_id: parentId,
        admin_channel_id: alertsId,
        mods_role_ids: [roleId],
    });
    const context = {
        botId,
        db,
        client: {
            rest: { delete: deleteAlert },
            users: { fetch: mock(async (_id: string) => ({ send: reviewDm })) },
            guilds: {
                cache: new Collection([[guildId, guild]]),
                fetch: mock(async (_id: string) => guild),
            },
        },
        settings: new SettingsStore(db, botId),
        state: new StateStore(db, botId),
        log: { warn: mock(() => {}), error: mock(() => {}) },
    } as unknown as Context;
    await context.settings.patch(guildId, "tickets", ticketsSchema, config);
    const repository = new TicketRepository(db, botId);
    const open = async (topic = "General support") =>
        (await openTicket(context, opener, config, topic)).thread_id;
    return {
        context,
        guild,
        guildId,
        opener,
        config,
        parent,
        alerts,
        discardAlert,
        deleteAlert,
        reviewDm,
        transcripts,
        roster,
        created,
        channels,
        repository,
        open,
    };
}

test("ticket numbers stay consistent in names, cards, command receipts and transcripts", async () => {
    const f = await fixture();
    const id = await f.open();
    const row = required(await f.repository.get(f.guildId, id));
    expect(row.ticket_number).toBe("1");
    expect(required(f.created[0]).setName).toHaveBeenCalledWith(
        "ticket-0001-wanderer",
    );
    expect(componentText(f.created[0]?.send.mock.calls[0]?.[0])).toContain(
        "Your ticket #0001 is open",
    );
    expect(componentText(f.alerts.send.mock.calls[0]?.[0])).toContain(
        "New support ticket #0001",
    );

    const editReply = mock(async (_payload: unknown) => {});
    await required(ticketsPlugin.commands?.[0]).execute(f.context, {
        guildId: f.guildId,
        guild: f.guild,
        member: f.opener,
        options: { getSubcommand: () => "open", getString: () => null },
        editReply,
    } as unknown as ChatInputCommandInteraction<"cached">);
    expect(componentText(editReply.mock.calls[0]?.[0])).toContain(
        "Your support ticket #0001",
    );
    expect(f.created).toHaveLength(1);

    f.config.transcript_channel_id = transcriptsId;
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        row,
        f.config,
        staffId,
        "Resolved",
    );
    const archive = f.transcripts.send.mock.calls[0]?.[0] as {
        files: AttachmentBuilder[];
    };
    expect(componentText(archive)).toContain("Ticket #0001 archive");
    const attachment = required(archive.files[1]);
    expect(attachment.name).toBe(`ticket-0001-${id}.txt`);
    expect(attachment.attachment.toString()).toContain(
        `Thread ID: ${id}\nServer ID: ${f.guildId}`,
    );
    expect(attachment.attachment.toString()).toContain("Ticket: #0001");
    expect(componentText(archive)).toContain("**Claimed by:** Unclaimed");
    expect(componentText(archive)).not.toContain("Member review");
    expect(archive.files[0]?.name).toBe(`ticket-0001-${id}.html`);

    const next = await f.open();
    expect((await f.repository.get(f.guildId, next))?.ticket_number).toBe("2");
    expect((await f.repository.get(f.guildId, id))?.ticket_number).toBe("1");
    expect(required(f.created[1]).setName).toHaveBeenCalledWith(
        "ticket-0002-wanderer",
    );
});

test("a failed Discord rename preserves the saved ticket and its numbered cards", async () => {
    const f = await fixture();
    const original = required(f.parent.threads.create.getMockImplementation());
    f.parent.threads.create.mockImplementation(async (options) => {
        const thread = await original(options);
        thread.setName.mockImplementation(async () => {
            throw new Error("Discord unavailable");
        });
        return thread;
    });
    const id = await f.open();
    expect((await f.repository.get(f.guildId, id))?.ticket_number).toBe("1");
    expect(required(f.created[0]).delete).not.toHaveBeenCalled();
    expect(componentText(f.created[0]?.send.mock.calls[0]?.[0])).toContain(
        "#0001",
    );
    expect(await f.open()).toBe(id);
});

test("number formatting never truncates or rounds IDs and sanitizes thread names", () => {
    expect(ticketLabel("1")).toBe("#0001");
    expect(ticketLabel("10000")).toBe("#10000");
    expect(ticketLabel("9007199254740993")).toBe("#9007199254740993");
    expect(ticketThreadName("10000", "🐇")).toBe("ticket-10000-member");
});

test("a submitted review updates the same archive and both files after the original thread is gone", async () => {
    const f = await fixture();
    const id = await f.open();
    await f.repository.claim(f.guildId, id, staffId);
    f.config.transcript_channel_id = transcriptsId;
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        required(await f.repository.get(f.guildId, id)),
        f.config,
        adminId,
        "Solved",
    );
    const original = f.transcripts.send.mock.calls[0]?.[0];
    expect(componentText(original)).toContain(`**Claimed by:** <@${staffId}>`);
    expect(componentText(original)).toContain(`**Closed by:** <@${adminId}>`);
    expect(componentText(original)).toContain("**Opened:** <t:");
    expect(componentText(original)).not.toContain("Member review");
    expect(f.context.log.warn).not.toHaveBeenCalled();
    f.channels.delete(id);
    f.config.transcript_channel_id = "400000000000000099";
    const [review] = await db.query<{ token: string }>(
        "select review_token::text as token from discord.tickets where bot_id=$1 and guild_id=$2 and thread_id=$3",
        [botId, f.guildId, id],
    );
    const reply = mock(async (_payload: unknown) => {});
    await handleTicketReview(f.context, {
        customId: `tickets:review:${required(review).token}:5`,
        guildId: null,
        user: { id: openerId },
        message: {
            id: "800000000000000001",
            author: { id: botId },
            edit: mock(async () => {}),
        },
        deferReply: mock(async () => {}),
        editReply: reply,
    } as unknown as ButtonInteraction);
    expect(componentText(reply.mock.calls[0]?.[0])).toContain("5/5");
    expect(f.transcripts.send).toHaveBeenCalledTimes(1);
    expect(f.transcripts.messages.edit).toHaveBeenCalledTimes(1);
    const [messageId, payload] = required(
        f.transcripts.messages.edit.mock.calls[0],
    );
    expect(messageId).toBe("900000000000000001");
    expect(componentText(payload)).toContain("### Member review\n⭐ **5/5**");
    expect(payload).toHaveProperty("attachments", []);
    for (const file of (payload as { files: AttachmentBuilder[] }).files)
        expect(file.attachment.toString()).toContain("5/5");
    expect(
        await new TranscriptRepository(db, botId).pending(f.guildId),
    ).toHaveLength(0);
    await syncTicketTranscript(f.context, f.guildId, id);
    expect(f.transcripts.messages.edit).toHaveBeenCalledTimes(1);
});

test("a failed close never publishes a completed archive and retry publishes only once", async () => {
    const f = await fixture();
    const id = await f.open();
    f.config.transcript_channel_id = transcriptsId;
    const row = required(await f.repository.get(f.guildId, id));
    required(f.created[0]).setArchived.mockImplementationOnce(async () => {
        throw new Error("Discord offline");
    });
    await expect(
        closeTicket(
            f.context,
            f.guild as unknown as Guild,
            row,
            f.config,
            staffId,
            "Done",
        ),
    ).rejects.toThrow("Discord offline");
    expect(f.transcripts.send).not.toHaveBeenCalled();
    expect(
        await new TranscriptRepository(db, botId).pending(f.guildId),
    ).toHaveLength(0);
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        row,
        f.config,
        staffId,
        "Done",
    );
    expect(f.transcripts.send).toHaveBeenCalledTimes(1);
});

test("failed transcript publication is retried after restart without losing the captured history", async () => {
    const f = await fixture();
    const id = await f.open();
    f.config.transcript_channel_id = transcriptsId;
    f.transcripts.send.mockImplementationOnce(async () => {
        throw new Error("Temporary failure");
    });
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        required(await f.repository.get(f.guildId, id)),
        f.config,
        staffId,
        "Done",
    );
    expect((await f.repository.get(f.guildId, id))?.status).toBe("closed");
    expect(
        await new TranscriptRepository(db, botId).pending(f.guildId),
    ).toHaveLength(1);
    f.channels.delete(id);
    await syncTicketTranscript(f.context, f.guildId, id);
    expect(f.transcripts.send).toHaveBeenCalledTimes(2);
    expect(
        await new TranscriptRepository(db, botId).pending(f.guildId),
    ).toHaveLength(0);
});

test("archive review updates retry permission failures and do not post into a now-public channel", async () => {
    const f = await fixture();
    const id = await f.open();
    f.config.transcript_channel_id = transcriptsId;
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        required(await f.repository.get(f.guildId, id)),
        f.config,
        staffId,
        "Done",
    );
    await db.query(
        "update discord.tickets set rating=4,reviewed_at=now() where bot_id=$1 and guild_id=$2 and thread_id=$3",
        [botId, f.guildId, id],
    );
    const original = f.transcripts.permissionsFor;
    f.transcripts.permissionsFor = () =>
        new PermissionsBitField(PermissionsBitField.All);
    await syncTicketTranscript(f.context, f.guildId, id);
    expect(f.transcripts.messages.edit).not.toHaveBeenCalled();
    expect(
        await new TranscriptRepository(db, botId).pending(f.guildId),
    ).toHaveLength(1);
    f.transcripts.permissionsFor = original;
    await syncTicketTranscript(f.context, f.guildId, id);
    expect(f.transcripts.send).toHaveBeenCalledTimes(1);
    expect(
        componentText(f.transcripts.messages.edit.mock.calls[0]?.[1]),
    ).toContain("4/5");
});

test("publishing an older archive snapshot cannot swallow a concurrently submitted rating", async () => {
    const f = await fixture();
    const id = await f.open();
    f.config.transcript_channel_id = transcriptsId;
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        required(await f.repository.get(f.guildId, id)),
        f.config,
        staffId,
        "Done",
    );
    const repository = new TranscriptRepository(db, botId);
    const before = required(await repository.get(f.guildId, id));
    await db.query(
        "update discord.tickets set rating=5,reviewed_at=now() where bot_id=$1 and guild_id=$2 and thread_id=$3",
        [botId, f.guildId, id],
    );
    await repository.published(before, "900000000000000001");
    expect(await repository.pending(f.guildId)).toHaveLength(1);
    await syncTicketTranscript(f.context, f.guildId, id);
    expect(await repository.pending(f.guildId)).toHaveLength(0);
});

test("simultaneous opens create one private thread without automatically adding staff or admins", async () => {
    const f = await fixture();
    const ids = await Promise.all(Array.from({ length: 8 }, () => f.open()));
    expect(new Set(ids).size).toBe(1);
    expect(f.parent.threads.create).toHaveBeenCalledTimes(1);
    expect(f.parent.threads.create.mock.calls[0]?.[0]).toMatchObject({
        type: ChannelType.PrivateThread,
        invitable: false,
    });
    expect(f.guild.channels.create).not.toHaveBeenCalled();
    const thread = required(f.created[0]);
    expect(
        new Set(thread.members.add.mock.calls.map((call) => call[0])),
    ).toEqual(new Set([openerId]));
    expect(f.guild.members.fetch).not.toHaveBeenCalled();
    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    expect(await f.repository.open(f.guildId, openerId)).toHaveLength(1);
});

function joinButton(
    f: Awaited<ReturnType<typeof fixture>>,
    threadId: string,
    userId = staffId,
) {
    return {
        customId: `tickets:join:${threadId}`,
        guildId: f.guildId,
        guild: f.guild,
        channelId: alertsId,
        user: { id: userId },
        member: f.roster.get(userId),
        message: { id: "700000000000000001", author: { id: botId } },
        isButton: () => true,
        isMessageComponent: () => true,
        isModalSubmit: () => false,
        deferReply: mock(async (_payload: unknown) => {}),
        editReply: mock(async (_payload: unknown) => {}),
    };
}

for (const userId of [staffId, adminId]) {
    test(`staff ${userId} join only when they choose the alert button, without claiming or notifying`, async () => {
        const f = await fixture();
        const id = await f.open();
        const thread = required(f.created[0]);
        const before = await f.repository.get(f.guildId, id);
        const payload = JSON.stringify(f.alerts.send.mock.calls[0]?.[0]);
        expect(payload).toContain(`"custom_id":"tickets:join:${id}"`);
        expect(payload).toContain('"label":"Join ticket"');
        expect(thread.members.add.mock.calls).toEqual([[openerId]]);
        const interaction = joinButton(f, id, userId);
        await ticketsPlugin.component?.(
            f.context,
            interaction as unknown as ButtonInteraction<"cached">,
        );
        expect(thread.members.add.mock.calls).toEqual([[openerId], [userId]]);
        expect(f.guild.members.fetch).toHaveBeenCalledWith({
            user: userId,
            force: true,
        });
        expect(interaction.deferReply).toHaveBeenCalledWith({
            flags: MessageFlags.Ephemeral,
        });
        expect(
            componentText(interaction.editReply.mock.calls[0]?.[0]),
        ).toContain(`<#${id}>`);
        expect(await f.repository.get(f.guildId, id)).toEqual(before);
        expect(thread.send).toHaveBeenCalledTimes(1);
        expect(f.alerts.send).toHaveBeenCalledTimes(1);
    });
}

test("staff can join an auto-archived ongoing ticket from its original alert while tickets are paused", async () => {
    const f = await fixture();
    const id = await f.open();
    const thread = required(f.created[0]);
    thread.archived = true;
    await f.context.settings.patch(f.guildId, "tickets", ticketsSchema, {
        enabled: false,
        admin_channel_id: "400000000000000099",
    });
    await ticketsPlugin.component?.(
        f.context,
        joinButton(f, id) as unknown as ButtonInteraction<"cached">,
    );
    expect(thread.archived).toBe(false);
    expect(thread.members.add.mock.calls).toEqual([[openerId], [staffId]]);
});

for (const userId of [openerId, otherId]) {
    test(`non-staff ${userId} cannot use a staff join button`, async () => {
        const f = await fixture();
        const id = await f.open();
        const interaction = joinButton(f, id, userId);
        await expect(
            ticketsPlugin.component?.(
                f.context,
                interaction as unknown as ButtonInteraction<"cached">,
            ),
        ).rejects.toThrow("Only ticket staff");
        expect(interaction.deferReply).toHaveBeenCalledWith({
            flags: MessageFlags.Ephemeral,
        });
        expect(f.created[0]?.members.add.mock.calls).toEqual([[openerId]]);
    });
}

test("a revoked staff role cannot join using a stale interaction member", async () => {
    const f = await fixture();
    const id = await f.open();
    const interaction = joinButton(f, id);
    const member = required(f.roster.get(staffId));
    f.roster.set(staffId, {
        ...member,
        roles: { cache: new Collection() },
    } as unknown as GuildMember);
    await expect(
        ticketsPlugin.component?.(
            f.context,
            interaction as unknown as ButtonInteraction<"cached">,
        ),
    ).rejects.toThrow("Only ticket staff");
    expect(f.created[0]?.members.add.mock.calls).toEqual([[openerId]]);
});

for (const scenario of [
    "malformed",
    "other-author",
    "other-message",
    "other-channel",
    "other-guild",
    "other-bot",
    "closed",
    "missing",
    "locked",
    "public",
    "denied",
] as const) {
    test(`staff join rejects ${scenario} tickets or buttons without granting access`, async () => {
        const f = await fixture();
        const id = await f.open();
        const thread = required(f.created[0]);
        const interaction = joinButton(f, id);
        if (scenario === "malformed")
            interaction.customId = "tickets:join:invalid";
        if (scenario === "other-author")
            interaction.message.author.id = otherId;
        if (scenario === "other-message")
            interaction.message.id = "700000000000000099";
        if (scenario === "other-channel") interaction.channelId = parentId;
        if (scenario === "other-guild")
            interaction.guildId = "200000000000000099";
        if (scenario === "other-bot") {
            f.context.botId = "100000000000000099";
            interaction.message.author.id = f.context.botId;
        }
        if (scenario === "closed")
            await f.repository.close(f.guildId, id, staffId, "Done");
        if (scenario === "missing") f.channels.delete(id);
        if (scenario === "locked") thread.locked = true;
        if (scenario === "public") thread.type = ChannelType.PublicThread;
        if (scenario === "denied")
            thread.permissionsFor.mockReturnValue(new PermissionsBitField());
        await expect(
            ticketsPlugin.component?.(
                f.context,
                interaction as unknown as ButtonInteraction<"cached">,
            ),
        ).rejects.toThrow();
        expect(thread.members.add.mock.calls).toEqual([[openerId]]);
        expect(thread.setArchived).not.toHaveBeenCalled();
        expect(interaction.editReply).not.toHaveBeenCalled();
    });
}

test("failed manual staff invitations preserve the ticket and can be retried", async () => {
    const f = await fixture();
    const id = await f.open();
    const thread = required(f.created[0]);
    thread.members.add.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(
        ticketsPlugin.component?.(
            f.context,
            joinButton(f, id) as unknown as ButtonInteraction<"cached">,
        ),
    ).rejects.toThrow("Discord unavailable");
    expect((await f.repository.get(f.guildId, id))?.status).toBe("open");
    expect(thread.delete).not.toHaveBeenCalled();
    await ticketsPlugin.component?.(
        f.context,
        joinButton(f, id) as unknown as ButtonInteraction<"cached">,
    );
    expect(thread.members.add).toHaveBeenLastCalledWith(staffId);
});

test("staff tags appear only in alerts, and the thread can mention only its opener", async () => {
    const f = await fixture();
    await f.open(`@everyone <@${otherId}> <@&500000000000000099>`);
    const alert = f.alerts.send.mock.calls[0]?.[0];
    const intro = f.created[0]?.send.mock.calls[0]?.[0];
    for (const payload of [alert, intro]) {
        expect(payload).toHaveProperty("flags", MessageFlags.IsComponentsV2);
        expect(payload).not.toHaveProperty("embeds");
    }
    expect(componentText(alert)).toContain(`<@&${roleId}>`);
    expect(componentText(intro)).not.toContain(`<@&${roleId}>`);
    expect(componentText(intro)).not.toContain("Ticket staff:");
    expect(alert).toHaveProperty("allowedMentions", {
        parse: [],
        repliedUser: false,
        roles: [roleId],
    });
    expect(intro).toHaveProperty("allowedMentions", {
        parse: [],
        repliedUser: false,
        users: [openerId],
        roles: [],
    });
    expect(componentText(intro)).toContain("Only ticket staff can close it");
});

for (const mode of ["absent", "failed"] as const) {
    test(`staff are never tagged inside the thread when alerts are ${mode}`, async () => {
        const f = await fixture();
        if (mode === "absent") f.config.admin_channel_id = null;
        else
            f.alerts.send.mockImplementation(async () => {
                throw new Error("Missing access");
            });
        await f.open();
        expect(f.created[0]?.send.mock.calls[0]?.[0]).toHaveProperty(
            "allowedMentions.roles",
            [],
        );
        expect(
            componentText(f.created[0]?.send.mock.calls[0]?.[0]),
        ).not.toContain(`<@&${roleId}>`);
    });
}

test("claimed and auto-archived tickets retain the slot and reopen without repeat notifications", async () => {
    const f = await fixture();
    const id = await f.open();
    await f.repository.claim(f.guildId, id, staffId);
    required(f.created[0]).archived = true;
    expect(await f.open()).toBe(id);
    expect(required(f.created[0]).archived).toBe(false);
    expect(f.parent.threads.create).toHaveBeenCalledTimes(1);
    expect(f.alerts.send).toHaveBeenCalledTimes(1);
    expect(required(f.created[0]).send).toHaveBeenCalledTimes(1);
});

test("missing ongoing tickets do not silently allow another open ticket", async () => {
    const f = await fixture();
    const id = await f.open();
    f.channels.delete(id);
    await expect(f.open()).rejects.toThrow("ongoing ticket is unavailable");
    expect(f.parent.threads.create).toHaveBeenCalledTimes(1);
});

test("members cannot close through either the command or the shared service", async () => {
    const f = await fixture();
    const id = await f.open();
    const row = required(await f.repository.get(f.guildId, id));
    await expect(
        closeTicket(
            f.context,
            f.guild as unknown as Guild,
            row,
            f.config,
            openerId,
            "Done",
        ),
    ).rejects.toThrow("Only ticket staff");
    await expect(
        required(ticketsPlugin.commands?.[0]).execute(f.context, {
            guildId: f.guildId,
            channelId: id,
            guild: f.guild,
            member: f.opener,
            user: { id: openerId },
            options: { getSubcommand: () => "close" },
        } as unknown as ChatInputCommandInteraction<"cached">),
    ).rejects.toThrow("Only ticket staff");
    expect(required(f.created[0]).setLocked).not.toHaveBeenCalled();
    expect((await f.repository.get(f.guildId, id))?.status).toBe("open");
});

for (const closer of [staffId, adminId]) {
    test(`authorized staff ${closer} can close, archive and release the ticket slot`, async () => {
        const f = await fixture();
        const id = await f.open();
        const row = required(await f.repository.get(f.guildId, id));
        await closeTicket(
            f.context,
            f.guild as unknown as Guild,
            row,
            f.config,
            closer,
            "Resolved",
        );
        expect(f.created[0]).toMatchObject({ locked: true, archived: true });
        expect((await f.repository.get(f.guildId, id))?.status).toBe("closed");
        expect(await f.open()).not.toBe(id);
        expect(f.parent.threads.create).toHaveBeenCalledTimes(2);
    });
}

test("a failed archive keeps the ticket open and allows staff to retry", async () => {
    const f = await fixture();
    const id = await f.open();
    const row = required(await f.repository.get(f.guildId, id));
    required(f.created[0]).setArchived.mockImplementationOnce(async () => {
        throw new Error("Discord unavailable");
    });
    await expect(
        closeTicket(
            f.context,
            f.guild as unknown as Guild,
            row,
            f.config,
            staffId,
            "Done",
        ),
    ).rejects.toThrow("Discord unavailable");
    expect((await f.repository.get(f.guildId, id))?.status).toBe("open");
    expect(f.deleteAlert).not.toHaveBeenCalled();
    expect(f.reviewDm).not.toHaveBeenCalled();
    expect(await f.open()).toBe(id);
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        row,
        f.config,
        staffId,
        "Done",
    );
    expect((await f.repository.get(f.guildId, id))?.status).toBe("closed");
});

test("closing removes the original staff alert after archive and commit, even after settings change", async () => {
    const f = await fixture();
    const id = await f.open();
    const row = required(
        await new TicketRepository(db, botId).get(f.guildId, id),
    );
    expect(row.staff_alert_channel_id).toBe(alertsId);
    expect(row.staff_alert_message_id).toBe("700000000000000001");
    f.config.admin_channel_id = "400000000000000099";
    f.deleteAlert.mockImplementation(async (route) => {
        expect(route).toBe(`/channels/${alertsId}/messages/700000000000000001`);
        expect(required(f.created[0])).toMatchObject({
            locked: true,
            archived: true,
        });
        expect((await f.repository.get(f.guildId, id))?.status).toBe("closed");
    });
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        row,
        f.config,
        staffId,
        "Resolved",
    );
    expect(f.deleteAlert).toHaveBeenCalledTimes(1);
    expect(
        (await f.repository.get(f.guildId, id))?.staff_alert_deleted_at,
    ).not.toBeNull();
    expect(await f.repository.pendingStaffAlerts(f.guildId)).toEqual([]);
    expect(required(f.created[0]).delete).not.toHaveBeenCalled();
    // Repeated closure is harmless and never sends another transcript.
    expect(f.reviewDm).toHaveBeenCalledTimes(1);
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        row,
        f.config,
        staffId,
        "Resolved",
    );
    expect(f.deleteAlert).toHaveBeenCalledTimes(1);
});

test("failed alert deletion does not block closure and is retried with tickets disabled", async () => {
    const f = await fixture();
    const id = await f.open();
    const row = required(await f.repository.get(f.guildId, id));
    f.deleteAlert.mockImplementationOnce(async () => {
        throw new Error("Missing access");
    });
    await closeTicket(
        f.context,
        f.guild as unknown as Guild,
        row,
        f.config,
        botId,
        "Inactive",
    );
    expect((await f.repository.get(f.guildId, id))?.status).toBe("closed");
    expect(
        await new TicketRepository(db, botId).pendingStaffAlerts(f.guildId),
    ).toHaveLength(1);
    await f.context.settings.patch(f.guildId, "tickets", ticketsSchema, {
        enabled: false,
    });
    let tick: (() => Promise<void>) | undefined;
    required(ticketsPlugin.register)(f.context, {
        on: () => {},
        every: (_interval, task) => {
            tick = task;
        },
    } as EventRegistrar);
    await required(tick)();
    expect(f.deleteAlert).toHaveBeenCalledTimes(2);
    expect(await f.repository.pendingStaffAlerts(f.guildId)).toEqual([]);
});

for (const code of [10008, 10003]) {
    test(`missing Discord alert/channel (${code}) is treated as already deleted`, async () => {
        const f = await fixture();
        const id = await f.open();
        f.deleteAlert.mockImplementation(async () => {
            throw Object.assign(new Error("Not found"), { code });
        });
        await closeTicket(
            f.context,
            f.guild as unknown as Guild,
            required(await f.repository.get(f.guildId, id)),
            f.config,
            staffId,
            "Done",
        );
        expect(await f.repository.pendingStaffAlerts(f.guildId)).toEqual([]);
        expect(
            (await f.repository.get(f.guildId, id))?.staff_alert_deleted_at,
        ).not.toBeNull();
    });
}

test("an ongoing ticket never has its staff alert removed", async () => {
    const f = await fixture();
    const id = await f.open();
    const row = required(await f.repository.get(f.guildId, id));
    await removeClosedTicketAlert(f.context, f.guildId, row);
    expect(f.deleteAlert).not.toHaveBeenCalled();
});

test("an alert posted during closure is still tracked and removed", async () => {
    const f = await fixture();
    f.context.db = {
        ...db,
        query: async (sql, params) => {
            if (
                sql.startsWith(
                    "update discord.tickets set staff_alert_channel_id=",
                )
            ) {
                await f.repository.close(
                    f.guildId,
                    required(f.created[0]).id,
                    staffId,
                    "Closed immediately",
                );
            }
            return db.query(sql, params);
        },
    } as Database;
    const id = await f.open();
    expect(
        (await f.repository.get(f.guildId, id))?.staff_alert_deleted_at,
    ).not.toBeNull();
    expect(f.deleteAlert).toHaveBeenCalledTimes(1);
});

test("an untracked alert is discarded if saving its reference fails", async () => {
    const f = await fixture();
    f.context.db = {
        ...db,
        query: async (sql, params) => {
            if (
                sql.startsWith(
                    "update discord.tickets set staff_alert_channel_id=",
                )
            )
                throw new Error("Database unavailable");
            return db.query(sql, params);
        },
    } as Database;
    const id = await f.open();
    expect(f.discardAlert).toHaveBeenCalledTimes(1);
    expect((await f.repository.get(f.guildId, id))?.status).toBe("open");
    expect(f.created[0]?.send).toHaveBeenCalledTimes(1);
});

test("database uniqueness includes claimed tickets and is isolated by member, server and bot", async () => {
    const f = await fixture();
    const id = await f.open();
    await f.repository.claim(f.guildId, id, staffId);
    await expect(
        f.repository.create(
            f.guildId,
            "600000000000000099",
            openerId,
            "Duplicate",
        ),
    ).rejects.toThrow("idx_caretaker_one_open_ticket");
    await f.repository.create(
        f.guildId,
        "600000000000000098",
        otherId,
        "Other member",
    );
    await f.repository.create(
        "200000000000000099",
        "600000000000000097",
        openerId,
        "Other server",
    );
    await new TicketRepository(db, "100000000000000099").create(
        f.guildId,
        id,
        openerId,
        "Other bot",
    );
    expect(await f.repository.open(f.guildId, openerId)).toHaveLength(1);
});

test("failed participant setup removes the incomplete thread and never reserves an open ticket", async () => {
    const f = await fixture();
    const original = required(f.parent.threads.create.getMockImplementation());
    f.parent.threads.create.mockImplementation(async (options) => {
        const thread = await original(options);
        thread.members.add.mockImplementation(async (id) => {
            if (id === openerId) throw new Error("Cannot invite opener");
        });
        return thread;
    });
    await expect(f.open()).rejects.toThrow("Cannot invite opener");
    expect(required(f.created[0]).delete).toHaveBeenCalledTimes(1);
    expect(await f.repository.open(f.guildId, openerId)).toHaveLength(0);
    expect(f.alerts.send).not.toHaveBeenCalled();
});

test("an insert acknowledged late never deletes its successfully recorded thread", async () => {
    const f = await fixture();
    f.context.db = {
        ...db,
        query: async (sql, params) => {
            const result = await db.query(sql, params);
            if (sql.startsWith("insert into discord.tickets"))
                throw new Error("Connection dropped after commit");
            return result;
        },
    } as Database;
    const id = await f.open();
    expect(required(f.created[0]).delete).not.toHaveBeenCalled();
    expect((await f.repository.get(f.guildId, id))?.status).toBe("open");
});

test("a competing database winner is reused and only the losing thread is removed", async () => {
    const f = await fixture();
    f.context.db = {
        ...db,
        query: async (sql, params) => {
            if (sql.startsWith("insert into discord.tickets")) {
                await f.repository.create(
                    f.guildId,
                    "600000000000000099",
                    openerId,
                    "Winner",
                );
            }
            return db.query(sql, params);
        },
    } as Database;
    expect(await f.open()).toBe("600000000000000099");
    expect(required(f.created[0]).delete).toHaveBeenCalledTimes(1);
    expect(f.alerts.send).not.toHaveBeenCalled();
});

test("invalid parent or inaccessible opener abort before creating a thread", async () => {
    const f = await fixture();
    f.parent.type = ChannelType.GuildCategory;
    await expect(f.open()).rejects.toThrow("server text channel");
    f.parent.type = ChannelType.GuildText;
    f.parent.permissionsFor.mockImplementation(
        (member) =>
            new PermissionsBitField(
                member.id === openerId ? [] : PermissionsBitField.All,
            ),
    );
    await expect(f.open()).rejects.toThrow("You need View Channel");
    expect(f.parent.threads.create).not.toHaveBeenCalled();
});

test("existing text-channel tickets are preserved and the panel is a valid fallback parent", async () => {
    const f = await fixture();
    f.config.parent_channel_id = null;
    f.config.panel_channel_id = parentId;
    const id = await f.open();
    required(f.created[0]).isThread = () => false;
    expect(await f.open()).toBe(id);
    expect(f.parent.threads.create).toHaveBeenCalledTimes(1);
    expect(required(f.created[0]).delete).not.toHaveBeenCalled();
});

const idleStart = Date.parse("2026-01-01T00:00:00Z");
const threeDays = 3 * 86400000;
const halfHour = 30 * 60000;

async function idleFixture() {
    const f = await fixture();
    const id = await f.open();
    const thread = required(f.channels.get(id));
    thread.send.mockClear();
    f.config.auto_close.enabled = true;
    await f.context.settings.patch(
        f.guildId,
        "tickets",
        ticketsSchema,
        f.config,
    );
    await db.query(
        "update discord.tickets set last_activity_at=$3 where bot_id=$1 and guild_id=$2",
        [botId, f.guildId, new Date(idleStart)],
    );
    const row = async () => required(await f.repository.get(f.guildId, id));
    const check = async (at: number) =>
        checkTicketInactivity(
            f.context,
            f.guild as unknown as Guild,
            await row(),
            f.config,
            () => at,
        );
    const reply = async (at: number, author = openerId) =>
        f.repository.touch(f.guildId, id, author, new Date(at));
    const message = (at: number, author = openerId) =>
        ({
            id: String(BigInt(at) * 1000n),
            createdTimestamp: at,
            author: { id: author, bot: false },
        }) as Message;
    return { ...f, id, thread, row, check, reply, message };
}

test("inactivity warns at 2d23h30m, persists across checks, then uses the normal archive/review flow", async () => {
    const f = await idleFixture();
    f.config.transcript_channel_id = transcriptsId;
    await f.context.settings.patch(
        f.guildId,
        "tickets",
        ticketsSchema,
        f.config,
    );
    await f.check(idleStart + threeDays - halfHour - 1);
    expect(f.thread.send).not.toHaveBeenCalled();
    f.thread.archived = true;
    await f.check(idleStart + threeDays - halfHour);
    expect(f.thread.archived).toBe(false);
    expect(f.thread.send).toHaveBeenCalledTimes(1);
    const payload = f.thread.send.mock.calls[0]?.[0];
    expect(componentText(payload)).toContain(`<@${openerId}>`);
    expect(componentText(payload)).toContain("restart the inactivity timer");
    expect(componentText(payload)).not.toContain(`<@&${roleId}>`);
    expect(payload).toMatchObject({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], users: [openerId], roles: [] },
    });
    expect(
        new Date(
            required((await f.row()).inactivity_close_at ?? undefined),
        ).getTime(),
    ).toBe(idleStart + threeDays);
    // Fresh repositories/settings simulate restart: no in-memory timer is needed.
    f.context.settings = new SettingsStore(db, botId);
    await f.check(idleStart + threeDays - 1);
    expect(f.thread.send).toHaveBeenCalledTimes(1);
    expect((await f.row()).status).toBe("open");
    await f.check(idleStart + threeDays);
    expect((await f.row()).status).toBe("closed");
    expect(f.thread.locked).toBe(true);
    expect(f.thread.archived).toBe(true);
    expect(f.deleteAlert).toHaveBeenCalledTimes(1);
    expect(f.transcripts.send).toHaveBeenCalledTimes(1);
    expect(f.reviewDm).toHaveBeenCalledTimes(1);
});

test("only new opener messages reset a claimed ticket; staff and out-of-order events do not", async () => {
    const f = await idleFixture();
    await f.repository.claim(f.guildId, f.id, staffId);
    await f.check(idleStart + threeDays - halfHour);
    await f.reply(idleStart + threeDays - 1000, staffId);
    expect((await f.row()).inactivity_close_at).not.toBeNull();
    const replyAt = idleStart + threeDays - 500;
    await f.reply(replyAt);
    expect((await f.row()).inactivity_close_at).toBeNull();
    await f.check(idleStart + threeDays);
    expect((await f.row()).status).toBe("open");
    await f.check(replyAt + threeDays - halfHour);
    expect(f.thread.send).toHaveBeenCalledTimes(2);
    await f.reply(replyAt); // Duplicate delivery cannot cancel a newer warning.
    await f.reply(replyAt - 1);
    expect((await f.row()).inactivity_close_at).not.toBeNull();
    expect(new Date((await f.row()).last_activity_at).getTime()).toBe(replyAt);
});

test("an overdue ticket gets the full warning period after downtime", async () => {
    const f = await idleFixture();
    const resumed = idleStart + threeDays + 86400000;
    await f.check(resumed);
    expect(
        new Date(
            required((await f.row()).inactivity_close_at ?? undefined),
        ).getTime(),
    ).toBe(resumed + halfHour);
    await f.check(resumed + halfHour - 1);
    expect((await f.row()).status).toBe("open");
    await f.check(resumed + halfHour);
    expect((await f.row()).status).toBe("closed");
});

test("history repairs opener messages missed while offline before sending a warning", async () => {
    const f = await idleFixture();
    const openerReply = f.message(idleStart + threeDays - 60000);
    const staffReply = f.message(idleStart + threeDays - 10000, staffId);
    f.thread.messages.fetch.mockResolvedValue(
        new Collection([
            [staffReply.id, staffReply],
            [openerReply.id, openerReply],
        ]),
    );
    await f.check(idleStart + threeDays);
    expect(f.thread.send).not.toHaveBeenCalled();
    expect(new Date((await f.row()).last_activity_at).getTime()).toBe(
        openerReply.createdTimestamp,
    );
    expect((await f.row()).status).toBe("open");
});

test("failed warning delivery cannot start a closing deadline", async () => {
    const f = await idleFixture();
    f.thread.send.mockRejectedValueOnce(new Error("Missing Send Messages"));
    await expect(f.check(idleStart + threeDays)).rejects.toThrow(
        "Missing Send Messages",
    );
    expect((await f.row()).inactivity_close_at).toBeNull();
    expect((await f.row()).status).toBe("open");
    await f.check(idleStart + threeDays + 60000);
    expect(
        new Date(
            required((await f.row()).inactivity_close_at ?? undefined),
        ).getTime(),
    ).toBe(idleStart + threeDays + 60000 + halfHour);
});

test("a reply racing the warning send cancels and removes the obsolete warning", async () => {
    const f = await idleFixture();
    const remove = mock(async () => {});
    f.thread.send.mockImplementationOnce(async () => {
        await f.reply(idleStart + threeDays - 1000);
        return { id: "800000000000000002", delete: remove };
    });
    await f.check(idleStart + threeDays);
    expect((await f.row()).inactivity_close_at).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
});

test("a last-second opener reply during locking cancels closure and restores the thread", async () => {
    const f = await idleFixture();
    await f.check(idleStart + threeDays - halfHour);
    f.thread.setLocked.mockImplementationOnce(async () => {
        f.thread.locked = true;
        const message = f.message(idleStart + threeDays - 1);
        // Simulates a REST-visible reply before its gateway event has been handled.
        f.thread.messages.fetch.mockResolvedValue(
            new Collection([[message.id, message]]),
        );
    });
    await f.check(idleStart + threeDays);
    expect((await f.row()).status).toBe("open");
    expect((await f.row()).inactivity_close_at).toBeNull();
    expect(f.thread.locked).toBe(false);
    expect(f.thread.archived).toBe(false);
    expect(f.reviewDm).not.toHaveBeenCalled();
    expect(f.deleteAlert).not.toHaveBeenCalled();
});

test("unreadable history or unknown role permissions postpone automatic closure", async () => {
    const f = await idleFixture();
    await f.check(idleStart + threeDays - halfHour);
    f.thread.messages.fetch.mockRejectedValueOnce(
        new Error("Missing history permission"),
    );
    await expect(f.check(idleStart + threeDays)).rejects.toThrow(
        "Missing history",
    );
    f.guild.members.fetch.mockRejectedValueOnce(
        new Error("Unavailable member list"),
    );
    await expect(f.check(idleStart + threeDays)).rejects.toThrow(
        "Unavailable member",
    );
    expect((await f.row()).status).toBe("open");
    expect(f.reviewDm).not.toHaveBeenCalled();
});

test("role exemptions and disabled auto-close clear pending warnings", async () => {
    const f = await idleFixture();
    await f.check(idleStart + threeDays - halfHour);
    f.config.role_time_limits.excluded = [roleId];
    f.opener.roles.cache.set(roleId, { id: roleId } as never);
    await f.check(idleStart + threeDays);
    expect((await f.row()).inactivity_close_at).toBeNull();
    f.config.role_time_limits.excluded = [];
    await f.check(idleStart + threeDays);
    f.config.auto_close.enabled = false;
    await f.check(idleStart + threeDays + halfHour);
    expect((await f.row()).inactivity_close_at).toBeNull();
    expect((await f.row()).status).toBe("open");
});

test("changing the timeout replaces old deadlines and short role timeouts cap warning lead", async () => {
    const f = await idleFixture();
    await f.check(idleStart + threeDays - halfHour);
    f.config.auto_close.threshold_ms = threeDays * 2;
    await f.check(idleStart + threeDays);
    expect((await f.row()).inactivity_close_at).toBeNull();
    f.opener.roles.cache.set(roleId, { id: roleId } as never);
    f.config.role_time_limits.included = [
        { role_id: roleId, threshold_seconds: 60 },
    ];
    await f.check(idleStart + threeDays);
    expect(
        new Date(
            required((await f.row()).inactivity_close_at ?? undefined),
        ).getTime(),
    ).toBe(idleStart + threeDays + 60000);
});

test("database closure compare-and-set rejects a reply after the final history check", async () => {
    const f = await idleFixture();
    await f.check(idleStart + threeDays - halfHour);
    const expected = await f.row();
    await f.reply(idleStart + threeDays - 1);
    expect(
        await f.repository.close(f.guildId, f.id, botId, "Inactive", expected),
    ).toBe(false);
    expect((await f.row()).status).toBe("open");
});

test("missing Read Message History never treats an empty history as inactivity", async () => {
    const f = await idleFixture();
    f.thread.permissionsFor.mockReturnValue(
        new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    );
    await expect(f.check(idleStart + threeDays)).rejects.toThrow(
        "Read Message History",
    );
    expect(f.thread.messages.fetch).not.toHaveBeenCalled();
    expect(f.thread.send).not.toHaveBeenCalled();
    expect((await f.row()).status).toBe("open");
});

test("history scans past 100 staff messages to recover a missed opener reply", async () => {
    const f = await idleFixture();
    const staffMessages = Array.from({ length: 100 }, (_, i) =>
        f.message(idleStart + threeDays - i, staffId),
    );
    const reply = f.message(idleStart + threeDays - 60000);
    f.thread.messages.fetch
        .mockResolvedValueOnce(
            new Collection(staffMessages.map((m) => [m.id, m])),
        )
        .mockResolvedValueOnce(new Collection([[reply.id, reply]]));
    await f.check(idleStart + threeDays);
    expect(f.thread.messages.fetch).toHaveBeenCalledTimes(2);
    expect(f.thread.send).not.toHaveBeenCalled();
    expect(new Date((await f.row()).last_activity_at).getTime()).toBe(
        reply.createdTimestamp,
    );
});

test("message event tracks opener replies even while tickets are paused", async () => {
    const f = await idleFixture();
    await f.check(idleStart + threeDays - halfHour);
    await f.context.settings.patch(f.guildId, "tickets", ticketsSchema, {
        enabled: false,
    });
    let handler: ((message: Message) => Promise<void>) | undefined;
    ticketsPlugin.register?.(f.context, {
        on: (_event, listener) => {
            handler = listener as typeof handler;
        },
        every: () => {},
    });
    const dispatch = required(handler);
    const createdAt = new Date(idleStart + threeDays - 1);
    await dispatch({
        guildId: f.guildId,
        channelId: f.id,
        author: { id: staffId, bot: false },
        createdAt,
    } as Message);
    expect((await f.row()).inactivity_close_at).not.toBeNull();
    await dispatch({
        guildId: f.guildId,
        channelId: f.id,
        author: { id: openerId, bot: false },
        createdAt,
    } as Message);
    expect((await f.row()).inactivity_close_at).toBeNull();
    expect(new Date((await f.row()).last_activity_at).getTime()).toBe(
        createdAt.getTime(),
    );
});
