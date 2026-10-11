import { z } from "zod";
import { baseSettings, snowflake } from "../../shared/validation";

export const rolesSchema = z
  .object({
    ...baseSettings,
    title: z.string().min(1).max(200).default("Choose your roles"),
    description: z
      .string()
      .min(1)
      .max(1500)
      .default(
        "Select the roles you would like. Clearing the selection removes your self-selected roles.",
      ),
    roles: z
      .array(
        z.object({
          role_id: snowflake,
          label: z.string().min(1).max(100),
          description: z.string().max(100).optional(),
        }),
      )
      .max(25)
      .default([]),
  })
  .passthrough()
  .refine(
    (config) =>
      new Set(config.roles.map((role) => role.role_id)).size ===
      config.roles.length,
    { path: ["roles"], message: "Role IDs must be unique" },
  );
