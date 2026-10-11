import { z } from "zod";
import {
    baseSettings,
    optionalId,
    roleIds,
    snowflake,
} from "../../shared/validation";

export const ticketsSchema = z
    .object({
        ...baseSettings,
        category_id: optionalId,
        parent_channel_id: optionalId,
        panel_channel_id: optionalId,
        panel: z
            .object({
                title: z
                    .string()
                    .trim()
                    .min(1)
                    .max(100)
                    .default("Support desk"),
                message: z
                    .string()
                    .trim()
                    .min(1)
                    .max(1800)
                    .default(
                        "Need a hand? Open a private thread with the server's support team.",
                    ),
                button_label: z
                    .string()
                    .trim()
                    .min(1)
                    .max(80)
                    .default("Open ticket"),
            })
            .default({
                title: "Support desk",
                message:
                    "Need a hand? Open a private thread with the server's support team.",
                button_label: "Open ticket",
            }),
        admin_channel_id: optionalId,
        transcript_channel_id: optionalId,
        mods_role_ids: roleIds,
        auto_close: z
            .object({
                enabled: z.boolean().default(false),
                threshold_ms: z
                    .number()
                    .int()
                    .min(60000)
                    .max(2592000000)
                    .default(259200000),
                warning_ms: z
                    .number()
                    .int()
                    .min(60000)
                    .max(2592000000)
                    .default(1800000),
                reason: z.string().max(400).default("Closed after inactivity"),
            })
            .default({
                enabled: false,
                threshold_ms: 259200000,
                warning_ms: 1800000,
                reason: "Closed after inactivity",
            }),
        role_time_limits: z
            .object({
                included: z
                    .array(
                        z.object({
                            role_id: snowflake,
                            threshold_seconds: z
                                .number()
                                .int()
                                .min(60)
                                .max(2592000),
                        }),
                    )
                    .default([]),
                excluded: roleIds,
            })
            .default({ included: [], excluded: [] }),
    })
    .passthrough();
export type TicketSettings = z.infer<typeof ticketsSchema>;
