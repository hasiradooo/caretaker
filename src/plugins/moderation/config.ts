import { z } from "zod";
import { baseSettings, optionalId, roleIds } from "../../shared/validation";

export const MAX_RULES = 20;
export const ruleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    enabled: z.boolean().default(false),
    event: z.enum(["create", "edit", "both"]).default("edit"),
    condition: z
      .enum(["links", "invites", "words", "domains", "attachments", "mentions"])
      .default("links"),
    values: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine(
            (value) =>
              value
                .normalize("NFKC")
                .replace(/\p{Cf}/gu, "")
                .trim().length > 0,
            "Use visible words or domains, not only invisible characters.",
          ),
      )
      .max(50)
      .default([])
      .refine(
        (values) => values.join("\n").length <= 4000,
        "Matching entries must fit within 4,000 characters.",
      ),
    mention_limit: z.number().int().min(1).max(100).default(5),
    action: z.enum(["delete", "delete_timeout", "log"]).default("delete"),
    timeout_minutes: z.number().int().min(1).max(40320).default(10),
    // Empty scopes mean all members/channels; parent channel selections include threads.
    channels: roleIds,
    roles: roleIds,
  })
  .superRefine((rule, ctx) => {
    if (
      rule.enabled &&
      ["words", "domains"].includes(rule.condition) &&
      !rule.values.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["values"],
        message: "Add at least one word or domain before enabling this rule.",
      });
    if (
      rule.condition === "domains" &&
      rule.values.some(
        (value) => !/^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}$/u.test(value),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["values"],
        message:
          "Use domain names such as example.com, without URLs, paths or wildcards.",
      });
  });
export const moderationSchema = z
  .object({
    ...baseSettings,
    rules: z.array(ruleSchema).max(MAX_RULES).default([]),
    exempt_roles: roleIds,
    exempt_channels: roleIds,
    exempt_staff: z.boolean().default(true),
    include_bots: z.boolean().default(false),
    log_channel_id: optionalId,
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (
      new Set(config.rules.map((rule) => rule.id)).size !== config.rules.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "Each moderation rule needs a unique ID.",
      });
    if (
      config.enabled &&
      !config.log_channel_id &&
      config.rules.some((rule) => rule.enabled && rule.action === "log")
    )
      ctx.addIssue({
        code: "custom",
        path: ["log_channel_id"],
        message: "Choose a log channel before enabling log-only rules.",
      });
  });
export type ModerationRule = z.infer<typeof ruleSchema>;
export type ModerationSettings = z.infer<typeof moderationSchema>;
