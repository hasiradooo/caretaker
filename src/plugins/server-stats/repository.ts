import type { Database } from "../../database/connection";
import type { CounterKind } from "./config";

export interface StatChannel {
    counter: CounterKind;
    creation_token: string;
    channel_id: string | null;
    last_name: string | null;
    renamed_at: Date | string | null;
}
export class StatChannelRepository {
    constructor(
        private readonly db: Database,
        private readonly botId: string,
    ) {}

    list(guildId: string): Promise<StatChannel[]> {
        return this.db.query<StatChannel>(
            "select counter,creation_token,channel_id,last_name,renamed_at from discord.server_stat_channels where bot_id=$1 and guild_id=$2",
            [this.botId, guildId],
        );
    }
    async prepare(guildId: string, counter: CounterKind): Promise<StatChannel> {
        await this.db.query(
            "insert into discord.server_stat_channels (bot_id,guild_id,counter,creation_token) values ($1,$2,$3,$4) on conflict do nothing",
            [this.botId, guildId, counter, crypto.randomUUID()],
        );
        const row = (await this.list(guildId)).find(
            (item) => item.counter === counter,
        );
        if (!row) throw new Error("Stats channel record disappeared.");
        return row;
    }
    async attach(
        guildId: string,
        counter: CounterKind,
        channelId: string,
    ): Promise<void> {
        await this.db.query(
            "update discord.server_stat_channels set channel_id=$4 where bot_id=$1 and guild_id=$2 and counter=$3",
            [this.botId, guildId, counter, channelId],
        );
    }
    async reserveRename(
        guildId: string,
        counter: CounterKind,
        name: string,
        at: Date,
    ): Promise<void> {
        await this.db.query(
            "update discord.server_stat_channels set last_name=$4,renamed_at=$5 where bot_id=$1 and guild_id=$2 and counter=$3",
            [this.botId, guildId, counter, name, at],
        );
    }
    async remove(guildId: string, counter: CounterKind): Promise<void> {
        await this.db.query(
            "delete from discord.server_stat_channels where bot_id=$1 and guild_id=$2 and counter=$3",
            [this.botId, guildId, counter],
        );
    }
}
