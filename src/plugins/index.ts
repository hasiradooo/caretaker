import type { Plugin } from "../core/plugin";
import { birthdayPlugin } from "./birthday";
import { createBotGuardPlugin } from "./bot-guard";
import { createConfigurationPlugin } from "./configuration";
import { levelsPlugin } from "./levels";
import { createRolesPlugin } from "./roles";
import { createSlowmodePlugin } from "./slowmode";
import { createStarboardPlugin } from "./starboard";
import { createTempVoicePlugin } from "./temp-voice";
import { ticketsPlugin } from "./tickets";
import { welcomePlugin } from "./welcome";

/** Add a feature here once. Its settings editor and command deployment follow automatically. */
export function createPlugins(): Plugin[] {
  const plugins: Plugin[] = [
    levelsPlugin,
    welcomePlugin,
    createRolesPlugin(),
    birthdayPlugin,
    ticketsPlugin,
    createStarboardPlugin(),
    createTempVoicePlugin(),
    createSlowmodePlugin(),
    createBotGuardPlugin(),
  ];
  return [...plugins, createConfigurationPlugin(plugins)];
}
