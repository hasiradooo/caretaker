import {
    type ClientEvents,
    Events,
    type Interaction,
    MessageFlags,
} from "discord.js";
import { ZodError } from "zod";
import { UserError } from "../shared/errors";
import { card } from "../shared/messages";
import type { Context, EventRegistrar, Plugin } from "./plugin";

export class PluginRuntime {
    private readonly pending = new Set<Promise<void>>();
    private readonly cleanup: Array<() => void> = [];
    private stopping = false;
    constructor(
        private readonly context: Context,
        readonly plugins: Plugin[],
    ) {
        const ids = plugins.map((plugin) => plugin.id);
        const commands = plugins.flatMap(
            (plugin) =>
                plugin.commands?.map((command) => command.data.toJSON().name) ?? [],
        );
        if (
            new Set(ids).size !== ids.length ||
            new Set(commands).size !== commands.length
        )
            throw new Error("Duplicate plugin or command registration");
    }

    start(): void {
        const { client, log } = this.context;
        for (const plugin of this.plugins) {
            const events: EventRegistrar = {
                on: <K extends keyof ClientEvents>(
                    event: K,
                    handler: (...args: ClientEvents[K]) => Promise<void>,
                ) => {
                    const listener = (...args: ClientEvents[K]) =>
                        this.track(() => handler(...args), `${plugin.id}:${event}`);
                    client.on(event, listener);
                    this.cleanup.push(() => client.off(event, listener));
                },
                every: (milliseconds, task) => {
                    let busy = false;
                    const tick = () => {
                        if (busy) return;
                        busy = true;
                        this.track(async () => {
                            try {
                                await task();
                            } finally {
                                busy = false;
                            }
                        }, `${plugin.id}:schedule`);
                    };
                    tick();
                    const timer = setInterval(tick, milliseconds);
                    timer.unref();
                    this.cleanup.push(() => clearInterval(timer));
                },
            };
            plugin.register?.(this.context, events);
            log.info(`Loaded plugin: ${plugin.id}`);
        }
        const listener = (interaction: Interaction) =>
            this.track(() => this.dispatch(interaction), "interaction");
        client.on(Events.InteractionCreate, listener);
        this.cleanup.push(() => client.off(Events.InteractionCreate, listener));
    }

    private track(task: () => Promise<void>, name: string): void {
        if (this.stopping) return;
        const operation = Promise.resolve()
            .then(task)
            .catch((error: unknown) =>
                this.context.log.error(`${name} failed`, error),
            );
        this.pending.add(operation);
        void operation.finally(() => this.pending.delete(operation));
    }

    async dispatch(interaction: Interaction): Promise<void> {
        if (!interaction.isRepliable()) return;
        try {
            if (!interaction.inCachedGuild()) {
                if (interaction.guildId === null && interaction.isButton()) {
                    const plugin = this.plugins.find(
                        (candidate) => candidate.id === interaction.customId.split(":")[0],
                    );
                    if (await plugin?.directMessageComponent?.(this.context, interaction))
                        return;
                }
                await interaction.reply({
                    ...card({
                        title: "Meet me in the server",
                        body: "Use this command inside a server where I am a member.",
                        icon: "🧭",
                    }),
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                });
                return;
            }
            if (interaction.isChatInputCommand()) {
                const command = this.plugins
                    .flatMap((plugin) => plugin.commands ?? [])
                    .find(
                        (candidate) =>
                            candidate.data.toJSON().name === interaction.commandName,
                    );
                if (!command)
                    throw new UserError(
                        "This command is outdated. Ask an administrator to deploy commands again.",
                    );
                // Acknowledge before any database/network calls so slow queries do not time out.
                await interaction.deferReply(
                    command.visibility?.(interaction) === "public"
                        ? {}
                        : { flags: MessageFlags.Ephemeral },
                );
                await command.execute(this.context, interaction);
            } else if (
                interaction.isMessageComponent() ||
                interaction.isModalSubmit()
            ) {
                const plugin = this.plugins.find(
                    (candidate) => candidate.id === interaction.customId.split(":")[0],
                );
                if (!plugin?.component)
                    throw new UserError(
                        "This panel is outdated. Please create a new one.",
                    );
                await plugin.component(this.context, interaction);
            }
        } catch (error) {
            this.context.log.error("Interaction failed", error);
            const content =
                error instanceof UserError
                    ? error.message
                    : error instanceof ZodError
                        ? `Invalid settings: ${error.issues
                            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                            .join("; ")
                            .slice(0, 1600)}`
                        : "Something went wrong. Your request could not be completed; please try again.";
            try {
                const payload = card({
                    title: "Could not complete that",
                    body: content,
                    icon: "⚠️",
                });
                if (interaction.deferred || interaction.replied)
                    // Clear legacy fields when upgrading an existing reply to V2.
                    await interaction.editReply({
                        ...payload,
                        content: null,
                        embeds: [],
                        attachments: [],
                    });
                else
                    await interaction.reply({
                        ...payload,
                        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    });
            } catch (replyError) {
                this.context.log.warn(
                    "Could not deliver interaction error",
                    replyError,
                );
            }
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        for (const dispose of this.cleanup.splice(0)) dispose();
        await Promise.allSettled(this.pending);
        for (const plugin of [...this.plugins].reverse()) {
            try {
                await plugin.stop?.(this.context);
            } catch (error) {
                this.context.log.warn(`Shutdown failed for plugin ${plugin.id}`, error);
            }
        }
    }
}
