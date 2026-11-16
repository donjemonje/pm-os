/**
 * What is due (Capability Analysis, "How the analysis runs"). An analysis run keeps no cursor: every step works on
 * a to-do list computed from the tables, so a run that stopped continues with exactly what is left.
 *
 * Pure: no database, no network.
 */

/** "<version>:<hash>" — what SourcePage.analyzedKey holds: the prompt version and the text that was read. A page whose key is not the key of its current text is due (analysis/read-step.ts planChunks). */
export function readKey(version: string, hash: string): string {
  return `${version}:${hash}`;
}

/**
 * The rows of ours made from a competitor's items that the other competitors were not yet asked about: those made
 * after the competitor's last finished run (`since` = that run's appliedAt; null = it never finished one, so all of
 * them). Read from the tables at the end of every apply step — nothing is remembered in the process, so a run that
 * crashed or failed after making a row still gets its follow-up runs.
 */
export function rowsSince<T extends { createdAt: Date }>(rows: T[], since: Date | null): T[] {
  return since ? rows.filter((r) => r.createdAt.getTime() > since.getTime()) : rows;
}
