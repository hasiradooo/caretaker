import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  LabelBuilder,
  type MessageActionRowComponentBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Context } from "../../core/plugin";
import {
  assignableRole,
  requireManageGuild,
  sendableChannel,
} from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, clipText } from "../../shared/messages";
import {
  type LevelsSettings,
  levelsSchema,
  MAX_LEVEL_REWARDS,
  MAX_REWARD_LEVEL,
} from "./config";

const PAGE_SIZE = 10;
const SESSION_DURATION = 15 * 60 * 1000;
const EXPIRED =
  "This editor is outdated or expired. Open /level settings again.";
type View =
  | "home"
  | "reward"
  | "add"
  | "channel"
  | "xp"
  | "modal"
  | "add-modal"
  | "xp-modal"
  | "message-modal";
type Reward = LevelsSettings["reward_roles"][number];
interface Session {
  botId: string;
  guildId: string;
  userId: string;
  expires: number;
  revision: string | null;
  config: LevelsSettings;
  view: View;
  page: number;
  roleId?: string;
}

const row = (...components: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...components,
  );

/** Reject decimals/exponents rather than quietly rounding administrator input. */
function wholeNumber(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const input = value.trim();
  const number = Number(input);
  if (
    !/^\d+$/.test(input) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  )
    throw new UserError(
      `Enter a whole ${label} from ${minimum} to ${maximum}.`,
    );
  return number;
}

function input(
  label: string,
  id: string,
  value: string,
  maxLength: number,
  description?: string,
  paragraph = false,
) {
  const field = new LabelBuilder().setLabel(label).setTextInputComponent(
    new TextInputBuilder()
      .setCustomId(id)
      .setValue(value)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(maxLength)
      .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short),
  );
  if (description) field.setDescription(description);
  return field;
}

/** Private, short-lived editors. Each displayed view has its own one-use token,
 * so rapid clicks cannot apply an earlier selection to a newer view. Database
 * revisions separately protect edits made by other admins or slash commands.
 */
export class LevelSettingsEditor {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  private remember(session: Session): string {
    for (const [id, stored] of this.sessions) {
      if (stored.expires <= this.now()) this.sessions.delete(id);
    }
    if (this.sessions.size >= 1000) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    const id = crypto.randomUUID();
    this.sessions.set(id, session);
    return id;
  }

  private async fresh(context: Context, session: Session): Promise<Session> {
    const stored = await context.settings.raw(session.guildId, "levels");
    return {
      ...session,
      revision: stored.revision,
      config: levelsSchema.parse({ ...stored.config, enabled: stored.enabled }),
    };
  }

  async open(
    context: Context,
    interaction: ChatInputCommandInteraction<"cached">,
  ): Promise<void> {
    requireManageGuild(interaction);
    const session = await this.fresh(context, {
      botId: context.botId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      expires: this.now() + SESSION_DURATION,
      revision: null,
      config: levelsSchema.parse({}),
      view: "home",
      page: 0,
    });
    await interaction.editReply(this.render(interaction.guild, session));
  }

  private render(guild: Guild, session: Session, notice?: string) {
    const rewards = [...session.config.reward_roles].sort(
      (a, b) => a.level - b.level || a.role_id.localeCompare(b.role_id),
    );
    const pages = Math.max(1, Math.ceil(rewards.length / PAGE_SIZE));
    session = {
      ...session,
      page: Math.max(0, Math.min(session.page, pages - 1)),
    };
    const selected = rewards.find(
      (reward) => reward.role_id === session.roleId,
    );
    if (session.view === "reward" && !selected)
      session = { ...session, view: "home" };
    const id = this.remember(session);
    const customId = (action: string) => `levels:settings:${id}:${action}`;
    const button = (
      action: string,
      label: string,
      style = ButtonStyle.Secondary,
    ) =>
      new ButtonBuilder()
        .setCustomId(customId(action))
        .setLabel(label)
        .setStyle(style);
    const active =
      session.view === "channel"
        ? "channel"
        : session.view === "xp"
          ? "xp"
          : "home";
    // Keep navigation on the same message, even while editing an individual role.
    const actions: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
      row(
        button(
          "home",
          "Rewards",
          active === "home" ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ).setDisabled(session.view === "home"),
        button(
          "channel",
          "Announcements",
          active === "channel" ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ).setDisabled(active === "channel"),
        button(
          "xp",
          "XP settings",
          active === "xp" ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ).setDisabled(active === "xp"),
        button(
          "toggle",
          session.config.enabled ? "Pause levels" : "Enable levels",
        ),
        button("refresh", "Refresh"),
      ),
    ];
    let title = "Level settings";
    let body: string;
    let details: string;
    const channel = session.config.reward_channel_id
      ? `<#${session.config.reward_channel_id}>`
      : "Off — no announcement channel";

    if (session.view === "add") {
      title = "Add level reward";
      body = session.roleId
        ? `**Selected role:** <@&${session.roleId}>`
        : "Choose the role you want to award.";
      details =
        "Choose a role, then use **Set level & save**. Level **0** is the join role. The reward is saved only after you submit its level.";
      actions.push(
        row(
          new RoleSelectMenuBuilder()
            .setCustomId(customId("new-role"))
            .setPlaceholder("Choose a reward role")
            .setMinValues(1)
            .setMaxValues(1),
        ),
        row(
          button("level", "Set level & save", ButtonStyle.Success).setDisabled(
            !session.roleId,
          ),
          button("back", "Cancel"),
        ),
      );
    } else if (session.view === "reward" && selected) {
      title = "Edit level reward";
      body = `**Level ${selected.level}${selected.level === 0 ? " · Join role" : ""}** → <@&${selected.role_id}>`;
      details =
        "Choose a replacement role below, or change its required level.\nRemoving or replacing a reward stops managing the old role; members who already have it keep it.";
      actions.push(
        row(
          new RoleSelectMenuBuilder()
            .setCustomId(customId("role"))
            .setPlaceholder("Replace this reward role")
            .setMinValues(1)
            .setMaxValues(1),
        ),
        row(
          button("level", "Change level", ButtonStyle.Primary),
          button("remove", "Remove reward", ButtonStyle.Danger),
          button("back", "All rewards"),
        ),
      );
    } else if (session.view === "channel") {
      title = "Level-up channel";
      body = `**Current channel:** ${channel}`;
      details = `### Level-up message\n\`\`\`text\n${clipText(session.config.reward_message, 400).replaceAll("```", "`\u200b``")}\n\`\`\`\nChoose a channel below or use **Edit message**. Only the member who levels up can be notified. Turning announcements off keeps XP and role rewards running.`;
      actions.push(
        row(
          new ChannelSelectMenuBuilder()
            .setCustomId(customId("destination"))
            .setPlaceholder("Choose the level-up channel")
            .setChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setMinValues(1)
            .setMaxValues(1),
        ),
        row(
          button("message", "Edit message", ButtonStyle.Primary),
          button("disable", "Turn announcements off").setDisabled(
            !session.config.reward_channel_id,
          ),
        ),
      );
    } else if (session.view === "xp") {
      title = "XP settings";
      body = `**XP per message:** ${session.config.xp_gain.min}–${session.config.xp_gain.max}\n**Cooldown:** ${session.config.xp_cooldown_seconds} seconds`;
      details =
        "Change the minimum and maximum XP per eligible message and the cooldown between awards. Changes affect future XP awards; existing member progress is kept.\nYour configured multipliers and ignored roles/channels are preserved.";
      actions.push(
        row(button("edit-xp", "Edit XP settings", ButtonStyle.Primary)),
      );
    } else {
      body = `**Level-up channel:** ${channel}\n**Rewards:** ${rewards.length}/${MAX_LEVEL_REWARDS}`;
      const page = rewards.slice(
        session.page * PAGE_SIZE,
        (session.page + 1) * PAGE_SIZE,
      );
      details = page.length
        ? page
            .map(
              (reward) =>
                `**Level ${reward.level}${reward.level === 0 ? " · Join role" : ""}** → <@&${reward.role_id}>`,
            )
            .join("\n")
        : "No reward roles yet. Use **Add reward** below. Level **0** is the join role.";
      if (page.length)
        actions.push(
          row(
            new StringSelectMenuBuilder()
              .setCustomId(customId("reward"))
              .setPlaceholder("Choose a reward to edit")
              .addOptions(
                page.map((reward) => ({
                  label: clipText(
                    `Level ${reward.level} · ${guild.roles.cache.get(reward.role_id)?.name ?? reward.role_id}`,
                    100,
                  ),
                  value: reward.role_id,
                  description:
                    reward.level === 0
                      ? "Join role · awarded when a member joins"
                      : "Change its level, replace the role, or remove it",
                })),
              ),
          ),
        );
      actions.push(
        row(
          button("add", "Add reward", ButtonStyle.Success).setDisabled(
            rewards.length >= MAX_LEVEL_REWARDS,
          ),
          button("previous", "Previous").setDisabled(session.page === 0),
          button("next", "Next").setDisabled(session.page >= pages - 1),
        ),
      );
    }
    return card({
      title,
      icon: "⚙️",
      body: `**Levels:** ${session.config.enabled ? "Enabled" : "Disabled"}\n${body}`,
      sections: [
        ...(notice ? [notice] : []),
        details,
        "Members keep only their highest unlocked milestone. Role changes apply on joining, the next eligible XP award, or an admin XP change.",
      ],
      actions,
      footer: `Page ${session.page + 1} of ${pages} · Only you can see this · Editor lasts 15 minutes`,
    });
  }

  async handle(
    context: Context,
    interaction: Interaction<"cached">,
  ): Promise<void> {
    if (!interaction.isMessageComponent() && !interaction.isModalSubmit())
      return;
    requireManageGuild(interaction);
    const [plugin, area, id, action, extra] = interaction.customId.split(":");
    const session = id ? this.sessions.get(id) : undefined;
    if (
      plugin !== "levels" ||
      area !== "settings" ||
      extra ||
      !id ||
      !session ||
      session.expires <= this.now()
    )
      throw new UserError(EXPIRED);
    if (
      session.botId !== context.botId ||
      session.guildId !== interaction.guildId ||
      session.userId !== interaction.user.id
    )
      throw new UserError(
        "This editor belongs to another administrator. Open /level settings for your own panel.",
      );
    if (interaction.isModalSubmit() && !interaction.isFromMessage())
      throw new UserError(EXPIRED);
    if (interaction.message?.author.id !== context.botId)
      throw new UserError(EXPIRED);

    // A modal must be acknowledged immediately. Keep the underlying panel valid
    // if the admin cancels it; the modal gets a separate immutable snapshot.
    if (
      interaction.isButton() &&
      action === "level" &&
      (session.view === "reward" || session.view === "add")
    ) {
      const adding = session.view === "add";
      if (adding && !session.roleId)
        throw new UserError("Choose a reward role first.");
      const level = adding ? 0 : this.selected(session).level;
      const modalId = this.remember({
        ...session,
        view: adding ? "add-modal" : "modal",
      });
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`levels:settings:${modalId}:save-level`)
          .setTitle(adding ? "Add level reward" : "Change reward level")
          .addLabelComponents(
            input(
              "Required level",
              "level",
              String(level),
              6,
              `0 = join role · maximum ${MAX_REWARD_LEVEL}`,
            ),
          ),
      );
      return;
    }

    if (
      interaction.isButton() &&
      action === "edit-xp" &&
      session.view === "xp"
    ) {
      const modalId = this.remember({ ...session, view: "xp-modal" });
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`levels:settings:${modalId}:save-xp`)
          .setTitle("Edit XP settings")
          .addLabelComponents(
            input(
              "Minimum XP per message",
              "min",
              String(session.config.xp_gain.min),
              5,
              "Whole number from 1 to 10000",
            ),
            input(
              "Maximum XP per message",
              "max",
              String(session.config.xp_gain.max),
              5,
              "At least the minimum; no more than 10000",
            ),
            input(
              "Cooldown in seconds",
              "cooldown",
              String(session.config.xp_cooldown_seconds),
              5,
              "Whole number from 1 to 86400",
            ),
          ),
      );
      return;
    }
    if (
      interaction.isButton() &&
      action === "message" &&
      session.view === "channel"
    ) {
      const modalId = this.remember({ ...session, view: "message-modal" });
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`levels:settings:${modalId}:save-message`)
          .setTitle("Edit level-up message")
          .addLabelComponents(
            input(
              "Level-up message",
              "message",
              session.config.reward_message,
              1800,
              "{user}, {display_name}, {level}, {xp}, {xp_next}; channels: <#ID>",
              true,
            ),
          ),
      );
      return;
    }

    this.sessions.delete(id);
    // Acknowledge before fetching Discord roles/channels or touching PostgreSQL.
    if (interaction.isModalSubmit()) {
      if (!interaction.isFromMessage()) throw new UserError(EXPIRED);
      await interaction.deferUpdate();
    } else await interaction.deferUpdate();

    try {
      let next = { ...session };
      let patch: Record<string, unknown> | undefined;
      let notice: string | undefined;
      if (
        interaction.isStringSelectMenu() &&
        action === "reward" &&
        session.view === "home"
      ) {
        const roleId = interaction.values[0];
        if (
          !session.config.reward_roles.some(
            (reward) => reward.role_id === roleId,
          )
        )
          throw new UserError(EXPIRED);
        next = { ...session, view: "reward", roleId };
      } else if (
        interaction.isRoleSelectMenu() &&
        action === "new-role" &&
        session.view === "add"
      ) {
        const roleId = interaction.values[0];
        if (!roleId) throw new UserError("Choose one reward role.");
        if (
          session.config.reward_roles.some(
            (reward) => reward.role_id === roleId,
          )
        )
          throw new UserError(
            "That role already has a milestone. Select its existing reward to edit it.",
          );
        if (session.config.reward_roles.length >= MAX_LEVEL_REWARDS)
          throw new UserError(
            `This server already has ${MAX_LEVEL_REWARDS} reward roles. Remove one first.`,
          );
        await assignableRole(interaction.guild, roleId);
        next.roleId = roleId;
      } else if (
        interaction.isRoleSelectMenu() &&
        action === "role" &&
        session.view === "reward"
      ) {
        const selected = this.selected(session);
        const roleId = interaction.values[0];
        if (!roleId) throw new UserError("Choose one reward role.");
        if (
          session.config.reward_roles.some(
            (reward) =>
              reward.role_id === roleId && reward.role_id !== selected.role_id,
          )
        )
          throw new UserError(
            "That role already has a milestone. Edit its existing reward instead.",
          );
        await assignableRole(interaction.guild, roleId);
        patch = {
          reward_roles: session.config.reward_roles.map((reward) =>
            reward.role_id === selected.role_id
              ? { ...reward, role_id: roleId }
              : reward,
          ),
        };
        next.roleId = roleId;
        notice =
          "✓ Reward role saved. The old role is no longer managed; existing holders keep it.";
      } else if (
        interaction.isModalSubmit() &&
        action === "save-level" &&
        (session.view === "modal" || session.view === "add-modal")
      ) {
        const level = wholeNumber(
          interaction.fields.getTextInputValue("level"),
          "level",
          0,
          MAX_REWARD_LEVEL,
        );
        const adding = session.view === "add-modal";
        const roleId = adding ? session.roleId : this.selected(session).role_id;
        if (!roleId) throw new UserError("Choose a reward role first.");
        if (
          adding &&
          session.config.reward_roles.some(
            (reward) => reward.role_id === roleId,
          )
        )
          throw new UserError(
            "That role already has a milestone. Select its existing reward to edit it.",
          );
        if (adding && session.config.reward_roles.length >= MAX_LEVEL_REWARDS)
          throw new UserError(
            `This server already has ${MAX_LEVEL_REWARDS} reward roles. Remove one first.`,
          );
        await assignableRole(interaction.guild, roleId);
        patch = {
          reward_roles: adding
            ? [...session.config.reward_roles, { role_id: roleId, level }]
            : session.config.reward_roles.map((reward) =>
                reward.role_id === roleId ? { ...reward, level } : reward,
              ),
        };
        next.view = "reward";
        notice = adding ? "✓ Level reward added." : "✓ Required level saved.";
      } else if (
        interaction.isModalSubmit() &&
        action === "save-xp" &&
        session.view === "xp-modal"
      ) {
        const min = wholeNumber(
          interaction.fields.getTextInputValue("min"),
          "minimum XP",
          1,
          10000,
        );
        const max = wholeNumber(
          interaction.fields.getTextInputValue("max"),
          "maximum XP",
          1,
          10000,
        );
        const cooldown = wholeNumber(
          interaction.fields.getTextInputValue("cooldown"),
          "cooldown in seconds",
          1,
          86400,
        );
        if (min > max)
          throw new UserError("Minimum XP must not exceed maximum XP.");
        patch = { xp_gain: { min, max }, xp_cooldown_seconds: cooldown };
        next.view = "xp";
        notice = "✓ XP settings saved. Existing member progress is kept.";
      } else if (
        interaction.isModalSubmit() &&
        action === "save-message" &&
        session.view === "message-modal"
      ) {
        const message = interaction.fields.getTextInputValue("message").trim();
        if (!message || message.length > 1800)
          throw new UserError(
            "Enter a level-up message between 1 and 1,800 characters.",
          );
        patch = { reward_message: message };
        next.view = "channel";
        notice = "✓ Level-up message saved.";
      } else if (
        interaction.isChannelSelectMenu() &&
        action === "destination" &&
        session.view === "channel"
      ) {
        const channelId = interaction.values[0];
        if (!channelId) throw new UserError("Choose one announcement channel.");
        const channel = await sendableChannel(interaction.guild, channelId);
        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        )
          throw new UserError("Choose a server text or announcement channel.");
        patch = { reward_channel_id: channel.id };
        notice = "✓ Level-up channel saved.";
      } else if (interaction.isButton()) {
        if (action === "remove" && session.view === "reward") {
          const selected = this.selected(session);
          patch = {
            reward_roles: session.config.reward_roles.filter(
              (reward) => reward.role_id !== selected.role_id,
            ),
          };
          next.view = "home";
          notice =
            "✓ Reward removed. Members who already have that role keep it.";
        } else if (action === "disable" && session.view === "channel") {
          patch = { reward_channel_id: null };
          notice =
            "✓ Level-up announcements are off. XP and role rewards are unchanged.";
        } else if (
          action === "home" ||
          action === "channel" ||
          action === "xp"
        ) {
          next.view = action;
          next.roleId = undefined;
        } else if (action === "add" && session.view === "home") {
          if (session.config.reward_roles.length >= MAX_LEVEL_REWARDS)
            throw new UserError(
              `This server already has ${MAX_LEVEL_REWARDS} reward roles. Remove one first.`,
            );
          next.view = "add";
          next.roleId = undefined;
        } else if (action === "toggle") {
          patch = { enabled: !session.config.enabled };
          notice = session.config.enabled
            ? "✓ Levels paused. Existing XP and roles are kept."
            : "✓ Levels enabled.";
        } else if (action === "back") next.view = "home";
        else if (action === "refresh")
          next = await this.fresh(context, session);
        else if (
          (action === "previous" || action === "next") &&
          session.view === "home"
        )
          next.page += action === "next" ? 1 : -1;
        else throw new UserError(EXPIRED);
      } else throw new UserError(EXPIRED);

      if (patch) {
        await context.settings.patch(
          session.guildId,
          "levels",
          levelsSchema,
          patch,
          session.revision,
        );
        next = await this.fresh(context, next);
      }
      await interaction.editReply(this.render(interaction.guild, next, notice));
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      // Keep a usable editor after a validation error or an optimistic-lock
      // conflict. Reload current settings and require an explicit retry.
      const current = await this.fresh(context, { ...session, view: "home" });
      const message =
        current.revision !== session.revision
          ? "Settings changed while this editor was open. Nothing from this edit was saved. Review the current settings below and try again."
          : error.message;
      await interaction.editReply(
        this.render(interaction.guild, current, `⚠️ ${message}`),
      );
    }
  }

  private selected(session: Session): Reward {
    const reward = session.config.reward_roles.find(
      (item) => item.role_id === session.roleId,
    );
    if (!reward) throw new UserError(EXPIRED);
    return reward;
  }
}
