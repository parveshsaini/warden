import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a presented key against an expected key in constant time.
 * Both are hashed first so lengths are equal and length isn't leaked.
 */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Merges API keys from config with the WARDEN_API_KEYS environment variable
 * (comma-separated) so deployments can inject keys without writing them into
 * the config file.
 */
export function resolveApiKeys(configKeys: string[] | undefined, envValue?: string): string[] {
  const fromEnv = (envValue ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return [...new Set([...(configKeys ?? []), ...fromEnv])];
}

/** True when the Authorization header carries a Bearer token matching any key. */
export function isAuthorized(authorizationHeader: string | undefined, keys: string[]): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const presented = authorizationHeader.slice("Bearer ".length).trim();
  if (presented.length === 0) return false;
  return keys.some((key) => safeEqual(presented, key));
}
