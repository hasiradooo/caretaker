import type { z } from "zod";
import { UserError } from "../shared/errors";
import { mergeSettings, type Settings } from "../shared/validation";
import type { Database } from "./connection";
import { storedJsonObject } from "./json";

export interface StoredSettings {
  enabled: boolean;
  config: Record<string, unknown>;
  revision: string | null;
}

/** Every query carries this runtime's bot ID. Guild IDs alone are never a tenant key. */
export class SettingsStore {
  private readonly cache = new Map<
    string,
    { expires: number; row: Promise<StoredSettings> }
  >();
  constructor(
    private readonly db: Database,
    readonly botId: string,
  ) {}

  async raw(guildId: string, pluginId: string): Promise<StoredSettings> {
    const [row] = await this.db.query<StoredSettings>(
      "select enabled, config, updated_at::text as revision from discord.plugins where bot_id=$1 and guild_id=$2 and plugin_name=$3",
      [this.botId, guildId, pluginId],
    );
    return row
      ? { ...row, config: storedJsonObject(row.config) }
      : { enabled: false, config: {}, revision: null };
  }

  async get<T extends Settings>(
    guildId: string,
    pluginId: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const key = `${guildId}:${pluginId}`;
    let cached = this.cache.get(key);
    if (!cached || cached.expires <= Date.now()) {
      if (this.cache.size >= 5000) this.cache.clear();
      // Cache the in-flight read itself so a burst of events shares one query.
      // Installing it before awaiting also means patch() can invalidate an old
      // read without that read later putting stale settings back into the cache.
      cached = {
        row: this.raw(guildId, pluginId),
        expires: Date.now() + 15000,
      };
      this.cache.set(key, cached);
    }
    let row: StoredSettings;
    try {
      row = await cached.row;
    } catch (error) {
      if (this.cache.get(key) === cached) this.cache.delete(key);
      throw error;
    }
    // The legacy enabled column is authoritative, even if old JSON also has enabled.
    return schema.parse({ ...row.config, enabled: row.enabled });
  }

  async patch<T extends Settings>(
    guildId: string,
    pluginId: string,
    schema: z.ZodType<T>,
    patch: Record<string, unknown>,
    expectedRevision?: string | null,
  ): Promise<T> {
    const result = await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        "insert into discord.plugins (bot_id,guild_id,plugin_name) values ($1,$2,$3) on conflict do nothing returning plugin_name",
        [this.botId, guildId, pluginId],
      );
      const [row] = await tx.query<StoredSettings>(
        "select enabled,config,updated_at::text as revision from discord.plugins where bot_id=$1 and guild_id=$2 and plugin_name=$3 for update",
        [this.botId, guildId, pluginId],
      );
      if (!row) throw new Error("Configuration row disappeared");
      if (
        expectedRevision !== undefined &&
        (expectedRevision === null
          ? inserted.length === 0
          : row.revision !== expectedRevision)
      )
        throw new UserError(
          "Settings changed while your editor was open. Run /config view again to avoid overwriting another edit.",
        );
      const validated = schema.parse(
        mergeSettings(
          { ...storedJsonObject(row.config), enabled: row.enabled },
          patch,
        ),
      );
      const { enabled, ...config } = validated;
      await tx.query(
        // Bind serialized JSON as text first; postgres.js otherwise serializes
        // the string a second time when PostgreSQL infers a jsonb parameter.
        "update discord.plugins set enabled=$4,config=$5::text::jsonb,updated_at=now() where bot_id=$1 and guild_id=$2 and plugin_name=$3",
        [this.botId, guildId, pluginId, enabled, JSON.stringify(config)],
      );
      return validated;
    });
    this.cache.delete(`${guildId}:${pluginId}`);
    return result;
  }
}
