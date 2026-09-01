import { db } from "./db";
import {
  envSystemFlagDefault,
  SYSTEM_FLAG_KEYS,
  SystemFlagKey,
} from "./feature-flags";

/** Stored override if present, else the env default. */
export async function systemFlagEnabled(key: SystemFlagKey): Promise<boolean> {
  const row = await db.systemFlag.findUnique({ where: { key } });
  return row ? row.value : envSystemFlagDefault(key);
}

/** Only keys with a stored override are present (mirrors org features). */
export async function listSystemFlagOverrides(): Promise<Record<string, boolean>> {
  const rows = await db.systemFlag.findMany({
    where: { key: { in: [...SYSTEM_FLAG_KEYS] } },
  });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
