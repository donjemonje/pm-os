import type { JiraIssue, JiraIssueImage } from "./types";

type AdfNode = Record<string, unknown>;

/** Extract image attachment IDs referenced in Jira ADF description */
export function extractAttachmentIdsFromAdf(node: unknown): string[] {
  const ids = new Set<string>();
  walkAdf(node, ids);
  return Array.from(ids);
}

function walkAdf(node: unknown, ids: Set<string>) {
  if (!node || typeof node !== "object") return;
  const n = node as AdfNode;

  if (n.type === "media" || n.type === "mediaSingle" || n.type === "mediaGroup") {
    const attrs = n.attrs as { id?: string; collection?: string } | undefined;
    if (attrs?.id) ids.add(String(attrs.id));
  }

  if (Array.isArray(n.content)) {
    for (const child of n.content) walkAdf(child, ids);
  }
}

export function buildIssueImages(
  issueKey: string,
  attachments: Array<{ id: string; filename: string; mimeType: string }>,
  adfIds: string[]
): JiraIssueImage[] {
  const imageAttachments = attachments.filter((a) =>
    (a.mimeType ?? "").startsWith("image/")
  );

  const byId = new Map(imageAttachments.map((a) => [a.id, a]));
  const ordered: typeof imageAttachments = [];

  for (const id of adfIds) {
    const att = byId.get(id);
    if (att) {
      ordered.push(att);
      byId.delete(id);
    }
  }
  for (const att of byId.values()) {
    ordered.push(att);
  }

  return ordered.slice(0, 8).map((att) => ({
    attachmentId: att.id,
    filename: att.filename,
    mimeType: att.mimeType,
    proxyUrl: `/api/jira/attachments/${att.id}`,
    alt: att.filename?.replace(/\.[^.]+$/, "") || `${issueKey} screenshot`,
  }));
}

export function formatImagesForPrompt(images: JiraIssueImage[]): string {
  if (images.length === 0) return "";
  return images
    .map(
      (img, i) =>
        `  Image ${i + 1}: embed as ![${img.alt}](${img.proxyUrl}) after the step it illustrates (${img.filename})`
    )
    .join("\n");
}
