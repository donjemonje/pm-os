/**
 * Runs once per server start. An Ideas import that was running when the
 * previous process died can never finish — mark it aborted with the stage
 * it was last alive in, so the batch history tells the truth.
 *
 * A competitor analysis run that was running when the previous process died
 * continues: its queue is looked at now and, where the runs execute in this
 * process (the inline runner of local dev), once a minute — a run whose runner
 * stopped reporting is put back and the head of the queue is started.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { markAbandonedImports } = await import("./lib/ideas/trace");
  try {
    await markAbandonedImports("server started");
  } catch (err) {
    console.error(
      `[ideas:import] could not check for abandoned imports at boot: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const { kickAnalyses } = await import("./lib/competitors/analysis/engine");
    const { runnerMode } = await import("./lib/competitors/run");
    await kickAnalyses();
    const g = globalThis as unknown as { __pmosAnalysisKick?: ReturnType<typeof setInterval> };
    if (runnerMode() === "inline" && !g.__pmosAnalysisKick) {
      g.__pmosAnalysisKick = setInterval(() => void kickAnalyses(), 60_000);
      g.__pmosAnalysisKick.unref?.();
    }
  } catch (err) {
    console.error(`[competitors] could not look at the analysis queue at boot: ${err instanceof Error ? err.message : String(err)}`);
  }
}
