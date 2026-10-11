import { randomUUID } from "node:crypto";
import type { Database } from "./connection";

/** One active gateway process per bot; protects Discord side effects from double starts. */
export class RuntimeLease {
  private readonly owner = randomUUID();
  constructor(
    private readonly db: Database,
    private readonly botId: string,
  ) {}
  async acquire(): Promise<boolean> {
    return (
      (
        await this.db.query(
          `insert into discord.runtime_leases (bot_id,owner,expires_at) values ($1,$2,now()+interval '120 seconds')
      on conflict (bot_id) do update set owner=excluded.owner,expires_at=excluded.expires_at
      where discord.runtime_leases.expires_at < now() returning bot_id`,
          [this.botId, this.owner],
        )
      ).length > 0
    );
  }
  async renew(): Promise<boolean> {
    return (
      (
        await this.db.query(
          "update discord.runtime_leases set expires_at=now()+interval '120 seconds' where bot_id=$1 and owner=$2 and expires_at>now() returning bot_id",
          [this.botId, this.owner],
        )
      ).length > 0
    );
  }
  async release(): Promise<void> {
    await this.db.query(
      "delete from discord.runtime_leases where bot_id=$1 and owner=$2",
      [this.botId, this.owner],
    );
  }
}
