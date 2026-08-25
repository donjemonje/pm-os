import type { DocumentAudience, GoogleDriveFileContent, JiraIssue, JiraIssueImage } from "./types";
import { formatImagesForPrompt } from "./jira-attachments";

const AUDIENCE_LABEL: Record<DocumentAudience, string> = {
  external: "Customer-facing",
  internal: "Internal staff",
  configuration: "Operations / configuration",
};

function groupIssues(issues: JiraIssue[]): Map<string, JiraIssue[]> {
  const groups = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const label = issue.epicSummary ?? issue.epicKey ?? issue.components[0] ?? "Features";
    const list = groups.get(label) ?? [];
    list.push(issue);
    groups.set(label, list);
  }
  return groups;
}

function renderImageGallery(images: JiraIssueImage[], issueKey: string): string {
  if (images.length === 0) {
    return `\n*[Screenshot needed — attach images to ${issueKey} in Jira]*\n\n`;
  }

  let block = "\n";
  for (const img of images) {
    block += `![${img.alt}](${img.proxyUrl})\n\n`;
    block += `*Figure: ${img.alt} · ${issueKey}*\n\n`;
  }
  return block;
}

function renderIssueSection(issue: JiraIssue): string {
  let section = `### ${issue.summary}\n\n`;
  section += `\`${issue.key}\` · ${issue.issueType} · ${issue.status}\n\n`;

  if (issue.components.length) {
    section += `**Area:** ${issue.components.join(", ")}\n\n`;
  }

  if (issue.description?.trim()) {
    section += `#### What it does\n\n${issue.description.trim()}\n\n`;
  }

  if (issue.acceptanceCriteria?.trim()) {
    section += `#### How to use it\n\n`;
    const lines = issue.acceptanceCriteria
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 1) {
      section += lines.map((l, i) => `${i + 1}. ${l.replace(/^\d+\.\s*/, "")}`).join("\n") + "\n\n";
    } else {
      section += `${issue.acceptanceCriteria.trim()}\n\n`;
    }
  }

  section += renderImageGallery(issue.images ?? [], issue.key);
  return section;
}

function renderDrivePrdSection(file: GoogleDriveFileContent): string {
  const label = file.kind === "presentation" ? "Google Slides" : "Google Doc";
  const body = file.text.trim() || "*No extractable text in this file.*";
  return `### ${file.name}\n\n*Source: ${label} · Drive*\n\n${body}\n\n`;
}

/** Build a styled user manual with Jira images embedded per story */
export function buildPrettyUserManual(
  title: string,
  issues: JiraIssue[],
  audience: DocumentAudience = "external",
  driveFiles: GoogleDriveFileContent[] = []
): string {
  const grouped = groupIssues(issues);
  const keys = issues.map((i) => i.key).join(", ");
  const imageCount = issues.reduce((n, i) => n + (i.images?.length ?? 0), 0);

  let md = `# ${title}

*Product documentation · PM-OS*

> **Audience:** ${AUDIENCE_LABEL[audience]}  
> **Source tickets:** ${keys}  
> **Screenshots from Jira:** ${imageCount} image${imageCount === 1 ? "" : "s"} embedded

---

## Overview

This guide walks through the features delivered in the selected release. Each section maps to Jira work items; screenshots are pulled from story attachments when available.

## Prerequisites

- Access to the product environment covered by: ${keys || "the features in this guide"}
- Review internal-only sections before sharing externally

`;

  if (driveFiles.length > 0) {
    md += `## PRD & product specs (Google Drive)\n\n`;
    md += `The following product requirements were imported from Google Docs/Slides and inform this manual.\n\n`;
    for (const file of driveFiles) {
      md += renderDrivePrdSection(file);
    }
    md += `---\n\n`;
  }

  if (issues.length > 0) {
    md += `## Implementation (from Jira)\n\n`;
  }

  for (const [groupName, groupIssues] of grouped) {
    md += `## ${groupName}\n\n`;
    for (const issue of groupIssues) {
      md += renderIssueSection(issue);
    }
    md += "\n---\n\n";
  }

  md += `> **Before publishing:** Verify screenshots are current, redact internal URLs, and confirm audience-appropriate language.\n`;

  return md;
}

/** After AI generation, inject real images where placeholders remain */
export function injectJiraImagesIntoMarkdown(
  markdown: string,
  issues: JiraIssue[]
): string {
  let result = markdown;

  for (const issue of issues) {
    const images = issue.images ?? [];
    if (images.length === 0) continue;

    const gallery = renderImageGallery(images, issue.key).trim();
    const placeholders = [
      new RegExp(`\\[Screenshot needed[^\\]]*${issue.key}[^\\]]*\\]`, "gi"),
      /\*\[Screenshot needed[^\]]*\]\*/gi,
    ];

    let replaced = false;
    for (const pattern of placeholders) {
      if (result.includes(issue.key) && pattern.test(result)) {
        result = result.replace(pattern, gallery);
        replaced = true;
        break;
      }
    }

    if (!replaced && result.includes(issue.key) && !result.includes(images[0].proxyUrl)) {
      const heading = `### ${issue.summary}`.slice(0, 50);
      if (result.includes(heading) || result.includes(issue.key)) {
        const keyIndex = result.indexOf(issue.key);
        if (keyIndex > -1) {
          const nextH3 = result.indexOf("\n### ", keyIndex + 1);
          const insertAt = nextH3 > -1 ? nextH3 : result.length;
          if (!result.slice(keyIndex, insertAt).includes(images[0].proxyUrl)) {
            result = result.slice(0, insertAt) + `\n\n${gallery}\n\n` + result.slice(insertAt);
          }
        }
      }
    }
  }

  return result;
}

export function buildUserManualAiContext(
  title: string,
  issues: JiraIssue[],
  audience: DocumentAudience,
  driveFiles: GoogleDriveFileContent[] = []
): string {
  const issueBlocks = issues.map((issue) => {
    const imgHint = formatImagesForPrompt(issue.images ?? []);
    return `[${issue.key}] ${issue.summary}
Type: ${issue.issueType} | Status: ${issue.status}
Description: ${(issue.description || "").slice(0, 600)}
AC: ${(issue.acceptanceCriteria || "N/A").slice(0, 400)}
${imgHint}`;
  });

  const driveBlocks = driveFiles.map((file) => {
    const label = file.kind === "presentation" ? "Google Slides" : "Google Doc";
    return `[Drive: ${file.name}] (${label})
${file.text.slice(0, 5000)}`;
  });

  const sourceSections = [
    driveFiles.length
      ? `Google Drive PRDs (Docs/Slides):\n${driveBlocks.join("\n\n---\n\n")}`
      : "",
    issues.length ? `Jira tickets:\n${issueBlocks.join("\n\n---\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `Write a polished user manual in Markdown titled: "${title}".
Audience: ${AUDIENCE_LABEL[audience]}

RULES:
- Use the PRD/spec content from Google Drive AND Jira tickets below
- When image URLs are provided, embed ![alt](url) immediately after the relevant step
- Use: Overview, Prerequisites, PRD summary (from Drive), feature sections with ### per feature
- Do NOT invent issue keys or file names
- Numbered steps for procedures

Sources:
${sourceSections || "No sources provided."}`;
}
