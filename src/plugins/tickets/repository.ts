import type { Database } from "../../database/connection";

export interface TicketRow {
  thread_id: string;
  // PostgreSQL bigint is read as text to avoid rounding large ticket numbers.
  ticket_number: string;
  opener_id: string;
  claimed_by: string | null;
  status: "open" | "closed";
  last_activity_at: Date | string;
  inactivity_warned_at: Date | string | null;
  inactivity_close_at: Date | string | null;
  inactivity_policy: string | null;
  inactivity_warning_message_id: string | null;
  staff_alert_channel_id: string | null;
  staff_alert_message_id: string | null;
  staff_alert_deleted_at: Date | string | null;
}

// Keep activity as PostgreSQL text: converting to Date loses microseconds and
// would make compare-and-set checks fail for tickets created with now(). Bind
// these values through ::text too, bypassing postgres.js's timestamp serializer.
const ticketColumns =
  "thread_id,ticket_number::text,opener_id,claimed_by,status,last_activity_at::text,inactivity_warned_at,inactivity_close_at::text,inactivity_policy,inactivity_warning_message_id,staff_alert_channel_id,staff_alert_message_id,staff_alert_deleted_at";

const timestampText = (value: Date | string | null | undefined) =>
  value instanceof Date ? value.toISOString() : (value ?? null);

export class TicketRepository {
  constructor(
    private readonly db: Database,
    private readonly botId: string,
  ) {}
  async get(
    guildId: string,
    channelId: string,
  ): Promise<TicketRow | undefined> {
    return (
      await this.db.query<TicketRow>(
        `select ${ticketColumns} from discord.tickets where bot_id=$1 and guild_id=$2 and thread_id=$3`,
        [this.botId, guildId, channelId],
      )
    )[0];
  }
  async open(guildId: string, userId?: string): Promise<TicketRow[]> {
    return this.db.query<TicketRow>(
      `select ${ticketColumns} from discord.tickets where bot_id=$1 and guild_id=$2 and status='open' and ($3::text is null or opener_id=$3)`,
      [this.botId, guildId, userId ?? null],
    );
  }
  async create(
    guildId: string,
    channelId: string,
    userId: string,
    topic: string,
  ): Promise<TicketRow> {
    const [ticket] = await this.db.query<TicketRow>(
      `insert into discord.tickets (bot_id,guild_id,thread_id,opener_id,metadata) values ($1,$2,$3,$4,$5::text::jsonb) returning ${ticketColumns}`,
      [this.botId, guildId, channelId, userId, JSON.stringify({ topic })],
    );
    if (!ticket) throw new Error("Ticket insert returned no record.");
    return ticket;
  }
  /** Return current status too: staff may close immediately after the alert posts. */
  async saveStaffAlert(
    guildId: string,
    threadId: string,
    channelId: string,
    messageId: string,
  ): Promise<TicketRow> {
    const [ticket] = await this.db.query<TicketRow>(
      `update discord.tickets set staff_alert_channel_id=$4,staff_alert_message_id=$5,staff_alert_deleted_at=null where bot_id=$1 and guild_id=$2 and thread_id=$3 returning ${ticketColumns}`,
      [this.botId, guildId, threadId, channelId, messageId],
    );
    if (!ticket) throw new Error("Cannot save an alert for an unknown ticket.");
    return ticket;
  }
  async pendingStaffAlerts(guildId: string): Promise<TicketRow[]> {
    return this.db.query<TicketRow>(
      `select ${ticketColumns} from discord.tickets where bot_id=$1 and guild_id=$2 and status='closed' and staff_alert_message_id is not null and staff_alert_deleted_at is null order by closed_at limit 25`,
      [this.botId, guildId],
    );
  }
  async markStaffAlertDeleted(guildId: string, row: TicketRow): Promise<void> {
    await this.db.query(
      "update discord.tickets set staff_alert_deleted_at=now() where bot_id=$1 and guild_id=$2 and thread_id=$3 and status='closed' and staff_alert_channel_id=$4 and staff_alert_message_id=$5 and staff_alert_deleted_at is null",
      [
        this.botId,
        guildId,
        row.thread_id,
        row.staff_alert_channel_id,
        row.staff_alert_message_id,
      ],
    );
  }
  /** Only the opener resets the timer. Ignore duplicate/out-of-order gateway
   * events; Discord's message timestamp also lets history repair offline gaps. */
  async touch(
    guildId: string,
    channelId: string,
    authorId: string,
    at: Date,
  ): Promise<void> {
    await this.db.query(
      "update discord.tickets set last_activity_at=$5,inactivity_warned_at=null,inactivity_close_at=null,inactivity_policy=null,inactivity_warning_message_id=null where bot_id=$1 and guild_id=$2 and thread_id=$3 and opener_id=$4 and status='open' and last_activity_at<$5::timestamptz",
      [this.botId, guildId, channelId, authorId, at],
    );
  }
  /** Compare-and-set: a reply during the warning send must cancel that warning. */
  async saveWarning(
    guildId: string,
    row: TicketRow,
    policy: string,
    warnedAt: Date,
    closeAt: Date,
    messageId: string,
  ): Promise<boolean> {
    const saved = await this.db.query(
      "update discord.tickets set inactivity_warned_at=$5,inactivity_close_at=$6,inactivity_policy=$7,inactivity_warning_message_id=$8 where bot_id=$1 and guild_id=$2 and thread_id=$3 and status='open' and last_activity_at=$4::text::timestamptz and (inactivity_close_at is null or inactivity_policy is distinct from $7) returning thread_id",
      [
        this.botId,
        guildId,
        row.thread_id,
        timestampText(row.last_activity_at),
        warnedAt,
        closeAt,
        policy,
        messageId,
      ],
    );
    return saved.length > 0;
  }
  async clearWarning(guildId: string, threadId?: string): Promise<void> {
    await this.db.query(
      "update discord.tickets set inactivity_warned_at=null,inactivity_close_at=null,inactivity_policy=null,inactivity_warning_message_id=null where bot_id=$1 and guild_id=$2 and status='open' and ($3::text is null or thread_id=$3) and inactivity_close_at is not null",
      [this.botId, guildId, threadId ?? null],
    );
  }
  async claim(
    guildId: string,
    channelId: string,
    userId: string,
  ): Promise<boolean> {
    return (
      (
        await this.db.query(
          "update discord.tickets set claimed_by=$4 where bot_id=$1 and guild_id=$2 and thread_id=$3 and status='open' and (claimed_by is null or claimed_by=$4) returning thread_id",
          [this.botId, guildId, channelId, userId],
        )
      ).length > 0
    );
  }
  async close(
    guildId: string,
    channelId: string,
    userId: string,
    reason: string,
    expected?: TicketRow,
  ): Promise<boolean> {
    const rows = await this.db.query(
      "update discord.tickets set status='closed',closed_by=$4,close_reason=$5,closed_at=now() where bot_id=$1 and guild_id=$2 and thread_id=$3 and status='open' and ($6::text is null or (last_activity_at=$6::text::timestamptz and inactivity_close_at=$7::text::timestamptz and inactivity_policy=$8)) returning thread_id",
      [
        this.botId,
        guildId,
        channelId,
        userId,
        reason,
        timestampText(expected?.last_activity_at),
        timestampText(expected?.inactivity_close_at),
        expected?.inactivity_policy ?? null,
      ],
    );
    return rows.length > 0;
  }
}
