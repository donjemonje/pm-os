import type { Idea } from "./types";

// Idea construction happens server-side in lib/ideas/store.ts — the helpers
// here are pure client-side presentation logic.

export function scoreOf(i: Idea): { value: number | null; src: string } {
  if (i.manual != null) return { value: i.manual, src: "Manual score · overrides PM-OS score" };
  if (i.pmScore != null) return { value: i.pmScore, src: "PM-OS score · computed this import" };
  return { value: null, src: "No score yet — scoring runs in a later milestone" };
}

export function votesLabel(i: Idea): string | null {
  if (i.existingVotes === 0 && i.newVotes === 0) return null;
  if (i.existingVotes > 0 && i.newVotes > 0) return `${i.existingVotes} (+${i.newVotes})`;
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

export function badgeOf(i: Idea): BadgeStyle | null {
  if (i.decision === "injected")
    return { label: "In Jira", bg: "transparent", fg: "#3b6fd4", bd: "#c8d9ec", check: true };
  switch (i.batch) {
    case "new":
      return { label: "New", bg: "#e9f7ef", fg: "#1f8a53", bd: "#c4e8d2", check: false };
    case "updated":
      return { label: "Updated", bg: "rgba(122,167,255,.14)", fg: "#3b6fd4", bd: "rgba(122,167,255,.4)", check: false };
    case "deleted":
      return { label: "Deleted", bg: "#f7eef1", fg: "#a3556b", bd: "#ecd6dd", check: false };
    case "archive":
      return { label: "Archive", bg: "#fdeef2", fg: "#c94266", bd: "#f3c9d5", check: false };
    default:
      return null;
  }
}

/** PRD: unchanged and deleted ideas never need approval. */
export function needsApproval(i: Idea): boolean {
  return i.batch !== "deleted" && i.batch !== "unchanged";
}
