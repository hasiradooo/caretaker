import { encryptToken } from "../src/database/encryption";

// Intentional output for this utility only. The running bot never logs tokens.
const key = process.env.MASTER_ENCRYPTION_KEY;
const token = process.env.DISCORD_TOKEN;
if (!key || !token)
  throw new Error(
    "Set MASTER_ENCRYPTION_KEY and DISCORD_TOKEN in the environment",
  );
console.log(encryptToken(token, key));
