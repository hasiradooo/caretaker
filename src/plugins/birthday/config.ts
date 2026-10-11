import { z } from "zod";
import {
  baseSettings,
  messageTemplate,
  optionalId,
} from "../../shared/validation";
import { isBirthday } from "./dates";

export const birthdaySchema = z
  .object({
    ...baseSettings,
    channel_id: optionalId,
    timezone: z
      .string()
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Use an IANA time zone, e.g. Europe/Warsaw")
      .default("UTC"),
    hour: z.number().int().min(0).max(23).default(9),
    message: messageTemplate.default("Happy birthday, {user}! 🎂"),
  })
  .passthrough();
export type BirthdaySettings = z.infer<typeof birthdaySchema>;
export const birthdayDateSchema = z
  .object({
    day: z.number().int(),
    month: z.number().int(),
    year: z
      .number()
      .int()
      .min(1900)
      .max(new Date().getUTCFullYear())
      .nullable()
      .optional(),
  })
  .refine(
    (date) => isBirthday(date.day, date.month, date.year ?? 2000),
    "Invalid calendar date",
  );
