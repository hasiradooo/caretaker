import type { Client, Guild } from "discord.js";
import type { Environment } from "../config/environment";
import type { Database } from "./connection";
import { encryptToken } from "./encryption";

export class BotRepository {
    constructor(
        private readonly db: Database,
        private readonly botId: string,
    ) {}

    async sync(client: Client<true>, env: Environment): Promise<void> {
        if (client.user.id !== this.botId)
            throw new Error(
                "DISCORD_CLIENT_ID does not match the logged-in bot. Startup stopped to protect existing data.",
            );
        await this.db.transaction(async (tx) => {
            const [existing] = await tx.query(
                "select id from discord.bots where id=$1",
                [this.botId],
            );
            if (!existing) {
                // Preserve legacy self-owned rows; explicit BOT_OWNER_ID supports provisioned bots.
                const ownerId = env.BOT_OWNER_ID ?? this.botId;
                await tx.query(
                    "insert into discord.platform_users (id,username) values ($1,$2) on conflict do nothing",
                    [
                        ownerId,
                        ownerId === this.botId
                            ? client.user.username
                            : "Bot owner",
                    ],
                );
                await tx.query(
                    "insert into discord.bots (id,owner_id,name,encrypted_token,status) values ($1,$2,$3,$4,'running') on conflict do nothing",
                    [
                        this.botId,
                        ownerId,
                        client.user.username,
                        encryptToken(
                            env.DISCORD_TOKEN,
                            env.MASTER_ENCRYPTION_KEY,
                        ),
                    ],
                );
            }
            await tx.query(
                "update discord.bots set name=$2,avatar_url=$3,status='running',error_msg=null where id=$1",
                [
                    this.botId,
                    client.user.username,
                    client.user.displayAvatarURL(),
                ],
            );
        });
        for (const guild of client.guilds.cache.values())
            await this.syncGuild(guild);
    }

    async syncGuild(guild: Guild): Promise<void> {
        await this.db.query(
            `insert into discord.guilds (bot_id,guild_id,name,icon_url,member_count) values ($1,$2,$3,$4,$5)
      on conflict (bot_id,guild_id) do update set name=excluded.name,icon_url=excluded.icon_url,member_count=excluded.member_count`,
            [
                this.botId,
                guild.id,
                guild.name,
                guild.iconURL(),
                guild.memberCount,
            ],
        );
    }

    async stopped(): Promise<void> {
        await this.db.query(
            "update discord.bots set status='stopped' where id=$1",
            [this.botId],
        );
    }
}
