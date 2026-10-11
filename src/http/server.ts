import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import type { Context, Plugin } from "../core/plugin";
import { BirthdayRepository } from "../plugins/birthday/repository";
import { LevelsRepository } from "../plugins/levels/repository";
import { UserError } from "../shared/errors";
import { isRecord, snowflake } from "../shared/validation";

const json = (data: unknown, status = 200) =>
  Response.json(
    { success: status < 400, ...(status < 400 ? { data } : { error: data }) },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );

export function validApiKey(
  provided: string | null,
  expected: string | undefined,
): boolean {
  if (!provided || !expected || expected.length < 32 || provided.length > 512)
    return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new UserError("Content-Type must be application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new UserError("A JSON body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        throw new UserError("Request body exceeds 64 KB");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UserError("Invalid JSON");
  }
  if (!isRecord(result)) throw new UserError("Expected a JSON object");
  return result;
}

function pagination(url: URL): { limit: number; offset: number } {
  const page = Number(url.searchParams.get("page") ?? 1);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new UserError("Invalid pagination: page 1–10000, limit 1–100");
  return { limit, offset: (page - 1) * limit };
}

/** This API key is for a trusted backend. Never embed it in a public website. */
export function createHttpHandler(
  context: Context,
  plugins: Plugin[],
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET")
      return json(
        { ready: context.client.isReady() },
        context.client.isReady() ? 200 : 503,
      );
    const provided =
      request.headers.get("x-api-key") ??
      (request.headers.get("authorization")?.startsWith("Bearer ")
        ? (request.headers.get("authorization")?.slice(7) ?? null)
        : null);
    if (!validApiKey(provided, context.env.API_SECRET_KEY))
      return json("Unauthorized", 401);
    try {
      const path = url.pathname.replace(/\/$/, "");
      if (path === "/discord/v1/status" && request.method === "GET")
        return json({
          name: context.env.BOT_NAME,
          version: "2.0.0",
          ready: context.client.isReady(),
        });
      if (path === "/discord/v1/ping" && request.method === "GET")
        return json({ pong: true });
      if (path === "/discord/v1/plugins" && request.method === "GET")
        return json(
          plugins.map(({ id, name, description }) => ({
            id,
            name,
            description,
          })),
        );
      if (path.startsWith("/discord/v1/webhooks/"))
        return json(
          "Provider webhooks are not configured; no event was processed",
          501,
        );
      // Legacy global routes remain available, scoped to THIS bot instead of all tenants.
      if (
        path === "/discord/v1/leaderboards/global" &&
        request.method === "GET"
      ) {
        const { limit, offset } = pagination(url);
        return json(
          await context.db.query(
            `select user_id,sum(1500::bigint*level*(level+1)+xp)::text as total_xp
          from discord.user_levels where bot_id=$1 group by user_id order by sum(1500::bigint*level*(level+1)+xp) desc,user_id limit $2 offset $3`,
            [context.botId, limit, offset],
          ),
        );
      }
      if (
        path === "/discord/v1/leaderboards/total-xp" &&
        request.method === "GET"
      )
        return json(
          (
            await context.db.query(
              "select coalesce(sum(1500::bigint*level*(level+1)+xp),0)::text as total_xp from discord.user_levels where bot_id=$1",
              [context.botId],
            )
          )[0],
        );
      const match =
        /^\/discord\/v1\/bots\/(\d{17,20})\/guilds(?:\/(\d{17,20}))?(?:\/(plugins|leaderboard|birthdays))?(?:\/([a-z_0-9]+))?$/.exec(
          path,
        );
      if (!match || match[1] !== context.botId) return json("Not found", 404);
      const guildId = match[2],
        resource = match[3],
        item = match[4];
      if (!guildId)
        return request.method === "GET"
          ? json(
              context.client.guilds.cache.map((guild) => ({
                guild_id: guild.id,
                name: guild.name,
                member_count: guild.memberCount,
              })),
            )
          : json("Method not allowed", 405);
      const guild = context.client.guilds.cache.get(guildId);
      if (!guild) return json("Not found", 404);
      if (!resource)
        return request.method === "GET"
          ? json({
              guild_id: guild.id,
              name: guild.name,
              member_count: guild.memberCount,
            })
          : json("Method not allowed", 405);
      if (resource === "leaderboard" && !item && request.method === "GET") {
        const { limit, offset } = pagination(url);
        return json(
          await new LevelsRepository(context.db, context.botId).leaderboard(
            guildId,
            limit,
            offset,
          ),
        );
      }
      if (resource === "plugins") {
        if (!item && request.method === "GET")
          return json(
            await Promise.all(
              plugins
                .filter((plugin) => plugin.id !== "configuration")
                .map(async (plugin) => ({
                  plugin_name: plugin.id,
                  ...(await context.settings.raw(guildId, plugin.id)),
                })),
            ),
          );
        const plugin = plugins.find(
          (candidate) =>
            candidate.id === item && candidate.id !== "configuration",
        );
        if (!plugin) return json("Plugin not found", 404);
        if (request.method === "PATCH") {
          const input = await body(request);
          if (input.config !== undefined && !isRecord(input.config))
            throw new UserError("config must be an object");
          const patch = {
            ...(isRecord(input.config) ? input.config : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          };
          return json(
            await context.settings.patch(
              guildId,
              plugin.id,
              plugin.schema,
              patch,
            ),
          );
        }
        if (request.method === "GET")
          return json(
            await context.settings.get(guildId, plugin.id, plugin.schema),
          );
      }
      if (resource === "birthdays") {
        const repository = new BirthdayRepository(context.db, context.botId);
        if (!item && request.method === "GET") {
          const { limit, offset } = pagination(url);
          return json(
            await context.db.query(
              "select user_id,day,month,year from discord.user_bdays where bot_id=$1 and guild_id=$2 order by month,day,user_id limit $3 offset $4",
              [context.botId, guildId, limit, offset],
            ),
          );
        }
        if (item === "today" && request.method === "GET") {
          const { birthdaySchema } = await import("../plugins/birthday/config");
          const { localDate } = await import("../plugins/birthday/dates");
          const config = await context.settings.get(
            guildId,
            "birthday",
            birthdaySchema,
          );
          const date = localDate(new Date(), config.timezone);
          return json(await repository.onDate(guildId, date.month, date.day));
        }
        const userId = snowflake.parse(item);
        if (request.method === "GET") {
          const row = await repository.get(guildId, userId);
          return row ? json(row) : json("Not found", 404);
        }
        if (request.method === "PUT") {
          await repository.set(guildId, userId, await body(request));
          return json({ saved: true });
        }
        if (request.method === "DELETE") {
          await repository.remove(guildId, userId);
          return new Response(null, { status: 204 });
        }
      }
      return json("Method not allowed", 405);
    } catch (error) {
      if (error instanceof UserError) return json(error.message, 400);
      if (error instanceof ZodError)
        return json(
          error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
          400,
        );
      context.log.error("HTTP request failed", error);
      return json("Internal server error", 500);
    }
  };
}

export function startHttpServer(context: Context, plugins: Plugin[]) {
  const handle = createHttpHandler(context, plugins);
  const windows = new Map<string, { count: number; resets: number }>();
  return Bun.serve({
    hostname: context.env.HTTP_HOST,
    port: context.env.PORT,
    maxRequestBodySize: 65536,
    async fetch(request, server) {
      const ip = server.requestIP(request)?.address ?? "unknown";
      const now = Date.now();
      if (windows.size > 10000)
        for (const [key, item] of windows)
          if (item.resets <= now) windows.delete(key);
      if (windows.size > 10000 && !windows.has(ip)) return json("Busy", 429);
      const window = windows.get(ip);
      if (!window || window.resets <= now)
        windows.set(ip, { count: 1, resets: now + 60000 });
      else if (++window.count > 120) return json("Rate limit exceeded", 429);
      return handle(request);
    },
  });
}
