import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function keyBuffer(key: string): Buffer {
  if (!/^[a-f\d]{64}$/i.test(key))
    throw new Error("Encryption key must be 64 hexadecimal characters");
  return Buffer.from(key, "hex");
}
/** Keep the old iv:ciphertext:tag envelope so existing encrypted tokens remain readable. */
export function encryptToken(token: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(key), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, data, cipher.getAuthTag()]
    .map((part) => part.toString("base64"))
    .join(":");
}
export function decryptToken(envelope: string, key: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted token envelope");
  const [iv, data, tag] = parts.map((part) => Buffer.from(part, "base64"));
  if (!iv || !data || !tag || iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid encrypted token envelope");
  const cipher = createDecipheriv("aes-256-gcm", keyBuffer(key), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
