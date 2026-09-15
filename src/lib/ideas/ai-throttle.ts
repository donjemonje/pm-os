/**
 * One switch for every AI-call restriction that exists only out of
 * quota/token caution (never for pipeline logic): IDEAS_AI_THROTTLE.
 * OFF (default): no restrictions — independent calls all run at once.
 * ON ("on"/"true"/"1"): bounded pools apply (IDEAS_CATALOG_CONCURRENCY etc.).
 * Stages that are serial for LOGIC reasons (match's growing candidate list)
 * ignore this switch entirely.
 */
export function aiThrottleOn(): boolean {
  const raw = process.env.IDEAS_AI_THROTTLE?.trim().toLowerCase();
  return raw === "on" || raw === "true" || raw === "1";
}
