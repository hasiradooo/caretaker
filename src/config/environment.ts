import { z } from "zod";

const boolean = z
    .enum(["true", "false"])
    .transform((value) => value === "true");
const environmentSchema = z
    .object({
        DISCORD_TOKEN: z.string().min(1),
        DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
        DATABASE_URL: z
            .string()
            .url()
            .refine((value) => /^postgres(ql)?:/.test(value)),
        MASTER_ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
        BOT_NAME: z.string().min(1).max(32).default("Caretaker"),
        BOT_OWNER_ID: z
            .string()
            .regex(/^\d{17,20}$/)
            .optional(),
        DATABASE_SSL: z.enum(["verify-full", "disable"]).default("verify-full"),
        DATABASE_CA_FILE: z.string().optional(),
        DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(5),
        HTTP_ENABLED: boolean.default(false),
        HTTP_HOST: z.string().default("127.0.0.1"),
        PORT: z.coerce.number().int().min(1).max(65535).default(8000),
        API_SECRET_KEY: z.string().min(32).optional(),
        COMMAND_GUILD_ID: z
            .string()
            .regex(/^\d{17,20}$/)
            .optional(),
        LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .superRefine((env, ctx) => {
        if (env.HTTP_ENABLED && !env.API_SECRET_KEY) {
            ctx.addIssue({
                code: "custom",
                path: ["API_SECRET_KEY"],
                message: "is required when HTTP_ENABLED=true",
            });
        }
    });

export type Environment = z.infer<typeof environmentSchema>;

/** Parsing is explicit: importing a plugin never logs in or opens the database. */
export function readEnvironment(
    source: Record<string, string | undefined> = process.env,
): Environment {
    const result = environmentSchema.safeParse(source);
    if (!result.success) {
        // Zod input values may contain secrets; report field names and rules only.
        throw new Error(
            `Invalid environment: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        );
    }
    return result.data;
}
