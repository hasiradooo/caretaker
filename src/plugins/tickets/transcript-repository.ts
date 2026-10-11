import type { Database } from "../../database/connection";

export interface TranscriptMessage {
  id: string;
  author_id: string;
  author_name: string;
  created_at: string;
  edited_at: string | null;
  reply_to: string | null;
  text: string;
  attachments: { name: string; url: string }[];
}
export interface TranscriptSnapshot {
  server_name: string;
  names: Record<string, string>;
  complete: boolean;
  messages: TranscriptMessage[];
}
export interface TicketTranscript {
  guild_id: string;
  thread_id: string;
  channel_id: string;
  message_id: string | null;
  snapshot: TranscriptSnapshot;
  revision: number;
  published_revision: number;
  published_rating: number | null;
  ticket_number: string;
  opener_id: string;
  claimed_by: string | null;
  closed_by: string | null;
  close_reason: string | null;
  created_at: Date | string;
  closed_at: Date | string | null;
  topic: string | null;
  rating: number | null;
  reviewed_at: Date | string | null;
  status: "open" | "closed";
}
const select = `select a.*,t.ticket_number::text,t.opener_id,t.claimed_by,t.closed_by,t.close_reason,
  t.created_at,t.closed_at,t.metadata->>'topic' as topic,t.rating,t.reviewed_at,t.status
  from discord.ticket_transcripts a join discord.tickets t using(bot_id,guild_id,thread_id)`;

export class TranscriptRepository {
  constructor(
    private readonly db: Database,
    private readonly botId: string,
  ) {}

  /** Capture before archiving, publish only after closure. Retrying a failed close
   * replaces the snapshot, while an already published archive keeps its location. */
  async prepare(
    guildId: string,
    threadId: string,
    channelId: string,
    snapshot: TranscriptSnapshot,
  ): Promise<void> {
    await this.db.query(
      `insert into discord.ticket_transcripts (bot_id,guild_id,thread_id,channel_id,snapshot)
      values ($1,$2,$3,$4,$5::text::jsonb)
      on conflict (bot_id,guild_id,thread_id) do update set snapshot=excluded.snapshot,
        revision=discord.ticket_transcripts.revision+1,
        channel_id=case when discord.ticket_transcripts.message_id is null then excluded.channel_id else discord.ticket_transcripts.channel_id end`,
      [this.botId, guildId, threadId, channelId, JSON.stringify(snapshot)],
    );
  }
  async get(
    guildId: string,
    threadId: string,
  ): Promise<TicketTranscript | undefined> {
    return (
      await this.db.query<TicketTranscript>(
        `${select} where a.bot_id=$1 and a.guild_id=$2 and a.thread_id=$3`,
        [this.botId, guildId, threadId],
      )
    )[0];
  }
  async pending(guildId: string): Promise<TicketTranscript[]> {
    return this.db.query<TicketTranscript>(
      `${select} where a.bot_id=$1 and a.guild_id=$2 and t.status='closed'
      and (a.published_revision<a.revision or a.published_rating is distinct from t.rating)
      order by t.closed_at limit 25`,
      [this.botId, guildId],
    );
  }
  async published(row: TicketTranscript, messageId: string): Promise<void> {
    // Record precisely the version sent; a concurrent new rating remains pending.
    await this.db.query(
      `update discord.ticket_transcripts set message_id=$4,published_revision=$5,published_rating=$6
      where bot_id=$1 and guild_id=$2 and thread_id=$3`,
      [
        this.botId,
        row.guild_id,
        row.thread_id,
        messageId,
        row.revision,
        row.rating,
      ],
    );
  }
}
