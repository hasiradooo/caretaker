import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type REST, Routes } from "discord.js";
import { botProfile } from "../src/config/profile";
import {
    type BuildIdentity,
    identifyBuild,
    packageVersion,
} from "../src/config/version";
import {
    preserveRuntimeBio,
    syncRuntimeBio,
    versionedBio,
} from "../src/core/profile";

const directory = mkdtempSync(join(tmpdir(), "caretaker-version-"));
afterAll(() => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
        throw new Error("Unexpected version test directory.");
    rmSync(directory, { recursive: true, force: true });
});

const identity: BuildIdentity = {
    version: "2.0.0",
    build: "0123456789ab",
    label: "v2.0.0+0123456789ab",
};
const startedAt = new Date("2026-10-27T09:30:12Z");
const applicationId = "100000000000000001";

test("build IDs are stable for the same bundle and change with code or locked dependencies", () => {
    mkdirSync(join(directory, "dist"));
    const entrypoint = join(directory, "dist", "index.js");
    const lockfile = join(directory, "bun.lock");
    writeFileSync(entrypoint, "console.log('first build');");
    writeFileSync(lockfile, "first dependencies");
    const first = identifyBuild(entrypoint);
    expect(first.version).toBe(packageVersion);
    expect(first.build).toMatch(/^[a-f0-9]{12}$/);
    expect(identifyBuild(entrypoint)).toEqual(first);
    writeFileSync(entrypoint, "console.log('second build');");
    const second = identifyBuild(entrypoint);
    expect(second.build).not.toBe(first.build);
    writeFileSync(lockfile, "new dependencies");
    expect(identifyBuild(entrypoint).build).not.toBe(second.build);
});

test("source runs are explicitly identified as development builds", () => {
    expect(identifyBuild(join(directory, "index.ts"))).toEqual({
        version: packageVersion,
        build: "dev",
        label: `v${packageVersion}+dev`,
    });
});

test("restarts replace the build and startup lines while preserving custom bio text", () => {
    const first = versionedBio(
        "A custom server helper.\nUse /help.",
        identity,
        startedAt,
    );
    const restarted = versionedBio(
        first,
        { ...identity, label: "v2.0.0+abcdef123456" },
        new Date("2026-10-27T10:00:00Z"),
    );
    expect(restarted).toStartWith("A custom server helper.\nUse /help.");
    expect(restarted).toContain("Caretaker build: v2.0.0+abcdef123456");
    expect(restarted).toContain("Last start: 2026-10-27 10:00:00 UTC");
    expect(restarted).not.toContain(identity.label);
    expect(restarted.match(/Caretaker build:/g)).toHaveLength(1);
    expect(restarted.match(/Last start:/g)).toHaveLength(1);
});

test("long bios fit within Discord's limit without losing the running build or splitting emoji", () => {
    const description = versionedBio("🐇".repeat(200), identity, startedAt);
    expect(description.length).toBeLessThanOrEqual(400);
    expect(description).toContain(identity.label);
    expect(description).toEndWith("Last start: 2026-10-27 09:30:12 UTC");
    expect(description.split("\n\n")[0]).toMatch(/^(🐇)+…$/u);
});

test("manual profile edits preserve the running version and startup time", () => {
    const current = versionedBio("Old text", identity, startedAt);
    const updated = preserveRuntimeBio("New text", current);
    expect(updated).toBe(versionedBio("New text", identity, startedAt));
    expect(preserveRuntimeBio("New text", "No runtime footer")).toBe(
        "New text",
    );
});

function fixture(description = "Custom About Me") {
    let stored = description;
    const rest = {
        get: mock(async (_route: string) => ({
            id: applicationId,
            description: stored,
        })),
        patch: mock(
            async (
                _route: string,
                options: { body: { description: string } },
            ) => {
                stored = options.body.description;
                return { id: applicationId, description: stored };
            },
        ),
    };
    return {
        rest,
        sync: () =>
            syncRuntimeBio(
                rest as unknown as Pick<REST, "get" | "patch">,
                applicationId,
                identity,
                startedAt,
            ),
        stored: () => stored,
    };
}

test("startup publishes and verifies only the versioned description, preserving existing text", async () => {
    const f = fixture();
    await f.sync();
    expect(f.rest.patch).toHaveBeenCalledWith(Routes.currentApplication(), {
        body: {
            description: versionedBio("Custom About Me", identity, startedAt),
        },
    });
    expect(f.rest.get).toHaveBeenCalledTimes(2);
    await f.sync();
    expect(f.rest.patch).toHaveBeenCalledTimes(1);
});

test("an empty bio uses the configured text with the version footer", async () => {
    const f = fixture("");
    await f.sync();
    expect(f.stored()).toBe(versionedBio(botProfile.bio, identity, startedAt));
});

test("a mismatched application cannot receive a bio update", async () => {
    const f = fixture();
    f.rest.get.mockResolvedValueOnce({
        id: "100000000000000002",
        description: "Other bot",
    });
    await expect(f.sync()).rejects.toThrow("does not match");
    expect(f.rest.patch).not.toHaveBeenCalled();
});

test("failed or unverified bio updates are reported to the startup caller", async () => {
    const failed = fixture();
    failed.rest.patch.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(failed.sync()).rejects.toThrow("Discord unavailable");
    const unverified = fixture();
    unverified.rest.get.mockResolvedValueOnce({
        id: applicationId,
        description: "Old text",
    });
    unverified.rest.get.mockResolvedValueOnce({
        id: applicationId,
        description: "Unexpected text",
    });
    await expect(unverified.sync()).rejects.toThrow("expected versioned bio");
});
