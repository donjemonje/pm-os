/**
 * Runs once per server start. An Ideas import that was running when the
 * previous process died can never finish — mark it aborted with the stage
 * it was last alive in, so the batch history tells the truth.
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
}
