export function isBirthday(day: number, month: number, year = 2000): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    Number.isInteger(day) &&
    Number.isInteger(month) &&
    date.getUTCDate() === day &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCFullYear() === year
  );
}
export function localDate(
  now: Date,
  timezone: string,
): { day: number; month: number; year: number; hour: number; key: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (name: string) =>
    Number(parts.find((part) => part.type === name)?.value);
  const day = get("day"),
    month = get("month"),
    year = get("year"),
    hour = get("hour");
  return { day, month, year, hour, key: `${year}-${month}-${day}` };
}
