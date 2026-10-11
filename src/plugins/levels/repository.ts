import type { Database } from "../../database/connection";
import { MAX_TOTAL_XP, splitXp, totalXp } from "./math";

export interface LevelRow {
  user_id: string;
  xp: number;
  level: number;
  messages: number;
  last_xp_at: Date | string | null;
}
export interface RankedRow extends LevelRow {
  rank: number;
}

export class LevelsRepository {
  constructor(
    private readonly db: Database,
    private readonly botId: string,
  ) {}

  async get(guildId: string, userId: string): Promise<RankedRow | undefined> {
    const [row] = await this.db.query<RankedRow>(
      `select * from (select user_id,xp,level,messages,last_xp_at,
       (row_number() over (order by level desc,xp desc,user_id))::int as rank
       from discord.user_levels where bot_id=$1 and guild_id=$2) ranked where user_id=$3`,
      [this.botId, guildId, userId],
    );
    return row;
  }

  async leaderboard(
    guildId: string,
    limit = 10,
    offset = 0,
  ): Promise<RankedRow[]> {
    return this.db.query<RankedRow>(
      `select user_id,xp,level,messages,last_xp_at,
      (row_number() over (order by level desc,xp desc,user_id))::int as rank
      from discord.user_levels where bot_id=$1 and guild_id=$2 order by level desc,xp desc,user_id limit $3 offset $4`,
      [this.botId, guildId, limit, offset],
    );
  }

  async award(
    guildId: string,
    userId: string,
    gain: number,
    cooldownSeconds: number,
    now = new Date(),
  ): Promise<{ row: LevelRow; previousLevel: number } | null> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        "insert into discord.user_levels (bot_id,guild_id,user_id) values ($1,$2,$3) on conflict do nothing",
        [this.botId, guildId, userId],
      );
      // The row lock makes the cooldown and increment one atomic operation across replicas.
      const [current] = await tx.query<LevelRow>(
        "select user_id,xp,level,messages,last_xp_at from discord.user_levels where bot_id=$1 and guild_id=$2 and user_id=$3 for update",
        [this.botId, guildId, userId],
      );
      if (!current) throw new Error("Level row disappeared");
      if (
        current.last_xp_at &&
        now.getTime() - new Date(current.last_xp_at).getTime() <
          cooldownSeconds * 1000
      )
        return null;
      const total = totalXp(current.level, current.xp);
      // Ambiguous legacy /set rows are reported by db:check, never silently reinterpreted.
      if (
        current.xp < 0 ||
        current.level < 0 ||
        current.xp >= (current.level + 1) * 3000 ||
        total > MAX_TOTAL_XP
      )
        throw new Error("Legacy XP row needs explicit repair; run db:check");
      const next = splitXp(Math.min(MAX_TOTAL_XP, total + gain));
      const [row] = await tx.query<LevelRow>(
        "update discord.user_levels set xp=$4,level=$5,messages=least(messages::bigint+1,2147483647),last_xp_at=$6,updated_at=now() where bot_id=$1 and guild_id=$2 and user_id=$3 returning user_id,xp,level,messages,last_xp_at",
        [this.botId, guildId, userId, next.xp, next.level, now],
      );
      if (!row) throw new Error("Level update returned no row");
      return { row, previousLevel: current.level };
    });
  }

  async set(guildId: string, userId: string, total: number): Promise<void> {
    const { xp, level } = splitXp(total);
    await this.db.query(
      `insert into discord.user_levels (bot_id,guild_id,user_id,xp,level) values ($1,$2,$3,$4,$5)
      on conflict (bot_id,guild_id,user_id) do update set xp=excluded.xp,level=excluded.level,updated_at=now()`,
      [this.botId, guildId, userId, xp, level],
    );
  }
}
