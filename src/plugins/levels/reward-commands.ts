import {
  type ChatInputCommandInteraction,
  SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { assignableRole, requireManageGuild } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, successCard } from "../../shared/messages";
import { levelsSchema, MAX_LEVEL_REWARDS, MAX_REWARD_LEVEL } from "./config";

export const rewardCommands = new SlashCommandSubcommandGroupBuilder()
  .setName("rewards")
  .setDescription("Manage Server: configure milestone roles")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription(
        "Assign a role to a level, or change its existing milestone",
      )
      .addIntegerOption((option) =>
        option
          .setName("level")
          .setDescription(
            "Use 0 for the join role, or a milestone like 5, 10 or 15",
          )
          .setMinValue(0)
          .setMaxValue(MAX_REWARD_LEVEL)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Role to award at this milestone")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove one reward, or every reward at a milestone")
      .addIntegerOption((option) =>
        option
          .setName("level")
          .setDescription("Milestone to remove")
          .setMinValue(0)
          .setMaxValue(MAX_REWARD_LEVEL)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Leave empty to remove all rewards at this level"),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Review this server's milestone roles")
      .addIntegerOption((option) =>
        option
          .setName("page")
          .setDescription("Page of rewards")
          .setMinValue(1)
          .setMaxValue(Math.ceil(MAX_LEVEL_REWARDS / 10)),
      ),
  );

/** Setup works while XP is disabled and only changes this guild's reward list. */
export async function executeRewardCommand(
  context: Context,
  interaction: ChatInputCommandInteraction<"cached">,
): Promise<void> {
  requireManageGuild(interaction);
  const action = interaction.options.getSubcommand();
  const stored = await context.settings.raw(interaction.guildId, "levels");
  const config = levelsSchema.parse({
    ...stored.config,
    enabled: stored.enabled,
  });
  const rewards = [...config.reward_roles].sort(
    (a, b) => a.level - b.level || a.role_id.localeCompare(b.role_id),
  );
  const status = config.enabled
    ? "Rewards update on a member's next XP award or an admin XP change."
    : "Levels are disabled. Enable them with `/config enable plugin:Levels` when ready.";
  if (action === "list") {
    const page = interaction.options.getInteger("page") ?? 1;
    const pages = Math.max(1, Math.ceil(rewards.length / 10));
    if (page > pages)
      throw new UserError(`There are only ${pages} reward pages.`);
    await interaction.editReply(
      card({
        title: "Level rewards",
        icon: "🏅",
        body: "Members keep only the roles at their **highest unlocked milestone**.",
        sections: [
          rewards.length
            ? rewards
                .slice((page - 1) * 10, page * 10)
                .map((item) => `**Level ${item.level}** · <@&${item.role_id}>`)
                .join("\n")
            : "No rewards yet. Use `/level rewards add` and select a level and role.",
          `${status}\nUse \`/level rewards add\` to add or change a role's milestone, or \`/level rewards remove\` to remove it.`,
        ],
        footer: `Page ${page} of ${pages} · ${rewards.length}/${MAX_LEVEL_REWARDS} rewards · Only you can see this`,
      }),
    );
    return;
  }

  const level = interaction.options.getInteger("level", true);
  const selected = interaction.options.getRole("role", action === "add");
  let next: typeof rewards;
  let title: string;
  let body: string;
  if (action === "add" && selected) {
    await assignableRole(interaction.guild, selected.id);
    // One threshold per role; several different roles may share a milestone.
    next = rewards.filter((item) => item.role_id !== selected.id);
    if (next.length >= MAX_LEVEL_REWARDS)
      throw new UserError(
        `This server already has ${MAX_LEVEL_REWARDS} reward roles. Remove one first.`,
      );
    next.push({ role_id: selected.id, level });
    next.sort(
      (a, b) => a.level - b.level || a.role_id.localeCompare(b.role_id),
    );
    title = "Level reward saved";
    body = `**Level ${level}** → <@&${selected.id}>\n${level === 0 ? "New members receive this role on joining while levels are enabled. It is replaced when they unlock a higher milestone." : "Members keep only their highest milestone's roles."}\n${status}`;
  } else if (action === "remove") {
    next = rewards.filter(
      (item) =>
        item.level !== level || (selected && item.role_id !== selected.id),
    );
    if (next.length === rewards.length)
      throw new UserError(
        "No matching level reward exists. Check `/level rewards list`.",
      );
    title = "Level reward removed";
    body = `Removed **${rewards.length - next.length}** reward(s) from **level ${level}**.\nRemoved rewards stop being managed; roles already held by members are left in place.`;
  } else {
    throw new UserError("Unknown reward command. Use `/level rewards list`.");
  }
  // Reward arrays replace as a unit. The revision prevents simultaneous admin
  // edits from silently overwriting each other or discarding unrelated settings.
  await context.settings.patch(
    interaction.guildId,
    "levels",
    levelsSchema,
    { reward_roles: next },
    stored.revision,
  );
  await interaction.editReply(successCard(title, body));
}
