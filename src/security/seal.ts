import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Encrypt a one-time device-flow token for brief DB storage (decrypted on poll). */
export function sealDeviceToken(plaintext: string, secret: string): string {
  const key = createHash("sha256").update(`aidimag-device:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function unsealDeviceToken(sealed: string, secret: string): string | null {
  try {
    const buf = Buffer.from(sealed, "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const key = createHash("sha256").update(`aidimag-device:${secret}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
