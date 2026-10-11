import type { Database } from "./connection";

/** Durable deduplication for scheduled messages; entries survive process restarts. */
export class StateStore {
  constructor(
    private readonly db: Database,
    private readonly botId: string,
  ) {}
  async claim(
    guildId: string,
    plugin: string,
    key: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `insert into discord.plugin_state (bot_id,guild_id,plugin_name,key,expires_at)
       values ($1,$2,$3,$4,now()+$5*interval '1 second')
       on conflict (bot_id,guild_id,plugin_name,key) do update set expires_at=excluded.expires_at
       where discord.plugin_state.expires_at < now() returning key`,
      [this.botId, guildId, plugin, key, ttlSeconds],
    );
    return rows.length > 0;
  }
  async release(guildId: string, plugin: string, key: string): Promise<void> {
    await this.db.query(
      "delete from discord.plugin_state where bot_id=$1 and guild_id=$2 and plugin_name=$3 and key=$4",
      [this.botId, guildId, plugin, key],
    );
  }
  async prune(): Promise<void> {
    await this.db.query(
      "delete from discord.plugin_state where bot_id=$1 and expires_at < now()",
      [this.botId],
    );
  }
}
