import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  Interaction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { z } from "zod";
import type { Environment } from "../config/environment";
import type { Database } from "../database/connection";
import type { SettingsStore } from "../database/settings-store";
import type { StateStore } from "../database/state-store";
import type { Logger } from "../shared/logger";
import type { Settings } from "../shared/validation";

export interface Context {
  client: Client;
  botId: string;
  env: Environment;
  db: Database;
  settings: SettingsStore;
  state: StateStore;
  log: Logger;
}

export interface Command {
  data: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  /** Decide before deferring; Discord cannot change visibility on a later edit.
   * Keep this synchronous. Commands are private unless they explicitly opt in. */
  visibility?(
    interaction: ChatInputCommandInteraction<"cached">,
  ): "public" | "private";
  execute(
    context: Context,
    interaction: ChatInputCommandInteraction<"cached">,
  ): Promise<void>;
}

export interface EventRegistrar {
  on<K extends keyof ClientEvents>(
    event: K,
    handler: (...args: ClientEvents[K]) => Promise<void>,
  ): void;
  every(milliseconds: number, task: () => Promise<void>): void;
}

/** A plugin owns its commands, schema and event handlers. Infrastructure stays shared. */
export interface Plugin {
  id: string;
  name: string;
  description: string;
  schema: z.ZodType<Settings>;
  commands?: Command[];
  register?(context: Context, events: EventRegistrar): void;
  component?(
    context: Context,
    interaction: Interaction<"cached">,
  ): Promise<void>;
  /** Explicit opt-in for DM buttons; guild commands and editors stay guild-only.
   * Return false for buttons this plugin does not handle in direct messages. */
  directMessageComponent?(
    context: Context,
    interaction: ButtonInteraction,
  ): Promise<boolean>;
  stop?(context: Context): Promise<void>;
}
