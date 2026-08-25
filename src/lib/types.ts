export type DocumentType = "RN" | "UM";
export type DocumentAudience = "external" | "internal" | "configuration";
export type DocumentStatus = "draft" | "review" | "published";
export type ReleaseStatus = "draft" | "published";

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraVersion {
  id: string;
  name: string;
  released: boolean;
  releaseDate?: string;
}

export interface JiraIssueImage {
  attachmentId: string;
  filename: string;
  mimeType: string;
  /** Proxied through PM-OS so Jira auth is applied */
  proxyUrl: string;
  alt: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  labels: string[];
  components: string[];
  acceptanceCriteria?: string;
  parentKey?: string;
  epicKey?: string;
  epicSummary?: string;
  images?: JiraIssueImage[];
}

export interface TicketGroup {
  id: string;
  label: string;
  reason: string;
  issueKeys: string[];
}

export interface AggregationResult {
  issues: JiraIssue[];
  groups: TicketGroup[];
  suggestedKeys: string[];
}

export interface ChatContext extends Record<string, unknown> {
  releaseId?: string;
  documentId?: string;
  issueKeys?: string[];
  projectKey?: string;
}

export interface Citation {
  source?: "jira" | "drive";
  issueKey?: string;
  driveFileId?: string;
  driveFileName?: string;
  snippet: string;
  field?: string;
}

export interface ChatEmbed {
  type: "document" | "issue";
  id: string;
  title: string;
  preview?: string;
}

export interface ChatMessageMetadata {
  citations?: Citation[];
  embed?: ChatEmbed;
  confidence?: "high" | "medium" | "low";
}

export type GoogleDriveFileKind = "document" | "presentation" | "other";

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  kind: GoogleDriveFileKind;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface GoogleDriveFileContent {
  id: string;
  name: string;
  kind: GoogleDriveFileKind;
  text: string;
  webViewLink?: string;
}

export interface GoogleDriveFolderOption {
  id: string;
  name: string;
  path: string;
  depth: number;
}

export type GoogleDriveBrowseItemType = "folder" | "file" | "shared_drive" | "my_drive";

export interface GoogleDriveBrowseItem {
  id: string;
  name: string;
  type: GoogleDriveBrowseItemType;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface GoogleDriveBrowseResult {
  parentId: string;
  folders: GoogleDriveBrowseItem[];
  files: GoogleDriveBrowseItem[];
}
