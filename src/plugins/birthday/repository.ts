import type { Database } from "../../database/connection";
import { birthdayDateSchema } from "./config";

export interface BirthdayRow {
    user_id: string;
    day: number;
    month: number;
    year: number | null;
}
export class BirthdayRepository {
    constructor(
        private readonly db: Database,
        private readonly botId: string,
    ) {}
    async set(guildId: string, userId: string, input: unknown): Promise<void> {
        const date = birthdayDateSchema.parse(input);
        await this.db.query(
            `insert into discord.user_bdays (bot_id,guild_id,user_id,day,month,year) values ($1,$2,$3,$4,$5,$6)
      on conflict (bot_id,guild_id,user_id) do update set day=excluded.day,month=excluded.month,year=excluded.year`,
            [
                this.botId,
                guildId,
                userId,
                date.day,
                date.month,
                date.year ?? null,
            ],
        );
    }
    async remove(guildId: string, userId: string): Promise<void> {
        await this.db.query(
            "delete from discord.user_bdays where bot_id=$1 and guild_id=$2 and user_id=$3",
            [this.botId, guildId, userId],
        );
    }
    async get(
        guildId: string,
        userId: string,
    ): Promise<BirthdayRow | undefined> {
        return (
            await this.db.query<BirthdayRow>(
                "select user_id,day,month,year from discord.user_bdays where bot_id=$1 and guild_id=$2 and user_id=$3",
                [this.botId, guildId, userId],
            )
        )[0];
    }
    async onDate(
        guildId: string,
        month: number,
        day: number,
    ): Promise<BirthdayRow[]> {
        return this.db.query<BirthdayRow>(
            "select user_id,day,month,year from discord.user_bdays where bot_id=$1 and guild_id=$2 and month=$3 and day=$4",
            [this.botId, guildId, month, day],
        );
    }
}
