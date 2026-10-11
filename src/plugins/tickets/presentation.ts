import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { card } from "../../shared/messages";
import type { TicketSettings } from "./config";

/** Padding is cosmetic: numbers keep growing after #9999 and are never truncated. */
export const ticketLabel = (number: string) => `#${number.padStart(4, "0")}`;

export function ticketThreadName(number: string, username: string): string {
  const member = username.replace(/[^a-z0-9-]/gi, "").slice(0, 30) || "member";
  return `ticket-${number.padStart(4, "0")}-${member}`;
}

/** A disabled preview uses the same renderer without allowing a ticket to open. */
export function ticketPanel(config: TicketSettings, preview = false) {
  return card({
    title: config.panel.title,
    icon: "🎫",
    body: config.panel.message,
    sections: [
      "**How it works**\n1. Open a private ticket thread below.\n2. Tell the support team what you need.\n3. A moderator will close the ticket when it is resolved.\n\nYou can have one ongoing ticket at a time. Opening again takes you to that ticket.",
    ],
    footer: preview
      ? "Private preview · No panel has been published"
      : "Visible to you and server staff · One open ticket per member",
    actions: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("tickets:open")
          .setLabel(config.panel.button_label)
          .setEmoji("🎫")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(preview),
      ),
    ],
  });
}
