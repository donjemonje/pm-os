/**
 * PM-OS local scan station — the saved place of every scan it is reading (Daniel 2026-11-12; one per scan since
 * 2026-11-16, when the station started reading several sites at the same time).
 *
 *   <state-dir>/scan-state/<scanId>.json   one file per scan, written before every page: what is left to read, what
 *                                          was already seen, the counters. Removed when the scan is over on the server.
 *   <state-dir>/scan-state.json            the single file of the one-scan-at-a-time station. Found at a check-in, it
 *                                          is moved into the folder as it is (same scan, same reason, same time), so a
 *                                          scan that station was reading continues from the page it stopped on.
 *
 * Whatever stops the station — the network, a shutdown, a crash, a power cut — the next check-in finds these files,
 * tells PM-OS why each scan stopped, and continues each with the page it was on.
 *
 * Everything here is synchronous (it also runs in signal and crash handlers) and takes the state folder as an
 * argument: nothing happens when the module is loaded.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_FILE = "scan-state.json";
export const PLACES_DIR = "scan-state";

function valid(s) {
  return s && typeof s === "object" && typeof s.scanId === "string" && s.scanId && Array.isArray(s.queue) && Array.isArray(s.seen) ? s : null;
}

function read(file) {
  try {
    return valid(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function write(file, place) {
  writeFileSync(`${file}.tmp`, JSON.stringify(place));
  renameSync(`${file}.tmp`, file);
}

function remove(file) {
  try {
    unlinkSync(file);
  } catch {
    // nothing there
  }
}

/** The file of one scan's place. The scan id is PM-OS's; it is encoded so it can never name another folder. */
export function placeFile(stateDir, scanId) {
  return join(stateDir, PLACES_DIR, `${encodeURIComponent(scanId)}.json`);
}

/** The saved place of this scan, or null. */
export function loadPlace(stateDir, scanId) {
  const s = read(placeFile(stateDir, scanId));
  return s && s.scanId === scanId ? s : null;
}

/** Save a scan's place (stamped with the time). Throws when the file cannot be written — the caller logs it and reads on. */
export function savePlace(stateDir, place) {
  mkdirSync(join(stateDir, PLACES_DIR), { recursive: true });
  write(placeFile(stateDir, place.scanId), { ...place, savedAt: new Date().toISOString() });
}

export function clearPlace(stateDir, scanId) {
  remove(placeFile(stateDir, scanId));
  remove(`${placeFile(stateDir, scanId)}.tmp`);
}

/**
 * Marks why a scan stopped, on the place already saved (the first reason stays). Returns true when the scan has a
 * saved place. Never throws: it runs in signal and crash handlers.
 */
export function markStopped(stateDir, scanId, reason, detail) {
  try {
    const s = loadPlace(stateDir, scanId);
    if (!s) return false;
    if (!s.stopped) write(placeFile(stateDir, scanId), { ...s, stopped: { reason, at: new Date().toISOString(), ...(detail ? { detail: String(detail).slice(0, 200) } : {}) }, savedAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The single file of the one-scan-at-a-time station becomes that scan's own file, unchanged (its reason and times are
 * what PM-OS is told). The old file is removed only once the new one is written; a scan that already has its own file
 * keeps it (it is newer). Returns the place that was moved, or null.
 */
export function adoptLegacyPlace(stateDir) {
  const legacy = join(stateDir, LEGACY_FILE);
  if (!existsSync(legacy)) return null;
  const s = read(legacy);
  if (!s) {
    // Not a place (an empty or broken file): the old station ignored it too.
    remove(legacy);
    return null;
  }
  const own = placeFile(stateDir, s.scanId);
  const had = existsSync(own) && read(own);
  if (!had) {
    mkdirSync(join(stateDir, PLACES_DIR), { recursive: true });
    write(own, s);
  }
  remove(legacy);
  return had ? null : s;
}

/** Every saved place on this station, the scan that stopped first comes first. Picks up the old single file on the way. */
export function loadPlaces(stateDir) {
  adoptLegacyPlace(stateDir);
  let names = [];
  try {
    names = readdirSync(join(stateDir, PLACES_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const at = (s) => String(s.stopped?.at ?? s.savedAt ?? "");
  return names
    .map((n) => read(join(stateDir, PLACES_DIR, n)))
    .filter(Boolean)
    .sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : a.scanId < b.scanId ? -1 : 1));
}
