import fs from "node:fs";
import path from "node:path";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

export function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

export function resolveUserPathWithHome(input: string, home?: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    if (!home) {
      throw new Error("Missing HOME");
    }
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = env.HEPHIE_STATE_DIR?.trim() || env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveHomeDir(env);
  const profile = env.HEPHIE_PROFILE || env.OPENCLAW_PROFILE;
  const suffix = resolveGatewayProfileSuffix(profile);
  // Prefer new .hephie dir, fall back to .openclaw if it exists
  const newDir = path.join(home, `.hephie${suffix}`);
  const legacyDir = path.join(home, `.openclaw${suffix}`);
  if (fs.existsSync(newDir)) {
    return newDir;
  }
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  return newDir;
}
