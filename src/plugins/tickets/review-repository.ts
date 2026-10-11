import type { Database } from "../../database/connection";

export interface TicketReview {
  guild_id: string;
  thread_id: string;
  ticket_number: string;
  opener_id: string;
  rating: number | null;
  review_token: string;
  review_dm_message_id: string | null;
}

const columns =
  "guild_id,thread_id,ticket_number::text,opener_id,rating,review_token::text,review_dm_message_id";

export class TicketReviewRepository {
  constructor(
    private readonly db: Database,
    private readonly botId: string,
  ) {}

  /** Claim before sending: retries/restarts must never repeatedly DM the member.
   * A process interrupted during delivery leaves 'sending' for operator inspection,
   * rather than automatically repeating a possibly delivered private message. */
  async claim(
    guildId: string,
    threadId: string,
  ): Promise<TicketReview | undefined> {
    return (
      await this.db.query<TicketReview>(
        `update discord.tickets set review_token=$4::uuid,review_requested_at=now(),review_delivery_status='sending' where bot_id=$1 and guild_id=$2 and thread_id=$3 and status='closed' and rating is null and review_requested_at is null returning ${columns}`,
        [this.botId, guildId, threadId, crypto.randomUUID()],
      )
    )[0];
  }

  async delivery(
    token: string,
    status: "sent" | "unavailable" | "failed",
    messageId: string | null = null,
  ): Promise<void> {
    await this.db.query(
      "update discord.tickets set review_delivery_status=$3,review_dm_message_id=$4 where bot_id=$1 and review_token=$2::uuid",
      [this.botId, token, status, messageId],
    );
  }

  async find(
    token: string,
    openerId: string,
  ): Promise<TicketReview | undefined> {
    return (
      await this.db.query<TicketReview>(
        `select ${columns} from discord.tickets where bot_id=$1 and review_token=$2::uuid and opener_id=$3 and status='closed'`,
        [this.botId, token, openerId],
      )
    )[0];
  }

  /** First vote wins atomically, including simultaneous clicks on different stars. */
  async rate(
    token: string,
    openerId: string,
    score: number,
  ): Promise<TicketReview | undefined> {
    if (!Number.isInteger(score) || score < 1 || score > 5)
      throw new Error("Rating must be between 1 and 5.");
    const [saved] = await this.db.query<TicketReview>(
      `update discord.tickets set rating=$4,reviewed_at=now() where bot_id=$1 and review_token=$2::uuid and opener_id=$3 and status='closed' and rating is null returning ${columns}`,
      [this.botId, token, openerId, score],
    );
    return saved ?? this.find(token, openerId);
  }
}
