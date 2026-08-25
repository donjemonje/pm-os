import { GOOGLE_DOC_MIME, GOOGLE_SLIDES_MIME } from "./google-drive-oauth-config";

const DRIVE_EXPORT = "https://www.googleapis.com/drive/v3/files";
const DOCS_API = "https://docs.googleapis.com/v1/documents";

/** Export Google Docs/Slides as plain text via Drive export API. */
export async function exportDriveFileAsText(
  accessToken: string,
  fileId: string,
  mimeType: string
): Promise<string> {
  if (mimeType === GOOGLE_DOC_MIME) {
    const structured = await fetchDocStructuredText(accessToken, fileId);
    if (structured.trim()) return structured;
  }

  const exportMime =
    mimeType === GOOGLE_SLIDES_MIME ? "text/plain" : "text/plain";

  const response = await fetch(
    `${DRIVE_EXPORT}/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Drive export failed: ${await response.text()}`);
  }

  return response.text();
}

type DocsElement = {
  paragraph?: {
    elements?: Array<{ textRun?: { content?: string } }>;
  };
  table?: unknown;
  sectionBreak?: unknown;
};

async function fetchDocStructuredText(accessToken: string, fileId: string): Promise<string> {
  const response = await fetch(`${DOCS_API}/${fileId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return "";

  const doc = (await response.json()) as {
    title?: string;
    body?: { content?: DocsElement[] };
  };

  const lines: string[] = [];
  if (doc.title) lines.push(`# ${doc.title}`, "");

  for (const element of doc.body?.content ?? []) {
    const paragraph = element.paragraph;
    if (!paragraph?.elements) continue;

    const text = paragraph.elements
      .map((el) => el.textRun?.content ?? "")
      .join("")
      .replace(/\n$/, "");

    if (text.trim()) lines.push(text);
  }

  return lines.join("\n\n");
}
