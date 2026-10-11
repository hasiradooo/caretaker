import type { ChatInputCommandInteraction } from "discord.js";
import type { Context } from "../../core/plugin";
import type { card } from "../../shared/messages";

/** Level commands defer privately so validation and lookup failures stay private.
 * Complete that original response before sending a public follow-up: Discord
 * otherwise treats the first follow-up as an edit and keeps it ephemeral.
 * Only a finished rank/leaderboard reaches this function. */
export async function publishLevelResult(
  context: Context,
  interaction: ChatInputCommandInteraction<"cached">,
  payload: ReturnType<typeof card>,
): Promise<void> {
  await interaction.editReply(payload);
  await interaction.followUp(payload);
  // Keep the private original until publication succeeds so the runtime can
  // replace it with a private error if Discord rejects the public message.
  try {
    await interaction.deleteReply();
  } catch (error) {
    // The public result already exists. A cleanup failure must not become a
    // command failure or cause another public post.
    context.log.warn("Could not remove the private level preview", error);
  }
}
