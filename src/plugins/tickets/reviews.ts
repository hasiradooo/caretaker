import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  escapeMarkdown,
  type Guild,
  MessageFlags,
  RESTJSONErrorCodes,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { UserError } from "../../shared/errors";
import { card, successCard } from "../../shared/messages";
import { ticketLabel } from "./presentation";
import { type TicketReview, TicketReviewRepository } from "./review-repository";
import { syncTicketTranscript } from "./transcripts";

export function ticketReviewCard(review: TicketReview, serverName?: string) {
  const label = ticketLabel(review.ticket_number);
  return card({
    title: `Ticket ${label} closed`,
    icon: "🎫",
    body:
      review.rating === null
        ? `Your support ticket${serverName ? ` in **${escapeMarkdown(serverName)}**` : ""} is now closed.\nHow would you rate the help you received?`
        : `Your rating: ⭐ **${review.rating}/5**. Thanks for your feedback!`,
    actions: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...[1, 2, 3, 4, 5].map((score) =>
          new ButtonBuilder()
            .setCustomId(`tickets:review:${review.review_token}:${score}`)
            .setEmoji("⭐")
            .setLabel(String(score))
            .setStyle(
              review.rating === score
                ? ButtonStyle.Success
                : ButtonStyle.Secondary,
            )
            .setDisabled(review.rating !== null),
        ),
      ),
    ],
    footer:
      review.rating === null
        ? "1 = poor · 5 = excellent · One rating per ticket"
        : "Review saved · One rating per ticket",
  });
}

/** This is a best-effort follow-up after closure, never a prerequisite for it. */
export async function requestTicketReview(
  context: Context,
  guild: Pick<Guild, "id" | "name">,
  threadId: string,
): Promise<void> {
  const repository = new TicketReviewRepository(context.db, context.botId);
  try {
    const review = await repository.claim(guild.id, threadId);
    if (!review) return;
    let messageId: string;
    try {
      const user = await context.client.users.fetch(review.opener_id);
      const message = await user.send({
        ...ticketReviewCard(review, guild.name),
        // Discord also deduplicates an immediate HTTP retry of this same send.
        nonce: `rv-${threadId}`,
        enforceNonce: true,
      });
      messageId = message.id;
    } catch (error) {
      const blocked =
        error instanceof Error &&
        "code" in error &&
        error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser;
      await repository.delivery(
        review.review_token,
        blocked ? "unavailable" : "failed",
      );
      if (!blocked)
        context.log.warn(`Could not send ticket review for ${threadId}`, error);
      return;
    }
    await repository.delivery(review.review_token, "sent", messageId);
  } catch (error) {
    context.log.warn(
      `Could not record ticket review delivery for ${threadId}`,
      error,
    );
  }
}

export async function handleTicketReview(
  context: Context,
  interaction: ButtonInteraction,
): Promise<void> {
  const match =
    /^tickets:review:([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}):([1-5])$/.exec(
      interaction.customId,
    );
  if (
    interaction.guildId !== null ||
    interaction.message.author.id !== context.botId ||
    !match?.[1] ||
    !match[2]
  ) {
    throw new UserError(
      "Use the review buttons in the DM sent after your ticket closed.",
    );
  }
  // A separate acknowledgement keeps the original buttons usable if the database
  // is unavailable; the generic error handler must not replace the review prompt.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const repository = new TicketReviewRepository(context.db, context.botId);
  const review = await repository.find(match[1], interaction.user.id);
  if (
    !review ||
    (review.review_dm_message_id &&
      review.review_dm_message_id !== interaction.message.id)
  ) {
    throw new UserError(
      "This review is unavailable or belongs to another member.",
    );
  }
  const saved = await repository.rate(
    match[1],
    interaction.user.id,
    Number(match[2]),
  );
  if (!saved || saved.rating === null)
    throw new UserError("This ticket cannot be reviewed.");
  // Saved message ID may be missing after an interrupted send. The private token,
  // bot-authored DM and opener check still authenticate that original review.
  await interaction.message
    .edit(ticketReviewCard(saved))
    .catch((error) =>
      context.log.warn("Could not update ticket review buttons", error),
    );
  await interaction.editReply(
    successCard(
      "Review saved",
      `Ticket **${ticketLabel(saved.ticket_number)}** · ⭐ **${saved.rating}/5**\nThank you for your feedback.`,
    ),
  );
  await syncTicketTranscript(context, saved.guild_id, saved.thread_id);
}
