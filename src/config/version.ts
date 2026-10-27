import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import manifest from "../../package.json";

export const packageVersion = manifest.version;

export interface BuildIdentity {
    version: string;
    build: string;
    label: string;
}

/** Fingerprint the code actually running, even in Docker images without Git. */
export function identifyBuild(entrypoint = Bun.main): BuildIdentity {
    let build = "dev";
    if (![".ts", ".tsx"].includes(extname(entrypoint))) {
        const hash = createHash("sha256")
            .update(readFileSync(entrypoint))
            .update(JSON.stringify(manifest));
        const lockfile = resolve(dirname(entrypoint), "..", "bun.lock");
        if (existsSync(lockfile)) hash.update(readFileSync(lockfile));
        build = hash.digest("hex").slice(0, 12);
    }
    return {
        version: packageVersion,
        build,
        label: `v${packageVersion}+${build}`,
    };
}
