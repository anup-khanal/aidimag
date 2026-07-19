import { isIP } from "node:net";

/** Block SSRF to private/link-local/metadata hosts when fetching user-supplied URLs. */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;

  const ipVer = isIP(host);
  if (ipVer === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  if (ipVer === 6) {
    if (host === "::1") return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    if (host.startsWith("fe80")) return true;
  }
  return false;
}

/** Validate http(s) ticket provider base URLs before server-side fetch. */
export function isAllowedTicketBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    return !isBlockedFetchHost(u.hostname);
  } catch {
    return false;
  }
}

/** Validate cloud/sync server URLs before storing from the local UI. */
export function isAllowedSyncServerUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    return !isBlockedFetchHost(host);
  } catch {
    return false;
  }
}
