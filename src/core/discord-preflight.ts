import { ApplicationFlagsBitField, type REST, Routes } from "discord.js";
import { z } from "zod";
import { snowflake } from "../shared/validation";

const applicationSchema = z.object({
  id: snowflake,
  name: z.string(),
  flags: z.number().int().default(0),
});
const guildSchema = z.object({ id: snowflake, name: z.string() });

/** Limited flags authorize small bots; verified bots receive the full flags. */
export function missingGatewayIntents(flags: number): string[] {
  const available = new ApplicationFlagsBitField(flags);
  const required = [
    {
      name: "Server Members Intent",
      flags: [
        ApplicationFlagsBitField.Flags.GatewayGuildMembers,
        ApplicationFlagsBitField.Flags.GatewayGuildMembersLimited,
      ],
    },
    {
      name: "Message Content Intent",
      flags: [
        ApplicationFlagsBitField.Flags.GatewayMessageContent,
        ApplicationFlagsBitField.Flags.GatewayMessageContentLimited,
      ],
    },
  ];
  return required
    .filter((intent) => !available.any(intent.flags))
    .map((intent) => intent.name);
}

/** Read-only checks shared by diagnostics and deployment; never returns a token. */
export async function inspectDiscordAccess(
  rest: Pick<REST, "get">,
  applicationId: string,
  targetGuildId?: string,
) {
  const application = applicationSchema.parse(
    await rest.get(Routes.oauth2CurrentApplication()),
  );
  if (application.id !== applicationId)
    throw new Error(
      "DISCORD_CLIENT_ID does not match this bot token. Correct .env before continuing.",
    );
  const guilds: Array<z.infer<typeof guildSchema>> = [];
  let after: string | undefined;
  for (;;) {
    const query = new URLSearchParams({
      limit: "200",
      ...(after ? { after } : {}),
    });
    const page = z
      .array(guildSchema)
      .parse(await rest.get(Routes.userGuilds(), { query }));
    guilds.push(...page);
    if (page.length < 200) break;
    const next = page.at(-1)?.id;
    if (!next || next === after)
      throw new Error("Discord server pagination did not advance.");
    after = next;
  }
  if (targetGuildId && !guilds.some((guild) => guild.id === targetGuildId))
    throw new Error(
      "The bot has not joined COMMAND_GUILD_ID. Check the server ID and invite this bot first.",
    );
  return {
    application,
    guilds,
    missingIntents: missingGatewayIntents(application.flags),
  };
}
