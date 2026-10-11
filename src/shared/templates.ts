/** One replacement pass prevents user names containing {tokens} from being expanded. */
export function renderTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template
    .replace(/\{([a-z_]+)\}/g, (match, key: string) =>
      String(values[key] ?? match),
    )
    .slice(0, 2000);
}
