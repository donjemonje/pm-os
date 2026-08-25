import type { AggregationResult, JiraIssue, TicketGroup } from "./types";

function groupByEpic(issues: JiraIssue[]): TicketGroup[] {
  const epicMap = new Map<string, JiraIssue[]>();
  const ungrouped: JiraIssue[] = [];

  for (const issue of issues) {
    if (issue.epicKey) {
      const list = epicMap.get(issue.epicKey) ?? [];
      list.push(issue);
      epicMap.set(issue.epicKey, list);
    } else {
      ungrouped.push(issue);
    }
  }

  const groups: TicketGroup[] = [];

  for (const [epicKey, epicIssues] of epicMap) {
    const epicSummary = epicIssues[0]?.epicSummary ?? epicKey;
    groups.push({
      id: `epic-${epicKey}`,
      label: epicSummary,
      reason: "Same epic",
      issueKeys: epicIssues.map((i) => i.key),
    });
  }

  if (ungrouped.length > 0) {
    const byComponent = new Map<string, JiraIssue[]>();
    for (const issue of ungrouped) {
      const comp = issue.components[0] ?? "Other";
      const list = byComponent.get(comp) ?? [];
      list.push(issue);
      byComponent.set(comp, list);
    }

    for (const [comp, compIssues] of byComponent) {
      groups.push({
        id: `component-${comp}`,
        label: comp,
        reason: "Same component",
        issueKeys: compIssues.map((i) => i.key),
      });
    }
  }

  return groups;
}

function groupBySimilarTitle(issues: JiraIssue[]): TicketGroup[] {
  const prefixMap = new Map<string, JiraIssue[]>();

  for (const issue of issues) {
    const words = issue.summary.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
    const prefix = words.length >= 6 ? words : issue.issueType;
    const list = prefixMap.get(prefix) ?? [];
    list.push(issue);
    prefixMap.set(prefix, list);
  }

  return Array.from(prefixMap.entries())
    .filter(([, list]) => list.length > 1)
    .map(([prefix, list]) => ({
      id: `title-${prefix.replace(/\s+/g, "-")}`,
      label: list[0].summary.slice(0, 60),
      reason: "Similar title / theme",
      issueKeys: list.map((i) => i.key),
    }));
}

export function heuristicAggregate(issues: JiraIssue[]): AggregationResult {
  const epicGroups = groupByEpic(issues);
  const hasEpicGroups = epicGroups.some((g) => g.id.startsWith("epic-"));

  let groups = hasEpicGroups ? epicGroups : groupBySimilarTitle(issues);

  if (groups.length === 0 && issues.length > 0) {
    groups = [
      {
        id: "all",
        label: "All tickets in scope",
        reason: "Single scope selection",
        issueKeys: issues.map((i) => i.key),
      },
    ];
  }

  const suggestedKeys = Array.from(new Set(groups.flatMap((g) => g.issueKeys)));

  return { issues, groups, suggestedKeys };
}

export async function aggregateTickets(issues: JiraIssue[]): Promise<AggregationResult> {
  if (issues.length === 0) {
    return { issues: [], groups: [], suggestedKeys: [] };
  }

  // Use fast heuristic grouping (epic → component → title) to avoid burning
  // rate-limited AI calls during the explore/filter step. AI is reserved for
  // the actual content generation when the user clicks "Generate".
  return heuristicAggregate(issues);
}
