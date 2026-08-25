import type { DocumentAudience, JiraIssue } from "./types";
import { buildPrettyUserManual } from "./um-builder";

export function generateUserManualTemplate(
  title: string,
  issues: JiraIssue[],
  audience: DocumentAudience = "external"
): string {
  return buildPrettyUserManual(title, issues, audience);
}

export function generateReleaseNotesTemplate(
  releaseName: string,
  issues: JiraIssue[]
): string {
  const features = issues.filter((i) => /story|feature|epic/i.test(i.issueType));
  const fixes = issues.filter((i) => /bug/i.test(i.issueType));
  const other = issues.filter((i) => !features.includes(i) && !fixes.includes(i));

  const line = (i: JiraIssue) => `- **${i.key}:** ${i.summary}`;

  return `# ${releaseName}

> **Draft (no AI)** — Assembled from Jira. Edit before sending to customers.

## Highlights

- Release includes ${issues.length} completed item(s).

## New Features

${features.length ? features.map(line).join("\n") : "_None labeled as features._"}

## Improvements

${other.length ? other.map(line).join("\n") : "_None._"}

## Bug Fixes

${fixes.length ? fixes.map(line).join("\n") : "_None labeled as bugs._"}
`;
}
