import type { CatalogKind, Idea } from "./types";

// Idea construction happens server-side in lib/ideas/store.ts — the helpers
// here are pure client-side presentation logic.

/**
 * Scoring is parked until the scoring milestone: nothing computes pmScore
 * yet, so the column, its popover, the drawer's score row and the manual
 * override stay hidden and lists order by votes. Flip to true to bring them
 * back — the data model and API never dropped the fields.
 */
export const SCORING_ENABLED = false;

export function scoreOf(i: Idea): { value: number | null; src: string } {
  if (i.manual != null)
    return { value: i.manual, src: "Manual score · overrides PM-OS score" };
  if (i.pmScore != null)
    return { value: i.pmScore, src: "PM-OS score · computed this import" };
  return { value: null, src: "Not scored" };
}

/**
 * List order: by score when scoring is on (unscored last); otherwise by
 * evidence — votes gained this import first, then total votes.
 */
export function compareIdeas(a: Idea, b: Idea): number {
  if (SCORING_ENABLED) {
    const av = scoreOf(a).value;
    const bv = scoreOf(b).value;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  }
  if (b.newVotes !== a.newVotes) return b.newVotes - a.newVotes;
  return (
    b.existingVotes + b.newVotes - (a.existingVotes + a.newVotes)
  );
}

export function votesLabel(i: Idea): string | null {
  if (i.existingVotes === 0 && i.newVotes === 0) return null;
  if (i.existingVotes > 0 && i.newVotes > 0)
    return `${i.existingVotes} (+${i.newVotes})`;
  if (i.newVotes > 0) return `+${i.newVotes}`;
  return String(i.existingVotes);
}

export interface BadgeStyle {
  label: string;
  bg: string;
  fg: string;
  bd: string;
  check: boolean;
}

/**
 * Status colors (Direction B): solid pills — green New, blue Updated, pink
 * Archive; "In Jira" stays outlined so it reads as done, not as a batch
 * state. Deleted is only ever seen on the Merge page.
 */
export function badgeOf(i: Idea): BadgeStyle | null {
  if (i.decision === "injected")
    return {
      label: "In Jira",
      bg: "#ffffff",
      fg: "#2a5fd0",
      bd: "rgba(59,124,246,.55)",
      check: true,
    };
  switch (i.batch) {
    case "new":
      return { label: "New", bg: "#17b26a", fg: "#ffffff", bd: "transparent", check: false };
    case "updated":
      return { label: "Updated", bg: "#3b7cf6", fg: "#ffffff", bd: "transparent", check: false };
    case "deleted":
      return { label: "Deleted", bg: "#f7eef1", fg: "#a3556b", bd: "#ecd6dd", check: false };
    case "archive":
      return { label: "Archive", bg: "#ef5a8a", fg: "#ffffff", bd: "transparent", check: false };
    default:
      return null;
  }
}

/** Soft tint + ink of each batch status, for stat cards and accents. */
export const STATUS_TONES: Record<"new" | "updated" | "archive", { solid: string; soft: string; fg: string }> = {
  new: { solid: "#17b26a", soft: "rgba(23,178,106,.14)", fg: "#0f7a47" },
  updated: { solid: "#3b7cf6", soft: "rgba(59,124,246,.15)", fg: "#2a5fd0" },
  archive: { solid: "#ef5a8a", soft: "rgba(239,90,138,.15)", fg: "#c23767" },
};

/** PRD: unchanged and deleted ideas never need approval. */
export function needsApproval(i: Idea): boolean {
  return i.batch !== "deleted" && i.batch !== "unchanged";
}

/** Filter-chip label -> Idea.batch value (shared by the Final and Merge views). */
export const STATUS_CHIP_TO_BATCH: Record<string, Idea["batch"]> = {
  New: "new",
  Updated: "updated",
  Archive: "archive",
  Unchanged: "unchanged",
};

/** Display labels for catalog kinds — one place, used by every chip and drawer line. */
export const CATALOG_KIND_LABELS: Record<CatalogKind, string> = {
  fr: "Feature request",
  bug: "Bug",
  needs_details: "Needs details",
  ops_task: "Ops task",
  question: "Product Question",
};
